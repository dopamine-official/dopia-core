from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from chat_ai.app import create_app
from chat_ai.llm.adapters.fake import FakeAdapter
from chat_ai.observe.errors import NoopErrorReporter
from chat_ai.observe.tracer import MemoryTracer
from chat_ai.settings import ROOT_DIR, Route, Settings


def make_settings(*, chat_timeout: float = 5.0, compact_timeout: float = 5.0, route_timeout: float = 5.0) -> Settings:
    def route(name: str, model: str) -> Route:
        return Route(name=name, provider="fake", model=model, max_output_tokens=256, timeout_seconds=route_timeout)

    return Settings(
        app_release="test-release",
        port=0,
        chat_request_timeout_seconds=chat_timeout,
        compact_request_timeout_seconds=compact_timeout,
        models_config_path=ROOT_DIR / "config" / "models.fake.yaml",
        prompt_dir=ROOT_DIR / "prompt",
        routes={
            "chat_general": route("chat_general", "fake-general"),
            "chat_adult": route("chat_adult", "fake-adult"),
            "compact": route("compact", "fake-compact"),
        },
        provider_api_keys={},
        posthog_api_key=None,
        posthog_host=None,
    )


class Harness:
    def __init__(self, adapter: FakeAdapter, settings: Settings) -> None:
        self.adapter = adapter
        self.tracer = MemoryTracer()
        self.errors = NoopErrorReporter()
        self.settings = settings
        self.app = create_app(settings, adapters={"fake": adapter}, tracer=self.tracer, errors=self.errors)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://chat-ai")


@pytest.fixture
def harness_factory():
    def build(adapter: FakeAdapter | None = None, settings: Settings | None = None) -> Harness:
        return Harness(adapter or FakeAdapter(), settings or make_settings())

    return build


@pytest.fixture
def harness(harness_factory) -> Harness:
    return harness_factory()


def chat_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "character": {
            "name": "林語彤",
            "gender": "female",
            "personality": "calm, a little playful",
            "speech_style": "short sentences",
            "world_setting": "a small bookshop in Taipei",
            "is_adult": False,
        },
        "prologue": "*She looks up from the counter.* You came.",
        "history": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hey"},
        ],
        "summary": "",
        "user_input": "what are you reading?",
        "generation": {"locale": "zh-TW"},
    }
    body.update(overrides)
    return body


def compact_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "summary": "",
        "history": [
            {"role": "user", "content": "I moved to Taipei last month."},
            {"role": "assistant", "content": "Then you must visit the night market."},
        ],
        "generation": {"locale": "ko-KR"},
    }
    body.update(overrides)
    return body


async def read_sse(response: httpx.Response) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    name: str | None = None
    data = ""
    async for line in response.aiter_lines():
        if line == "":
            if name is not None:
                events.append((name, json.loads(data)))
            name, data = None, ""
        elif line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data += line[5:].strip()
    return events


async def stream_turn(client: httpx.AsyncClient, body: dict[str, Any], request_id: str = "req-1") -> AsyncIterator[Any]:
    async with client.stream("POST", "/api/v1/chat/turn", json=body, headers=ids(request_id)) as r:
        yield r


def ids(request_id: str = "r", account_id: str = "acct-1") -> dict[str, str]:
    """Both required headers of an AI request."""
    return {"X-Request-Id": request_id, "X-Account-Id": account_id}


SRC_DIR = Path(__file__).resolve().parents[1] / "src" / "chat_ai"
