"""Gemini adapter: the only place the Google GenAI SDK is imported. Calls the Gemini API with the GEMINI_API_KEY key.

The route's `params` are GenerateContentConfig fields (`temperature`, `thinking_config`,
`safety_settings`, …).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Any

import httpx2
from google import genai
from google.genai import errors, types
from pydantic import ValidationError

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

# Finish reasons that mean the reply was stopped by content policy.
REJECTED_FINISH = ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION")
# Finish reasons of a reply that ended on its own.
COMPLETED_FINISH = ("STOP", "MAX_TOKENS")


# The HTTP responses opened by the call running in the current task. The SDK closes a streamed
# response only when it is read to the end, so the adapter closes it itself when a call stops early.
_open_responses: ContextVar[list[httpx2.Response] | None] = ContextVar("gemini_open_responses", default=None)


async def _remember_response(response: httpx2.Response) -> None:
    opened = _open_responses.get()
    if opened is not None:
        opened.append(response)


def classify(exc: BaseException) -> LlmError:
    """Maps SDK and transport exceptions to contract codes in the order of 7-1-2."""
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, httpx2.TimeoutException | TimeoutError):
        return LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=detail)
    if isinstance(exc, errors.APIError):
        if exc.code == 429:
            return LlmError(PROVIDER_RATE_LIMITED, "provider rate limit reached", provider_detail=detail)
        if exc.code in (408, 504):
            return LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=detail)
        return LlmError(PROVIDER_ERROR, f"provider returned HTTP {exc.code}", provider_detail=detail)
    if isinstance(exc, httpx2.TransportError):
        return LlmError(PROVIDER_ERROR, "could not connect to provider", provider_detail=detail)
    return LlmError(PROVIDER_ERROR, "provider call failed", provider_detail=detail)


def _name(value: Any) -> str | None:
    """The name of an SDK enum value, or the raw string when the SDK does not know the value yet."""
    if value is None:
        return None
    return str(getattr(value, "name", value))


def ended_badly(block_reason: str | None, finish: str | None) -> LlmError | None:
    """A call that ended normally on the wire but did not produce a usable reply."""
    if block_reason is not None or finish in REJECTED_FINISH:
        detail = f"block_reason={block_reason}" if block_reason is not None else f"finish_reason={finish}"
        return LlmError(
            PROVIDER_REJECTED,
            "provider refused the request by content policy",
            provider_detail=detail,
            stop_reason=finish or block_reason,
        )
    if finish is None:
        # No finish reason: the connection dropped mid-reply. A cut-off reply is not a result.
        return LlmError(PROVIDER_ERROR, "provider stream ended before the reply finished")
    if finish not in COMPLETED_FINISH:
        detail = f"finish_reason={finish}"
        return LlmError(
            PROVIDER_ERROR, "provider ended the reply abnormally", provider_detail=detail, stop_reason=finish
        )
    return None


class _Reply:
    """Collects what the response chunks carry. A non-streamed response is read as one chunk."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.model: str | None = None
        self.usage: Any = None
        self.finish: str | None = None
        self.block_reason: str | None = None

    def read(self, chunk: Any) -> str:
        """Records the chunk and returns the reply text it adds (thoughts are left out)."""
        self.model = chunk.model_version or self.model
        self.usage = chunk.usage_metadata or self.usage
        if chunk.prompt_feedback is not None and chunk.prompt_feedback.block_reason is not None:
            self.block_reason = _name(chunk.prompt_feedback.block_reason)
        text = ""
        for candidate in (chunk.candidates or [])[:1]:
            self.finish = _name(candidate.finish_reason) or self.finish
            for part in (candidate.content.parts if candidate.content else None) or []:
                if part.text and not part.thought:
                    text += part.text
        if text:
            self.parts.append(text)
        return text

    def result(self, request: LlmRequest, provider: str) -> LlmResult:
        failure = ended_badly(self.block_reason, self.finish)
        if failure is not None:
            raise failure
        usage = self.usage
        output: int | None = None
        if usage is not None and usage.candidates_token_count is not None:
            # Thinking tokens are billed as output, like the other providers' output counts.
            output = usage.candidates_token_count + (usage.thoughts_token_count or 0)
        return LlmResult(
            text="".join(self.parts),
            model=self.model or request.model,
            provider=provider,
            usage=LlmUsage(usage.prompt_token_count if usage is not None else None, output),
            finish_reason=self.finish,
        )


class GeminiAdapter:
    name = "gemini"

    def __init__(self, api_key: str, base_url: str | None = None, http_client: Any = None) -> None:
        # Follows redirects like the client the SDK would have made itself.
        self._http = http_client if http_client is not None else httpx2.AsyncClient(follow_redirects=True)
        self._http.event_hooks["response"].append(_remember_response)
        # The SDK does not retry unless retry options are given: a failure goes straight back (6-1 5).
        options = types.HttpOptions(base_url=base_url, httpx_async_client=self._http)
        self._client = genai.Client(api_key=api_key, http_options=options)

    @staticmethod
    def invalid_params(params: dict[str, Any]) -> list[str]:
        """One short line per route param that is not a valid GenerateContentConfig field."""
        try:
            types.GenerateContentConfig.model_validate(params)
        except ValidationError as exc:
            return [f"params.{'.'.join(map(str, e['loc']))} ({e['msg']})" for e in exc.errors()]
        return []

    def _kwargs(self, request: LlmRequest) -> dict[str, Any]:
        roles = {"assistant": "model"}
        return {
            "model": request.model,
            "contents": [
                {"role": roles.get(m.role, m.role), "parts": [{"text": m.content}]} for m in request.prompt.messages
            ],
            "config": {
                "system_instruction": request.prompt.system,
                "max_output_tokens": request.max_output_tokens,
                "http_options": {"timeout": int(request.timeout_seconds * 1000)},  # milliseconds
                **request.params,
            },
        }

    async def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        reply = _Reply()
        opened: list[httpx2.Response] = []
        _open_responses.set(opened)
        try:
            try:
                async for chunk in await self._client.aio.models.generate_content_stream(**self._kwargs(request)):
                    text = reply.read(chunk)
                    if text:
                        yield TextChunk(text)
            finally:
                # Stops the provider's generation right away when the consumer left before the end.
                for response in opened:
                    try:
                        await response.aclose()
                    except Exception:
                        pass  # already gone on the other side: nothing left to close, not a call failure
                # The call is over: later calls in this task must not pile their responses up here.
                opened.clear()
                _open_responses.set(None)
        except LlmError:
            raise
        except Exception as exc:
            raise classify(exc) from exc
        yield Done(reply.result(request, self.name))

    async def complete(self, request: LlmRequest) -> LlmResult:
        reply = _Reply()
        try:
            reply.read(await self._client.aio.models.generate_content(**self._kwargs(request)))
        except Exception as exc:
            raise classify(exc) from exc
        return reply.result(request, self.name)

    async def close(self) -> None:
        await self._client.aio.aclose()
        await self._http.aclose()
