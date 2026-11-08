"""Response generation module (6-1-1). Yields contract events; the router turns them into SSE."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from chat_ai.chat.inputs import ChatTurnInput
from chat_ai.llm.client import LlmClient, iterate_within
from chat_ai.llm.types import EMPTY_RESPONSE, INTERNAL_ERROR, TIMEOUT, Done, LlmError, TextChunk
from chat_ai.observe.errors import ErrorReporter
from chat_ai.observe.tracer import Trace
from chat_ai.prompt.assembler import AssembledPrompt, PromptAssembler

log = logging.getLogger("chat_ai.chat")


@dataclass(frozen=True)
class Event:
    name: str  # token | completed | failed
    data: dict[str, Any]


def _failed(code: str, message: str) -> Event:
    return Event("failed", {"code": code, "message": message})


def assemble_chat_prompt(assembler: PromptAssembler, turn: ChatTurnInput, trace: Trace) -> AssembledPrompt:
    prompt = assembler.chat(
        character=turn.character,
        history=turn.history,
        summary=turn.summary,
        user_input=turn.user_input,
        locale=turn.locale,
        adult_mode=turn.adult_mode,
    )
    trace.prompt_assembled(prompt, history_count=len(turn.history), summary_length=len(turn.summary))
    return prompt


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
    """Streams token events and ends with exactly one completed or failed event.

    `received_at` is time.monotonic() when the request arrived; ttft is measured from it.
    A client disconnect arrives as CancelledError, or as GeneratorExit when the response closes
    this generator while it waits at a yield. Either way it is recorded as cancelled and re-raised.
    """
    pieces: list[str] = []
    first_token_at: float | None = None
    last_token_at: float | None = None
    done: Done | None = None
    final: Event
    try:
        # aclosing: when we stop early the provider stream is closed now, not whenever GC gets to it,
        # so the generation record is settled before the trace is.
        source = iterate_within(llm.stream(turn.route_name, prompt, trace), request_timeout_seconds)
        async with aclosing(source) as events:
            async for event in events:
                if isinstance(event, TextChunk):
                    now = time.monotonic()
                    if first_token_at is None:
                        first_token_at = now
                    last_token_at = now
                    pieces.append(event.text)
                    yield Event("token", {"text": event.text})
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
        errors.report(exc, request_id=turn.request_id, subtask="chat")
        log.exception("request_id=%s subtask=chat internal error", turn.request_id)
        final = _failed(INTERNAL_ERROR, "internal error")

    outcome = "completed" if final.name == "completed" else "failed"
    code = None if outcome == "completed" else final.data["code"]
    trace.finish(outcome=outcome, output=final.data if outcome == "failed" else final.data["output"], error_code=code)
    log.info(
        "request_id=%s subtask=chat outcome=%s code=%s ms=%d",
        turn.request_id,
        outcome,
        code,
        int((time.monotonic() - received_at) * 1000),
    )
    yield final
