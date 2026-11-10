"""Gemini adapter against a fake HTTP endpoint: request shape, stream reading, error mapping, stream closing."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx2
import pytest

from chat_ai.llm.adapters import build_adapters
from chat_ai.llm.adapters.gemini import GeminiAdapter
from chat_ai.llm.client import iterate_within
from chat_ai.llm.types import Done, LlmError, LlmRequest, TextChunk
from chat_ai.prompt.assembler import AssembledPrompt, Message
from chat_ai.settings import Route, Settings

PROMPT = AssembledPrompt(
    prompt_version="v",
    system="SYS",
    messages=[Message("user", "hi"), Message("assistant", "yo"), Message("user", "again")],
)
USAGE = {
    "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 7, "thoughtsTokenCount": 5, "totalTokenCount": 23}
}


def _request(**params: Any) -> LlmRequest:
    return LlmRequest(model="gemini-x", max_output_tokens=64, timeout_seconds=5, params=params, prompt=PROMPT)


def _chunk(text: str | None = None, finish: str | None = None, thought: bool = False, **extra: Any) -> dict[str, Any]:
    candidate: dict[str, Any] = {"index": 0}
    if text is not None:
        candidate["content"] = {"role": "model", "parts": [{"text": text} | ({"thought": True} if thought else {})]}
    if finish is not None:
        candidate["finishReason"] = finish
    return {"candidates": [candidate], "modelVersion": "gemini-served"} | extra


def _line(chunk: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(chunk)}\r\n\r\n".encode()


def _sse(*chunks: dict[str, Any]) -> httpx2.Response:
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=b"".join(map(_line, chunks)))


def _error(code: int, status: str) -> httpx2.Response:
    return httpx2.Response(code, json={"error": {"code": code, "message": "secret provider text", "status": status}})


class Endpoint:
    """Answers every request with `response` and remembers what was sent."""

    def __init__(self, response: httpx2.Response) -> None:
        self.response = response
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.response

    def adapter(self) -> GeminiAdapter:
        return GeminiAdapter(api_key="g-key", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(self)))

    @property
    def body(self) -> dict[str, Any]:
        sent: dict[str, Any] = json.loads(self.requests[0].content)
        return sent


async def _collect(adapter: GeminiAdapter, request: LlmRequest) -> list[Any]:
    return [event async for event in adapter.stream(request)]


async def test_stream_sends_the_route_and_reads_the_reply() -> None:
    endpoint = Endpoint(_sse(_chunk("plan", thought=True), _chunk("Hel"), _chunk("lo"), _chunk("", "STOP", **USAGE)))
    adapter = endpoint.adapter()
    events = await _collect(adapter, _request(temperature=0.7, thinking_config={"thinking_budget": 0}))
    await adapter.close()

    sent = endpoint.requests[0]
    assert sent.url.path.endswith("/models/gemini-x:streamGenerateContent") and sent.url.params["alt"] == "sse"
    assert sent.headers["x-goog-api-key"] == "g-key"
    body = endpoint.body
    assert body["systemInstruction"]["parts"] == [{"text": "SYS"}]
    assert [(c["role"], c["parts"][0]["text"]) for c in body["contents"]] == [
        ("user", "hi"),
        ("model", "yo"),
        ("user", "again"),
    ]
    assert body["generationConfig"]["maxOutputTokens"] == 64 and body["generationConfig"]["temperature"] == 0.7
    assert body["generationConfig"]["thinkingConfig"] == {"thinking_budget": 0}

    # Thoughts are not part of the reply.
    assert events[:-1] == [TextChunk("Hel"), TextChunk("lo")]
    done = events[-1]
    assert isinstance(done, Done)
    assert done.result.text == "Hello" and done.result.provider == "gemini"
    assert done.result.model == "gemini-served" and done.result.finish_reason == "STOP"
    # Output counts the thinking tokens too: they are billed as output.
    assert (done.result.usage.input_tokens, done.result.usage.output_tokens) == (11, 12)


async def test_complete_reads_the_reply() -> None:
    endpoint = Endpoint(httpx2.Response(200, json=_chunk("summary", "STOP", **USAGE)))
    result = await endpoint.adapter().complete(_request())
    assert endpoint.requests[0].url.path.endswith("/models/gemini-x:generateContent")
    assert result.text == "summary" and result.finish_reason == "STOP" and result.usage.input_tokens == 11


async def test_reply_cut_by_the_token_limit_is_a_result() -> None:
    events = await _collect(Endpoint(_sse(_chunk("a", "MAX_TOKENS", **USAGE))).adapter(), _request())
    assert events[-1].result.text == "a" and events[-1].result.finish_reason == "MAX_TOKENS"


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (_error(429, "RESOURCE_EXHAUSTED"), "provider_rate_limited"),
        (_error(504, "DEADLINE_EXCEEDED"), "provider_timeout"),
        (_error(503, "UNAVAILABLE"), "provider_error"),
        (_error(400, "INVALID_ARGUMENT"), "provider_error"),
        (_error(403, "PERMISSION_DENIED"), "provider_error"),
        (httpx2.Response(502, text="<html>secret provider text</html>"), "provider_error"),
        # The prompt itself was blocked: no candidates at all.
        (_sse({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}), "provider_rejected"),
        (httpx2.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}), "provider_rejected"),
        # The reply was stopped by content policy.
        (_sse(_chunk("a"), _chunk(finish="SAFETY")), "provider_rejected"),
        # An error after the 200 status arrives inside the stream.
        (
            _sse(_chunk("a"), {"error": {"code": 429, "message": "secret provider text", "status": "X"}}),
            "provider_rate_limited",
        ),
        # The connection dropped mid-reply: no finish reason ever arrived.
        (_sse(_chunk("a")), "provider_error"),
        (_sse(_chunk("a", "MALFORMED_RESPONSE")), "provider_error"),
    ],
)
async def test_failures_map_to_contract_codes(response: httpx2.Response, code: str) -> None:
    streamed = response.headers.get("content-type") == "text/event-stream"
    json_body = response.status_code == 200 and not streamed
    for call in ("stream", "complete"):
        if (call == "complete" and streamed) or (call == "stream" and json_body):
            continue
        adapter = Endpoint(response).adapter()
        with pytest.raises(LlmError) as info:
            if call == "stream":
                await _collect(adapter, _request())
            else:
                await adapter.complete(_request())
        assert info.value.code == code, call
        assert "secret provider text" not in info.value.message


async def test_timeout_and_connection_failures() -> None:
    def slow(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow", request=request)

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("down", request=request)

    for handler, code, message in (
        (slow, "provider_timeout", "provider call exceeded its time limit"),
        (down, "provider_error", "could not connect to provider"),
    ):
        adapter = GeminiAdapter(api_key="k", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)))
        with pytest.raises(LlmError) as info:
            await adapter.complete(_request())
        assert (info.value.code, info.value.message) == (code, message)


class SlowBody(httpx2.AsyncByteStream):
    """A reply that keeps coming. Records when the adapter closes it."""

    def __init__(self, closed: list[str], label: str) -> None:
        self.closed = closed
        self.label = label

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for _ in range(100):
            await asyncio.sleep(0.01)
            yield _line(_chunk("A"))

    async def aclose(self) -> None:
        self.closed.append(self.label)


def _slow_adapter(closed: list[str]) -> GeminiAdapter:
    count = iter(range(100))

    def handler(request: httpx2.Request) -> httpx2.Response:
        body = SlowBody(closed, f"call-{next(count)}")
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=body)

    return GeminiAdapter(api_key="k", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)))


async def test_stream_is_closed_at_once_when_the_consumer_leaves() -> None:
    closed: list[str] = []
    adapter = _slow_adapter(closed)
    first = adapter.stream(_request())
    second = adapter.stream(_request())
    assert await anext(first) == TextChunk("A")
    assert await anext(second) == TextChunk("A")
    await first.aclose()
    # Only the abandoned call is closed; the other one keeps streaming.
    assert closed == ["call-0"]
    assert await anext(second) == TextChunk("A")
    await second.aclose()
    assert closed == ["call-0", "call-1"]


async def test_stream_is_closed_when_the_time_limit_cancels_it() -> None:
    closed: list[str] = []
    with pytest.raises(TimeoutError):
        async for _ in iterate_within(_slow_adapter(closed).stream(_request()), 0.05):
            pass
    assert closed == ["call-0"]


def test_invalid_route_params_stop_the_server_at_startup(tmp_path: Path) -> None:
    def settings(params: dict[str, Any]) -> Settings:
        route = Route(
            name="chat_general", provider="gemini", model="m", max_output_tokens=8, timeout_seconds=1, params=params
        )
        return Settings(
            app_env="dev",
            app_release="local",
            port=8100,
            chat_request_timeout_seconds=90,
            compact_request_timeout_seconds=60,
            models_config_path=tmp_path / "models.yaml",
            prompt_dir=tmp_path,
            routes={"chat_general": route},
            provider_api_keys={"gemini": "k"},
            posthog_api_key=None,
            posthog_host=None,
        )

    assert set(build_adapters(settings({"temperature": 0.7, "thinking_config": {"thinking_budget": 0}}))) == {"gemini"}
    with pytest.raises(ValueError, match="route chat_general has invalid params"):
        build_adapters(settings({"temprature": 0.7}))
