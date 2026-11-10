"""Chat Completions call shared by the OpenAI and OpenRouter adapters.

Both providers speak the same wire format, so the request building, stream reading and error
mapping live here once. Each adapter file keeps what is its own (endpoint, key, extra options)
and can stop using this module when its provider needs a different API.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from typing import Any

import openai

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

# Error codes the providers use for a content-policy block.
POLICY_CODES = ("content_policy_violation", "content_filter")


def _body_error(body: object) -> Mapping[str, Any]:
    """The error object of a provider error body, whether or not it is wrapped in {"error": …}."""
    if not isinstance(body, Mapping):
        return {}
    inner = body.get("error")
    return inner if isinstance(inner, Mapping) else body


def _blocked_by_policy(status: object, error: Mapping[str, Any]) -> bool:
    if error.get("code") in POLICY_CODES:
        return True
    # OpenRouter moderation: 403 whose metadata lists the reasons. A plain 403 is a permission problem.
    metadata = error.get("metadata")
    return status == 403 and isinstance(metadata, Mapping) and bool(metadata.get("reasons"))


def classify(exc: BaseException) -> LlmError:
    """Maps SDK exceptions to contract codes in the order of 7-1-2."""
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, openai.APITimeoutError | TimeoutError):
        return LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=detail)
    if isinstance(exc, openai.APIConnectionError):
        return LlmError(PROVIDER_ERROR, "could not connect to provider", provider_detail=detail)
    if isinstance(exc, openai.APIError):
        error = _body_error(exc.body)
        # An error sent inside a 200 stream has no HTTP status; its body carries the code instead.
        status = exc.status_code if isinstance(exc, openai.APIStatusError) else error.get("code")
        if _blocked_by_policy(status, error):
            return LlmError(PROVIDER_REJECTED, "provider refused the request by content policy", provider_detail=detail)
        if status == 429:
            return LlmError(PROVIDER_RATE_LIMITED, "provider rate limit reached", provider_detail=detail)
        if status == 408:
            return LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=detail)
        if isinstance(status, int):
            return LlmError(PROVIDER_ERROR, f"provider returned HTTP {status}", provider_detail=detail)
    return LlmError(PROVIDER_ERROR, "provider call failed", provider_detail=detail)


def rejected(finish_reason: str | None, text: str, refusal: str | None) -> LlmError | None:
    """A call that ended normally on the wire but was refused: filtered output, or a refusal with no reply."""
    if finish_reason == "content_filter":
        detail = "finish_reason=content_filter"
    elif refusal and not text.strip():
        detail = f"refusal: {refusal}"
    else:
        return None
    return LlmError(
        PROVIDER_REJECTED,
        "provider refused the request by content policy",
        provider_detail=detail,
        stop_reason=finish_reason or "refusal",
    )


def _usage(usage: Any) -> LlmUsage:
    if usage is None:
        return LlmUsage(None, None)
    return LlmUsage(getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None))


class ChatCompletions:
    """One provider endpoint called through the Chat Completions API."""

    def __init__(
        self,
        *,
        provider: str,
        api_key: str,
        base_url: str | None = None,
        stream_options: dict[str, Any] | None = None,
        http_client: Any = None,
    ) -> None:
        self._provider = provider
        self._stream_options = stream_options
        # No SDK retries: a failure goes straight back to the backend (6-1 5).
        self._client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url, max_retries=0, http_client=http_client)

    def _kwargs(self, request: LlmRequest) -> dict[str, Any]:
        messages = [{"role": "system", "content": request.prompt.system}]
        messages += [{"role": m.role, "content": m.content} for m in request.prompt.messages]
        return {
            "model": request.model,
            "max_completion_tokens": request.max_output_tokens,
            "messages": messages,
            "timeout": request.timeout_seconds,
            **request.params,
        }

    def _result(self, request: LlmRequest, text: str, model: str | None, usage: Any, finish: str | None) -> LlmResult:
        return LlmResult(
            text=text, model=model or request.model, provider=self._provider, usage=_usage(usage), finish_reason=finish
        )

    async def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        kwargs = self._kwargs(request)
        if self._stream_options is not None:
            kwargs.setdefault("stream_options", self._stream_options)
        parts: list[str] = []
        refusal: list[str] = []
        model: str | None = None
        usage: Any = None
        finish: str | None = None
        try:
            async with await self._client.chat.completions.create(stream=True, **kwargs) as chunks:
                async for chunk in chunks:
                    model = chunk.model or model
                    usage = chunk.usage or usage  # arrives in the last chunk, which has no choices
                    for choice in chunk.choices or []:
                        if choice.delta is not None:
                            if choice.delta.content:
                                parts.append(choice.delta.content)
                                yield TextChunk(choice.delta.content)
                            if choice.delta.refusal:
                                refusal.append(choice.delta.refusal)
                        finish = choice.finish_reason or finish
        except LlmError:
            raise
        except Exception as exc:
            raise classify(exc) from exc
        text = "".join(parts)
        failure = rejected(finish, text, "".join(refusal))
        if failure is not None:
            raise failure
        if finish == "error":
            raise LlmError(PROVIDER_ERROR, "provider ended the stream with an error", stop_reason=finish)
        yield Done(self._result(request, text, model, usage, finish))

    async def complete(self, request: LlmRequest) -> LlmResult:
        try:
            completion = await self._client.chat.completions.create(**self._kwargs(request))
        except Exception as exc:
            raise classify(exc) from exc
        # OpenRouter can answer 200 with an error object and no choices.
        error = getattr(completion, "error", None)
        if error or not completion.choices:
            body = error if isinstance(error, Mapping) else {}
            raise classify(openai.APIError(str(body.get("message") or "no choices in response"), None, body=body))  # type: ignore[arg-type]
        choice = completion.choices[0]
        text = choice.message.content or ""
        failure = rejected(choice.finish_reason, text, choice.message.refusal)
        if failure is not None:
            raise failure
        return self._result(request, text, completion.model, completion.usage, choice.finish_reason)

    async def close(self) -> None:
        await self._client.close()
