"""Anthropic adapter: the only place the Anthropic SDK is imported."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import anthropic

from chat_ai.llm.types import (
    PROVIDER_ERROR,
    PROVIDER_RATE_LIMITED,
    PROVIDER_REJECTED,
    PROVIDER_TIMEOUT,
    Done,
    LlmError,
    LlmRequest,
    LlmResult,
    LlmUsage,
    StreamEvent,
    TextChunk,
)


def classify(exc: BaseException) -> LlmError:
    """Maps SDK exceptions to contract codes in the order of 7-1-2."""
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, anthropic.APITimeoutError | TimeoutError):
        return LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=detail)
    if isinstance(exc, anthropic.RateLimitError):
        return LlmError(PROVIDER_RATE_LIMITED, "provider rate limit reached", provider_detail=detail)
    if isinstance(exc, anthropic.APIStatusError):
        return LlmError(PROVIDER_ERROR, f"provider returned HTTP {exc.status_code}", provider_detail=detail)
    if isinstance(exc, anthropic.APIConnectionError):
        return LlmError(PROVIDER_ERROR, "could not connect to provider", provider_detail=detail)
    return LlmError(PROVIDER_ERROR, "provider call failed", provider_detail=detail)


def rejected(stop_reason: str | None, stop_details: Any) -> LlmError | None:
    if stop_reason != "refusal":
        return None
    category = getattr(stop_details, "category", None)
    return LlmError(
        PROVIDER_REJECTED,
        "provider refused the request by content policy",
        provider_detail=f"refusal category={category}",
        stop_reason=stop_reason,
    )


def usage_of(usage: Any) -> LlmUsage:
    # input_tokens here leaves out the tokens read from the cache; they are reported separately.
    return LlmUsage(usage.input_tokens, usage.output_tokens, getattr(usage, "cache_read_input_tokens", None))


class AnthropicAdapter:
    name = "anthropic"

    def __init__(self, api_key: str, base_url: str | None = None) -> None:
        # No SDK retries: a failure goes straight back to the backend (6-1 5).
        self._client = anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url, max_retries=0)

    def _kwargs(self, request: LlmRequest) -> dict[str, Any]:
        return {
            "model": request.model,
            "max_tokens": request.max_output_tokens,
            "system": request.prompt.system,
            "messages": [{"role": m.role, "content": m.content} for m in request.prompt.messages],
            "timeout": request.timeout_seconds,
            **request.params,
        }

    async def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        try:
            async with self._client.messages.stream(**self._kwargs(request)) as stream:
                async for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        yield TextChunk(event.delta.text)
                message = await stream.get_final_message()
        except LlmError:
            raise
        except Exception as exc:
            raise classify(exc) from exc
        failure = rejected(message.stop_reason, message.stop_details)
        if failure is not None:
            raise failure
        text = "".join(block.text for block in message.content if block.type == "text")
        yield Done(
            LlmResult(
                text=text,
                model=message.model,
                provider=self.name,
                usage=usage_of(message.usage),
                finish_reason=message.stop_reason,
            )
        )

    async def complete(self, request: LlmRequest) -> LlmResult:
        try:
            message = await self._client.messages.create(**self._kwargs(request))
        except Exception as exc:
            raise classify(exc) from exc
        failure = rejected(message.stop_reason, message.stop_details)
        if failure is not None:
            raise failure
        text = "".join(block.text for block in message.content if block.type == "text")
        return LlmResult(
            text=text,
            model=message.model,
            provider=self.name,
            usage=usage_of(message.usage),
            finish_reason=message.stop_reason,
        )

    async def close(self) -> None:
        await self._client.close()
