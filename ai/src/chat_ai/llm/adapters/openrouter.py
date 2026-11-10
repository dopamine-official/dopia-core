"""OpenRouter adapter: one key (OPENROUTER_API_KEY) for every model OpenRouter lists.

The route's `model` is an OpenRouter slug (`vendor/model`). OpenRouter-only request fields
(`provider`, `models`, `reasoning`, …) go under `params.extra_body` in the route file.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from chat_ai.llm.adapters._chat_completions import ChatCompletions
from chat_ai.llm.types import LlmRequest, LlmResult, StreamEvent

BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterAdapter:
    name = "openrouter"

    def __init__(self, api_key: str, base_url: str = BASE_URL, http_client: Any = None) -> None:
        # Usage is always included in OpenRouter streams, so no stream option is sent.
        self._api = ChatCompletions(provider=self.name, api_key=api_key, base_url=base_url, http_client=http_client)

    def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        return self._api.stream(request)

    async def complete(self, request: LlmRequest) -> LlmResult:
        return await self._api.complete(request)

    async def close(self) -> None:
        await self._api.close()
