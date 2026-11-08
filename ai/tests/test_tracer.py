"""PostHog AI call records (7-3-2): event names, linking ids, and the fields each event carries."""

from __future__ import annotations

import asyncio
from typing import Any

from chat_ai.llm.types import LlmError, LlmUsage
from chat_ai.observe.tracer import PostHogTrace
from chat_ai.prompt.assembler import AssembledPrompt, Message


class FakeClient:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    def capture_ai(self, event: str, *, distinct_id: str, properties: dict[str, Any]) -> None:
        self.events.append((event, distinct_id, properties))


def _trace(client: FakeClient) -> PostHogTrace:
    return PostHogTrace(
        client,
        name="chat_turn",
        request_id="req-1",
        distinct_id="acct-1",
        input={"user_input": "hi"},
        base={"release": "rel", "environment": "test", "model_route": "general"},
    )


PROMPT = AssembledPrompt(prompt_version="chat_v1", system="SYS", messages=[Message("user", "hi")])


def test_completed_turn_sends_span_generation_and_trace() -> None:
    client = FakeClient()
    trace = _trace(client)
    trace.prompt_assembled(PROMPT, history_count=0, summary_length=0)
    params = {"max_output_tokens": 10, "output_config": {"effort": "low"}}
    trace.generation_started(model="m", provider="p", parameters=params, prompt=PROMPT)
    trace.first_token()
    trace.generation_finished(output="hello", usage=LlmUsage(12, 3), error=None, stop_reason="end_turn")
    trace.finish(outcome="completed", output="hello", error_code=None)

    assert [e[0] for e in client.events] == ["$ai_span", "$ai_generation", "$ai_trace"]
    assert {e[1] for e in client.events} == {"acct-1"}
    span, generation, root = (e[2] for e in client.events)
    assert all(p["$ai_trace_id"] == "req-1" and p["release"] == "rel" for p in (span, generation, root))
    assert span["$ai_span_name"] == "prompt_assembly" and span["$ai_parent_id"] == "req-1"
    assert generation["$ai_parent_id"] == "req-1" and generation["$ai_span_name"] == "llm_call"
    assert generation["$ai_input"] == [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
    assert generation["$ai_output_choices"] == [{"role": "assistant", "content": "hello"}]
    assert generation["$ai_input_tokens"] == 12 and generation["$ai_output_tokens"] == 3
    assert generation["$ai_stop_reason"] == "end_turn" and generation["$ai_is_error"] is False
    assert "$ai_time_to_first_token" in generation and generation["prompt_version"] == "chat_v1"
    assert generation["model_parameters"] == params
    assert root["$ai_span_name"] == "chat_turn" and root["outcome"] == "completed"
    assert root["$ai_input_state"] == {"user_input": "hi"} and root["$ai_output_state"] == "hello"
    assert root["$ai_is_error"] is False and root["prompt_version"] == "chat_v1"


def test_failed_generation_and_cancelled_trace() -> None:
    client = FakeClient()
    trace = _trace(client)
    trace.generation_started(model="m", provider="p", parameters={}, prompt=PROMPT)
    trace.generation_finished(
        output="", usage=None, error=LlmError("provider_error", "x", provider_detail="APIError: boom")
    )
    trace.finish(outcome="cancelled", output=None, error_code=None)
    generation, root = (e[2] for e in client.events)
    assert generation["$ai_is_error"] is True and generation["$ai_error"] == "provider_error: APIError: boom"
    assert "$ai_input_tokens" not in generation and "$ai_time_to_first_token" not in generation
    assert root["outcome"] == "cancelled" and root["$ai_is_error"] is False


def test_send_failure_never_raises() -> None:
    class Broken:
        def capture_ai(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("network down")

    trace = PostHogTrace(Broken(), name="chat_turn", request_id="r", distinct_id="a", input={}, base={})
    trace.prompt_assembled(PROMPT, history_count=0, summary_length=0)
    trace.finish(outcome="completed", output="x", error_code=None)


def test_refusal_keeps_stop_reason() -> None:
    client = FakeClient()
    trace = _trace(client)
    trace.generation_started(model="m", provider="p", parameters={}, prompt=PROMPT)
    refusal = LlmError("provider_rejected", "x", provider_detail="refusal category=c", stop_reason="refusal")
    trace.generation_finished(output="", usage=None, error=refusal, stop_reason=refusal.stop_reason)
    (_, _, generation) = client.events[0]
    assert generation["$ai_stop_reason"] == "refusal" and generation["$ai_is_error"] is True


def test_interrupted_generation_follows_trace_outcome() -> None:
    for outcome, code, is_error in (("cancelled", None, False), ("failed", "timeout", True)):
        client = FakeClient()
        trace = _trace(client)
        trace.generation_started(model="m", provider="p", parameters={}, prompt=PROMPT)
        trace.generation_interrupted(output="par")
        trace.finish(outcome=outcome, output=None, error_code=code)
        generation, root = (e[2] for e in client.events)
        assert [e[0] for e in client.events] == ["$ai_generation", "$ai_trace"]
        assert generation["$ai_output_choices"] == [{"role": "assistant", "content": "par"}]
        assert generation["$ai_is_error"] is is_error and generation["outcome"] == outcome
        assert generation.get("$ai_error") == code and root["outcome"] == outcome


async def test_shutdown_gives_up_after_the_limit() -> None:
    import threading

    from chat_ai.observe.shutdown import shutdown_within

    release = threading.Event()
    assert await shutdown_within([lambda: None], 1.0) is True
    started = asyncio.get_running_loop().time()
    assert await shutdown_within([lambda: release.wait(5)], 0.2) is False
    assert asyncio.get_running_loop().time() - started < 1.0
    release.set()
