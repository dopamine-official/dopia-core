"""Response generation module (6-1-1). Yields contract events; the router turns them into SSE."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from chat_ai.chat.inputs import ChatTurnInput
from chat_ai.llm.client import LlmClient, iterate_within
from chat_ai.llm.types import (
    EMPTY_RESPONSE,
    INTERNAL_ERROR,
    PROVIDER_REJECTED,
    TIMEOUT,
    Done,
    LlmError,
    StreamEvent,
    TextChunk,
)
from chat_ai.observe.errors import ErrorReporter
from chat_ai.observe.tracer import Trace
from chat_ai.prompt.assembler import AssembledPrompt, PromptAssembler

log = logging.getLogger("chat_ai.chat")
# Same tolerance as the web parser: case and spaces inside the tags do not matter.
STATUS_WINDOW_RE = re.compile(r"<\s*status\s*>.*?<\s*/\s*status\s*>", re.IGNORECASE | re.DOTALL)
# A name never holds a brace or a line break, so a tag left open cannot swallow the next one.
# Same tolerance as the backend and the web: one colon, spaces and case do not matter.
IMAGE_TAG_RE = re.compile(r"\{\{\s*img\s*::?\s*([^{}\n]*?)\s*\}\}", re.IGNORECASE)

# A refused reply is asked for again from the same model, this many times at most.
REFUSAL_RETRIES = 2
# How much of a reply is held back, before anything is sent on, to tell whether it is a refusal.
REFUSAL_HEAD_CHARS = 80
_CANNOT = r"(?:cannot|can['’]?t|can not|won['’]t|will not|(?:am|['’]m) (?:unable|not able) to)"
_ACT = (
    r"(?:fulfil|help|assist|continue|comply|create|generate|write|engage|participate|provide|produce|proceed"
    r"|role-?play|depict|describe|take part|complete|process|accommodate)"
)
_DOING = rf"(?:with|continuing|writing|generating|engaging|participating|{_ACT})"
_TOPIC = r"(?:request|content|scene|scenario|role-?play|prompt)"
_SORRY = r"(?:i['’]?m (?:really |so |very )?sorry|i am (?:really |so |very )?sorry|sorry|i apologi[sz]e|my apologies)"
_KO_SORRY = (
    r"(?:죄송하지만|죄송합니다만|죄송합니다|죄송해요|죄송한데|미안하지만|미안합니다만"
    r"|안타깝지만|유감이지만|유감스럽지만)"
)
_KO_ACT = (
    r"(?:도와\s?드릴|도울|작성할|계속할|진행할|응할|응해\s?드릴|제공할|생성할|수행할|이어갈|참여할"
    r"|답변\s?드릴|답변할|들어\s?드릴|묘사할|다룰|만들|지원할|따를)"
)
# The same, declined in the "it is hard to" form.
_KO_HARD = (
    r"(?:도와\s?드리기|돕기|작성하기|계속하기|진행하기|응하기|제공하기|생성하기|답변\s?드리기|답변하기|묘사하기|다루기)"
)
_KO_DECLINE = (
    rf"(?:{_KO_ACT}\s*수\s?(?:가 )?없|{_KO_HARD}(?:는|가)? 어렵|(?:정책|가이드라인|지침)\S* (?:위배|위반|어긋))"
)
_KO_TOPIC = r"(?:요청|내용|대화|장면|콘텐츠|묘사|역할극|롤플레이)"
# The model stepping out of the story to decline, in the words models use for it. Matched only at
# the very start of a reply: a character's line opens with a quotation mark or an action, so a
# character who says "I can't help you" inside the story is not taken for a refusal.
REFUSAL_RE = re.compile(
    "|".join(
        (
            # English
            rf"(?:{_SORRY}|unfortunately)[,.!]?\s+(?:but\s+)?i\s*{_CANNOT}",
            rf"i\s*{_CANNOT}\s+{_ACT}",
            rf"i\s*{_CANNOT},? and (?:i )?(?:will not|won['’]t)",
            rf"i(?:['’]m| am) afraid (?:that )?i\s*{_CANNOT}",
            r"i (?:must|have to|need to) (?:respectfully )?(?:decline|refuse)",
            rf"i(?:['’]m| am) not comfortable {_DOING}",
            rf"i (?:do not|don['’]t) feel comfortable {_DOING}",
            rf"i(?:['’]d| would) (?:prefer|rather) not (?:to )?{_ACT}",
            rf"(?:this|that|your) {_TOPIC} (?:violates|goes against|is against)",
            r"as an ai\b",
            r"as a (?:large )?language model",
            r"i(?:['’]m| am) (?:just |only )?an ai\b",
            # Korean
            rf"{_KO_SORRY}[,.!]?\s*.{{0,50}}?{_KO_DECLINE}",
            rf"(?:이|해당|그|요청하신|말씀하신|이런|그런) {_KO_TOPIC}\S*\s.{{0,40}}?{_KO_DECLINE}",
            rf"저는 (?:이런|그런|해당) {_KO_TOPIC}",
            rf"(?:성적|선정적|노골적)\S* {_KO_TOPIC}\S*\s.{{0,30}}?{_KO_DECLINE}",
            r"저는 (?:ai|인공지능)",
            # Japanese
            r"(?:申し訳(?:ありません|ございません)|すみません|恐れ入ります)が?[、,。]?\s*.{0,40}?(?:できません|かねます|られません)",
            r"(?:その|この|ご)(?:ような)?(?:リクエスト|ご要望|内容|依頼)\S{0,10}?(?:お応え|対応|お答え)\S{0,6}?(?:できません|かねます)",
            # Chinese
            r"(?:很|非常|十分)?(?:抱歉|對不起|对不起|不好意思)[,，。]?\s*.{0,30}?(?:無法|无法|不能)",
            r"我(?:無法|无法|不能)(?:協助|协助|繼續|继续|提供|完成|滿足|满足|參與|参与|生成|撰寫|撰写|配合)",
        )
    ),
    re.IGNORECASE,
)


def is_refusal(reply: str) -> bool:
    """True when the reply opens with the model declining instead of answering in the story."""
    return REFUSAL_RE.match(reply.lstrip()) is not None


@dataclass(frozen=True)
class Event:
    name: str  # token | retrying | completed | failed
    data: dict[str, Any]


def _failed(code: str, message: str) -> Event:
    return Event("failed", {"code": code, "message": message})


def assemble_chat_prompt(assembler: PromptAssembler, turn: ChatTurnInput, trace: Trace) -> AssembledPrompt:
    prompt = assembler.chat(
        character=turn.character,
        prologue=turn.prologue,
        history=turn.history,
        summary=turn.summary,
        user_input=turn.user_input,
        locale=turn.locale,
        is_adult=turn.is_adult,
    )
    trace.prompt_assembled(prompt, history_count=len(turn.history), summary_length=len(turn.summary))
    return prompt


@dataclass(frozen=True)
class Retrying:
    """The model refused and is being asked again; nothing of the refused reply was passed on."""


async def reply_stream(
    route_name: str, prompt: AssembledPrompt, *, llm: LlmClient, trace: Trace, refusals: list[str]
) -> AsyncGenerator[StreamEvent | Retrying]:
    """The model's reply, asked for again when the model refuses.

    The start of each reply is held back until it is clear it is not a refusal, so a refused reply
    never reaches the user. A reply that opens with anything but a letter (an action, a quotation
    mark) is passed on at once. Each refusal adds its opening words to `refusals` and, when another
    try follows, yields Retrying. When the last try is refused as well, the refusal is raised as
    provider_rejected.
    """
    for attempt in range(REFUSAL_RETRIES + 1):
        held: list[TextChunk] | None = []  # None once the reply is being passed on
        try:
            async with aclosing(llm.stream(route_name, prompt, trace)) as events:
                async for event in events:
                    if held is None:
                        yield event
                        continue
                    if isinstance(event, TextChunk):
                        held.append(event)
                    head = "".join(chunk.text for chunk in held).lstrip()
                    undecided = not head or (head[0].isalnum() and len(head) < REFUSAL_HEAD_CHARS)
                    if isinstance(event, TextChunk) and undecided:
                        continue
                    if is_refusal(head):
                        refusal = LlmError(
                            PROVIDER_REJECTED,
                            "model refused in its reply",
                            provider_detail=f"refusal: {head[:200]}",
                            stop_reason="refusal",
                        )
                        if isinstance(event, TextChunk):
                            # Still generating: ending the call with the error records it as refused.
                            await events.athrow(refusal)
                        raise refusal
                    for chunk in held:
                        yield chunk
                    held = None
                    if isinstance(event, Done):
                        yield event
            return
        except LlmError as error:
            # Text already sent cannot be taken back, so only a reply still held is asked for again.
            if error.code != PROVIDER_REJECTED or held is None:
                raise
            refusals.append((error.provider_detail or error.message)[:200])
            if attempt == REFUSAL_RETRIES:
                raise
        yield Retrying()


async def generate_turn(
    turn: ChatTurnInput,
    prompt: AssembledPrompt,
    *,
    llm: LlmClient,
    trace: Trace,
    errors: ErrorReporter,
    request_timeout_seconds: float,
    received_at: float,
) -> AsyncIterator[Event]:
    """Streams token events and ends with exactly one completed or failed event. A retrying event
    comes before any token, each time the model refused and is asked again.

    `received_at` is time.monotonic() when the request arrived; ttft is measured from it.
    A client disconnect arrives as CancelledError, or as GeneratorExit when the response closes
    this generator while it waits at a yield. Either way it is recorded as cancelled and re-raised.
    """
    pieces: list[str] = []
    first_token_at: float | None = None
    last_token_at: float | None = None
    done: Done | None = None
    refusals: list[str] = []
    final: Event
    try:
        # aclosing: when we stop early the provider stream is closed now, not whenever GC gets to it,
        # so the generation record is settled before the trace is.
        reply = reply_stream(turn.route_name, prompt, llm=llm, trace=trace, refusals=refusals)
        source = iterate_within(reply, request_timeout_seconds)
        async with aclosing(source) as events:
            async for event in events:
                if isinstance(event, TextChunk):
                    now = time.monotonic()
                    if first_token_at is None:
                        first_token_at = now
                    last_token_at = now
                    pieces.append(event.text)
                    yield Event("token", {"text": event.text})
                elif isinstance(event, Retrying):
                    yield Event("retrying", {"reason": "refused"})
                else:
                    done = event
        output = "".join(pieces).strip()
        if done is None or not output:
            final = _failed(EMPTY_RESPONSE, "model returned empty text")
        else:
            now = time.monotonic()
            ttft = first_token_at if first_token_at is not None else now
            final = Event(
                "completed",
                {
                    "output": output,
                    "meta": {
                        "model": done.result.model,
                        "provider": done.result.provider,
                        "prompt_version": prompt.prompt_version,
                        "input_token_count": done.result.usage.input_tokens,
                        "output_token_count": done.result.usage.output_tokens,
                        "finish_reason": done.result.finish_reason,
                        "ttft_ms": int((ttft - received_at) * 1000),
                        "generation_ms": int(((last_token_at or ttft) - ttft) * 1000),
                    },
                },
            )
    except (asyncio.CancelledError, GeneratorExit):
        trace.finish(outcome="cancelled", output=None, error_code=None)
        log.info("request_id=%s subtask=chat outcome=cancelled", turn.request_id)
        raise
    except TimeoutError:
        final = _failed(TIMEOUT, "chat request exceeded its time limit")
    except LlmError as error:
        final = _failed(error.code, error.message)
    except Exception as exc:  # noqa: BLE001
        errors.report(exc, request_id=turn.request_id, account_id=turn.account_id, subtask="chat")
        log.exception("request_id=%s subtask=chat internal error", turn.request_id)
        final = _failed(INTERNAL_ERROR, "internal error")

    outcome = "completed" if final.name == "completed" else "failed"
    code = None if outcome == "completed" else final.data["code"]
    extra: dict[str, Any] = {}
    if refusals:
        # How often the model refused before this outcome; with a failure, every try was refused.
        extra["refusal_count"] = len(refusals)
    if outcome == "completed" and turn.has_status_window:
        # Recorded only, never repaired: a reply without the window is still a completed reply.
        extra["status_window_present"] = STATUS_WINDOW_RE.search(final.data["output"]) is not None
    if outcome == "completed" and turn.image_names:
        # Recorded only, never repaired: the web leaves out a tag whose name it does not know.
        names = [name.lower() for name in IMAGE_TAG_RE.findall(final.data["output"])]
        known = {name.lower() for name in turn.image_names}
        extra["image_tag_count"] = len(names)
        extra["image_tag_unknown_count"] = sum(name not in known for name in names)
    trace.finish(
        outcome=outcome,
        output=final.data if outcome == "failed" else final.data["output"],
        error_code=code,
        extra=extra,
    )
    log.info(
        "request_id=%s subtask=chat outcome=%s code=%s refusals=%d ms=%d",
        turn.request_id,
        outcome,
        code,
        len(refusals),
        int((time.monotonic() - received_at) * 1000),
    )
    yield final
