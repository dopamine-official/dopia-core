"""Compaction module (6-1-2): one non-streaming call that returns the updated summary."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

from chat_ai.chat.inputs import CompactInput
from chat_ai.llm.client import LlmClient
from chat_ai.llm.types import EMPTY_RESPONSE, TIMEOUT, LlmError
from chat_ai.observe.tracer import Trace
from chat_ai.prompt.assembler import PromptAssembler

log = logging.getLogger("chat_ai.chat")


@dataclass(frozen=True)
class CompactFailure(Exception):
    code: str
    message: str


async def compact(
    request: CompactInput,
    *,
    assembler: PromptAssembler,
    llm: LlmClient,
    trace: Trace,
    request_timeout_seconds: float,
) -> dict[str, Any]:
    """Returns the 200 body. Raises CompactFailure for 502 cases; other exceptions are internal."""
    received_at = time.monotonic()
    try:
        prompt = assembler.compact(summary=request.summary, history=request.history, locale=request.locale)
        trace.prompt_assembled(prompt, history_count=len(request.history), summary_length=len(request.summary))
        try:
            async with asyncio.timeout(request_timeout_seconds):
                result = await llm.complete("compact", prompt, trace)
        except TimeoutError as exc:
            raise CompactFailure(TIMEOUT, "compact request exceeded its time limit") from exc
        except LlmError as error:
            raise CompactFailure(error.code, error.message) from error
        summary = result.text.strip()
        if not summary:
            raise CompactFailure(EMPTY_RESPONSE, "summary model returned empty text")
        body = {
            "summary": summary,
            "meta": {
                "model": result.model,
                "provider": result.provider,
                "prompt_version": prompt.prompt_version,
                "input_token_count": result.usage.input_tokens,
                "output_token_count": result.usage.output_tokens,
                "finish_reason": result.finish_reason,
                "generation_ms": int((time.monotonic() - received_at) * 1000),
            },
        }
    except asyncio.CancelledError:
        trace.finish(outcome="cancelled", output=None, error_code=None)
        log.info("request_id=%s subtask=compact outcome=cancelled", request.request_id)
        raise
    except CompactFailure as failure:
        trace.finish(
            outcome="failed", output={"code": failure.code, "message": failure.message}, error_code=failure.code
        )
        log.info("request_id=%s subtask=compact outcome=failed code=%s", request.request_id, failure.code)
        raise
    trace.finish(outcome="completed", output=summary, error_code=None)
    log.info(
        "request_id=%s subtask=compact outcome=completed ms=%d",
        request.request_id,
        int((time.monotonic() - received_at) * 1000),
    )
    return body
