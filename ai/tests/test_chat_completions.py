"""OpenAI and OpenRouter adapters against a fake HTTP endpoint: request shape, stream reading, error mapping."""

from __future__ import annotations

import json
from typing import Any

import httpx2
import openai
import pytest

from chat_ai.llm.adapters._chat_completions import classify
from chat_ai.llm.adapters.openai import OpenAIAdapter
from chat_ai.llm.adapters.openrouter import OpenRouterAdapter
from chat_ai.llm.types import Done, LlmError, LlmRequest, TextChunk
from chat_ai.prompt.assembler import AssembledPrompt, Message

PROMPT = AssembledPrompt(prompt_version="v", system="SYS", messages=[Message("user", "hi")])


def _request(**params: Any) -> LlmRequest:
    return LlmRequest(model="vendor/model", max_output_tokens=64, timeout_seconds=5, params=params, prompt=PROMPT)


def _chunk(content: str | None = None, finish: str | None = None, **extra: Any) -> dict[str, Any]:
    delta = {} if content is None else {"content": content}
    choices = [{"index": 0, "delta": delta, "finish_reason": finish}]
    return {
        "id": "g",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "served-model",
        "choices": choices,
    } | extra


USAGE = {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
USAGE_CHUNK = {"id": "g", "object": "chat.completion.chunk", "created": 1, "model": "served-model", "choices": []}


def _sse(*chunks: dict[str, Any]) -> httpx2.Response:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


class Endpoint:
    """Answers every request with `response` and remembers what was sent."""

    def __init__(self, response: httpx2.Response) -> None:
        self.response = response
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.response

    def client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self))

    @property
    def body(self) -> dict[str, Any]:
        sent: dict[str, Any] = json.loads(self.requests[0].content)
        return sent


async def _collect(adapter: OpenAIAdapter | OpenRouterAdapter, request: LlmRequest) -> list[Any]:
    return [event async for event in adapter.stream(request)]


async def test_openrouter_stream_sends_the_route_and_reads_the_reply() -> None:
    endpoint = Endpoint(_sse(_chunk("Hel"), _chunk("lo"), _chunk(finish="stop"), USAGE_CHUNK | {"usage": USAGE}))
    adapter = OpenRouterAdapter(api_key="or-key", http_client=endpoint.client())
    events = await _collect(adapter, _request(extra_body={"provider": {"sort": "price"}}))
    await adapter.close()

    sent = endpoint.requests[0]
    assert str(sent.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert sent.headers["authorization"] == "Bearer or-key"
    assert endpoint.body["model"] == "vendor/model" and endpoint.body["max_completion_tokens"] == 64
    assert endpoint.body["messages"] == [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
    assert endpoint.body["stream"] is True and endpoint.body["provider"] == {"sort": "price"}
    assert "stream_options" not in endpoint.body

    assert events[:-1] == [TextChunk("Hel"), TextChunk("lo")]
    done = events[-1]
    assert isinstance(done, Done)
    assert done.result.text == "Hello" and done.result.provider == "openrouter"
    assert done.result.model == "served-model" and done.result.finish_reason == "stop"
    assert (done.result.usage.input_tokens, done.result.usage.output_tokens) == (11, 7)


async def test_openai_stream_asks_for_usage_and_calls_openai() -> None:
    endpoint = Endpoint(_sse(_chunk("ok"), _chunk(finish="stop"), USAGE_CHUNK | {"usage": USAGE}))
    adapter = OpenAIAdapter(api_key="oa-key", http_client=endpoint.client())
    events = await _collect(adapter, _request())
    assert str(endpoint.requests[0].url) == "https://api.openai.com/v1/chat/completions"
    assert endpoint.requests[0].headers["authorization"] == "Bearer oa-key"
    assert endpoint.body["stream_options"] == {"include_usage": True}
    assert events[-1].result.provider == "openai" and events[-1].result.usage.output_tokens == 7


async def test_complete_reads_the_reply() -> None:
    message = {"role": "assistant", "content": "summary"}
    completion = {
        "id": "g",
        "object": "chat.completion",
        "created": 1,
        "model": "served-model",
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": USAGE,
    }
    endpoint = Endpoint(httpx2.Response(200, json=completion))
    result = await OpenRouterAdapter(api_key="k", http_client=endpoint.client()).complete(_request())
    assert "stream" not in endpoint.body
    assert result.text == "summary" and result.finish_reason == "stop" and result.usage.input_tokens == 11


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (
            httpx2.Response(429, json={"error": {"code": 429, "message": "secret provider text"}}),
            "provider_rate_limited",
        ),
        (httpx2.Response(408, json={"error": {"code": 408, "message": "secret provider text"}}), "provider_timeout"),
        (httpx2.Response(401, json={"error": {"code": 401, "message": "secret provider text"}}), "provider_error"),
        (httpx2.Response(502, json={"error": {"code": 502, "message": "secret provider text"}}), "provider_error"),
        # A 403 is a refusal only when it is a moderation block; otherwise it is a permission problem.
        (httpx2.Response(403, json={"error": {"code": 403, "message": "secret provider text"}}), "provider_error"),
        (
            httpx2.Response(
                403,
                json={"error": {"code": 403, "message": "secret provider text", "metadata": {"reasons": ["sexual"]}}},
            ),
            "provider_rejected",
        ),
        (
            httpx2.Response(
                400, json={"error": {"code": "content_policy_violation", "message": "secret provider text"}}
            ),
            "provider_rejected",
        ),
        # Errors after the 200 status arrive inside the stream or the body.
        (
            _sse(_chunk("a"), _chunk("", "error", error={"code": 429, "message": "secret provider text"})),
            "provider_rate_limited",
        ),
        (
            _sse(_chunk("a"), _chunk("", "error", error={"code": 502, "message": "secret provider text"})),
            "provider_error",
        ),
        (_sse(_chunk("a"), _chunk(finish="content_filter")), "provider_rejected"),
    ],
)
async def test_failures_map_to_contract_codes(response: httpx2.Response, code: str) -> None:
    for call in ("stream", "complete"):
        if call == "complete" and response.headers.get("content-type") == "text/event-stream":
            continue
        endpoint = Endpoint(response)
        adapter = OpenRouterAdapter(api_key="k", http_client=endpoint.client())
        with pytest.raises(LlmError) as info:
            if call == "stream":
                await _collect(adapter, _request())
            else:
                await adapter.complete(_request())
        assert info.value.code == code, call
        assert "secret provider text" not in info.value.message


async def test_refusal_without_a_reply_is_rejected() -> None:
    refused = _chunk(finish="stop")
    refused["choices"][0]["delta"] = {"refusal": "I can't help with that."}
    with pytest.raises(LlmError) as info:
        await _collect(OpenAIAdapter(api_key="k", http_client=Endpoint(_sse(refused)).client()), _request())
    assert info.value.code == "provider_rejected" and info.value.stop_reason == "stop"


async def test_complete_with_an_error_body_and_no_choices_fails() -> None:
    endpoint = Endpoint(httpx2.Response(200, json={"error": {"code": 429, "message": "secret provider text"}}))
    with pytest.raises(LlmError) as info:
        await OpenRouterAdapter(api_key="k", http_client=endpoint.client()).complete(_request())
    assert info.value.code == "provider_rate_limited"


def test_classify_connection_and_unknown_errors() -> None:
    request = httpx2.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    assert classify(openai.APITimeoutError(request)).code == "provider_timeout"
    assert classify(openai.APIConnectionError(request=request)).code == "provider_error"
    assert classify(RuntimeError("secret provider text")).message == "provider call failed"
