"""Provider adapters. Add a file per provider and register it in build_adapters()."""

from __future__ import annotations

from chat_ai.llm.types import Adapter
from chat_ai.settings import Settings


def build_adapters(settings: Settings) -> dict[str, Adapter]:
    """Instantiates one adapter per provider named in the route file."""
    adapters: dict[str, Adapter] = {}
    for route in settings.routes.values():
        if route.provider in adapters:
            continue
        if route.provider == "anthropic":
            from chat_ai.llm.adapters.anthropic import AnthropicAdapter

            adapters["anthropic"] = AnthropicAdapter(api_key=settings.provider_api_keys["anthropic"])
        elif route.provider == "openai":
            from chat_ai.llm.adapters.openai import OpenAIAdapter

            adapters["openai"] = OpenAIAdapter(api_key=settings.provider_api_keys["openai"])
        elif route.provider == "openrouter":
            from chat_ai.llm.adapters.openrouter import OpenRouterAdapter

            adapters["openrouter"] = OpenRouterAdapter(api_key=settings.provider_api_keys["openrouter"])
        elif route.provider == "fake":
            from chat_ai.llm.adapters.fake import FakeAdapter

            adapters["fake"] = FakeAdapter()
        else:
            raise ValueError(f"no adapter for provider: {route.provider}")
    return adapters
