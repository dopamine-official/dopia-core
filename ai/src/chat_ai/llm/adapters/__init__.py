"""Provider adapters. Add a file per provider and register it in build_adapters()."""

from __future__ import annotations

from chat_ai.llm.types import Adapter
from chat_ai.settings import Settings, SettingsError


def build_adapters(settings: Settings) -> dict[str, Adapter]:
    """Instantiates one adapter per provider named in the route file. Raises SettingsError on invalid params."""
    adapters: dict[str, Adapter] = {}
    for route in settings.routes.values():
        if route.provider == "gemini":
            from chat_ai.llm.adapters.gemini import GeminiAdapter

            invalid = GeminiAdapter.invalid_params(route.params)
            if invalid:
                where = settings.models_config_path.name
                raise SettingsError(", ".join(f"routes.{route.name}.{item} in {where}" for item in invalid))
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
        elif route.provider == "gemini":
            from chat_ai.llm.adapters.gemini import GeminiAdapter

            adapters["gemini"] = GeminiAdapter(api_key=settings.provider_api_keys["gemini"])
        elif route.provider == "fake":
            from chat_ai.llm.adapters.fake import FakeAdapter

            adapters["fake"] = FakeAdapter()
        else:
            raise ValueError(f"no adapter for provider: {route.provider}")
    return adapters
