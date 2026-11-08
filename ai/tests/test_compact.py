"""7-2-3 CMP-01..05 and INT-02."""

from __future__ import annotations

import asyncio

import pytest

from chat_ai.chat.compact import compact
from chat_ai.chat.inputs import CompactInput
from chat_ai.llm.adapters.fake import FakeAdapter
from chat_ai.llm.types import PROVIDER_RATE_LIMITED, LlmError
from chat_ai.prompt.assembler import Message
from tests.conftest import compact_body, ids, make_settings


async def test_cmp_01_input_errors(harness) -> None:
    async with harness.client() as client:
        r = await client.post("/api/v1/chat/compact", json={"history": []}, headers=ids("r"))
        assert r.status_code == 422 and r.json()["code"] == "input_invalid"
        r = await client.post(
            "/api/v1/chat/compact",
            json=compact_body(summary="  ", history=[{"role": "user", "content": " "}]),
            headers=ids("r"),
        )
        assert r.status_code == 422
        assert {d["field"] for d in r.json()["detail"]} == {"history", "summary"}
        r = await client.post("/api/v1/chat/compact", json=compact_body())
        assert r.status_code == 422
        r = await client.post("/api/v1/chat/compact", json=compact_body(), headers={"X-Request-Id": "r"})
        assert r.status_code == 422
        assert r.json()["detail"] == [{"field": "X-Account-Id", "reason": "missing"}]
    assert harness.adapter.calls == []


async def test_cmp_02_prompt_assembly(harness) -> None:
    history = [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
        {"role": "assistant", "content": "four"},
    ]
    async with harness.client() as client:
        await client.post("/api/v1/chat/compact", json=compact_body(history=history), headers=ids("a"))
        await client.post(
            "/api/v1/chat/compact",
            json=compact_body(summary="old summary", history=history),
            headers=ids("b"),
        )
    without, with_summary = harness.adapter.calls
    user_without = without.prompt.messages[0].content
    assert "Existing summary" not in user_without
    assert "user: one\nassistant: two\nuser: three\nassistant: four" in user_without
    user_with = with_summary.prompt.messages[0].content
    assert "Existing summary:\nold summary" in user_with
    assert 'locale "ko-KR"' in with_summary.prompt.system
    assert "{{" not in user_with and "{{" not in with_summary.prompt.system


async def test_cmp_03_normal_response_and_int_02(harness_factory) -> None:
    h = harness_factory(FakeAdapter(["  사용자는 지난달 타이베이로 이사함.  "]))
    async with h.client() as client:
        r = await client.post("/api/v1/chat/compact", json=compact_body(), headers=ids("r"))
    assert r.status_code == 200
    body = r.json()
    assert body["summary"] == "사용자는 지난달 타이베이로 이사함."
    meta = body["meta"]
    assert meta["model"] == "fake-compact" and meta["provider"] == "fake" and meta["prompt_version"] == "compact_v1"
    assert meta["input_token_count"] == 120 and meta["output_token_count"] == 30
    assert "ttft_ms" not in meta and isinstance(meta["generation_ms"], int)


@pytest.mark.parametrize(
    ("adapter", "code"),
    [
        (FakeAdapter(fail_before=LlmError(PROVIDER_RATE_LIMITED, "slow down")), "provider_rate_limited"),
        (FakeAdapter(["   "]), "empty_response"),
        (FakeAdapter(["x"], delay_seconds=0.3), "timeout"),
    ],
)
async def test_cmp_04_failures_are_502(harness_factory, adapter, code) -> None:
    h = harness_factory(adapter, make_settings(compact_timeout=0.1))
    async with h.client() as client:
        r = await client.post("/api/v1/chat/compact", json=compact_body(), headers=ids("r"))
    assert r.status_code == 502
    assert r.json()["code"] == code
    assert "summary" not in r.json()
    assert h.tracer.records[0].outcome == "failed" and h.tracer.records[0].error_code == code


async def test_cmp_05_cancel_is_not_502(harness_factory) -> None:
    adapter = FakeAdapter(["x"], delay_seconds=0.3)
    h = harness_factory(adapter)
    trace = h.tracer.start(name="chat_compact", request_id="r", distinct_id="acct-1", input={}, metadata={})
    task = asyncio.create_task(
        compact(
            CompactInput(
                request_id="r", account_id="acct-1", summary="", history=[Message("user", "hi")], locale="ko-KR"
            ),
            assembler=h.app.state.assembler,
            llm=h.app.state.llm,
            trace=trace,
            request_timeout_seconds=5,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert h.tracer.records[0].outcome == "cancelled"
