"""Fake adapter: canned replies for local runs without an API key and for tests."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable

from chat_ai.llm.types import Done, LlmError, LlmRequest, LlmResult, LlmUsage, StreamEvent, TextChunk


class FakeAdapter:
    name = "fake"

    def __init__(
        self,
        chunks: list[str] | None = None,
        *,
        delay_seconds: float = 0.0,
        fail_before: LlmError | None = None,
        fail_after_chunks: LlmError | None = None,
        usage: LlmUsage | None = None,
        on_close: Callable[[], None] | None = None,
    ) -> None:
        self.chunks = chunks if chunks is not None else ["*she looks up from her book.* ", "You're early today", "."]
        self.delay_seconds = delay_seconds
        self.fail_before = fail_before
        self.fail_after_chunks = fail_after_chunks
        self.usage = usage if usage is not None else LlmUsage(120, 30)
        self.on_close = on_close
        self.calls: list[LlmRequest] = []
        self.closed_streams = 0

    def _result(self, request: LlmRequest, text: str) -> LlmResult:
        return LlmResult(
            text=text,
            model=request.model,
            provider=self.name,
            usage=self.usage,
            finish_reason="stop",
        )

    async def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        self.calls.append(request)
        if self.fail_before is not None:
            raise self.fail_before
        try:
            for chunk in self.chunks:
                if self.delay_seconds:
                    await asyncio.sleep(self.delay_seconds)
                yield TextChunk(chunk)
            if self.fail_after_chunks is not None:
                raise self.fail_after_chunks
            if self.delay_seconds:
                await asyncio.sleep(self.delay_seconds)
            yield Done(self._result(request, "".join(self.chunks)))
        finally:
            self.closed_streams += 1
            if self.on_close:
                self.on_close()

    async def complete(self, request: LlmRequest) -> LlmResult:
        self.calls.append(request)
        if self.fail_before is not None:
            raise self.fail_before
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        return self._result(request, "".join(self.chunks))

    async def close(self) -> None:
        return None
