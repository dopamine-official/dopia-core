"""OpenAI adapter: calls the OpenAI API directly with OPENAI_API_KEY.

Kept apart from the OpenRouter adapter so OpenAI-only features can be added here without
touching the other provider.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from chat_ai.llm.adapters._chat_completions import ChatCompletions
from chat_ai.llm.types import LlmRequest, LlmResult, StreamEvent


class OpenAIAdapter:
    name = "openai"

    def __init__(self, api_key: str, base_url: str | None = None, http_client: Any = None) -> None:
        self._api = ChatCompletions(
            provider=self.name,
            api_key=api_key,
            base_url=base_url,
            # OpenAI sends token usage on a stream only when asked.
            stream_options={"include_usage": True},
            http_client=http_client,
        )

    def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        return self._api.stream(request)

    async def complete(self, request: LlmRequest) -> LlmResult:
        return await self._api.complete(request)

    async def close(self) -> None:
        await self._api.close()
