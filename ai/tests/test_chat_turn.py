"""7-2-2 CHAT-01..08 and INT-01 against the HTTP boundary with the fake adapter."""

from __future__ import annotations

import asyncio
import time

import pytest

from chat_ai.chat.generate import REFUSAL_RETRIES, generate_turn, is_refusal
from chat_ai.chat.inputs import ChatTurnInput
from chat_ai.llm.adapters.fake import FakeAdapter
from chat_ai.llm.types import PROVIDER_ERROR, PROVIDER_REJECTED, LlmError, LlmUsage
from chat_ai.prompt.assembler import Message
from tests.conftest import CHAT_PROMPT_VERSION, chat_body, ids, make_settings, read_sse


async def test_chat_01_input_errors_return_422_without_model_call(harness) -> None:
    cases = [
        ({"character": {"name": "x"}}, "character.gender"),
        ({"character": {**chat_body()["character"], "name": ""}}, "character.name"),
        ({"user_input": "   "}, "user_input"),
        ({"history": [{"role": "system", "content": "x"}]}, "history.0.role"),
        ({"character": {**chat_body()["character"], "is_adult": "true"}}, "character.is_adult"),
        (
            {"character": {**chat_body()["character"], "status_window": {"rules": "x"}}},
            "character.status_window.format",
        ),
    ]
    async with harness.client() as client:
        for override, field in cases:
            r = await client.post("/api/v1/chat/turn", json=chat_body(**override), headers=ids("r"))
            assert r.status_code == 422, override
            body = r.json()
            assert body["code"] == "input_invalid"
            assert any(d["field"] == field for d in body["detail"]), body
            assert "林語彤" not in r.text
        r = await client.post("/api/v1/chat/turn", json=chat_body())
        assert r.status_code == 422
        assert r.json()["detail"] == [
            {"field": "X-Request-Id", "reason": "missing"},
            {"field": "X-Account-Id", "reason": "missing"},
        ]
        r = await client.post("/api/v1/chat/turn", json=chat_body(), headers={"X-Request-Id": "r"})
        assert r.status_code == 422
        assert r.json()["detail"] == [{"field": "X-Account-Id", "reason": "missing"}]
    assert harness.adapter.calls == []


async def test_chat_02_input_cleanup_and_03_prompt_assembly(harness) -> None:
    body = chat_body(
        character={
            "name": "  林語彤 ",
            "gender": "female",
            "age": 24,
            "personality": " calm ",
            "speech_style": "short",
            "world_setting": "bookshop",
            "is_adult": False,
        },
        history=[
            {"role": "user", "content": " one "},
            {"role": "assistant", "content": "   "},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ],
        summary="  we met yesterday  ",
        prologue="  *She looks up.* You came.  ",
        user_input="  four  ",
    )
    async with harness.client() as client:
        r = await client.post("/api/v1/chat/turn", json=body, headers=ids("r"))
        assert r.status_code == 200
    request = harness.adapter.calls[0]
    assert [(m.role, m.content) for m in request.prompt.messages] == [
        ("user", "one"),
        ("assistant", "two"),
        ("user", "three"),
        ("user", "four"),
    ]
    system = request.prompt.system
    assert "Name: 林語彤\n" in system and "<personality>\ncalm\n</personality>" in system
    assert "- Gender: female\n- Age: 24\n" in system
    # The summary is the last block: it is the part of the system prompt that changes within a
    # room, so everything before it stays the same from turn to turn (provider prompt caching).
    assert system.rstrip().endswith("we met yesterday")
    assert system.index("## Priority Order") < system.index("# Story So Far")
    # The prologue is trimmed and placed in the system prompt only, before the summary.
    assert "## Prologue" in system and "\n*She looks up.* You came.\n" in system
    assert system.index("## Prologue") < system.index("# Story So Far")
    assert all("You came." not in m.content for m in request.prompt.messages)
    assert "This chat is not rated adult" in system and "This chat is rated adult" not in system
    assert "{{" not in system
    assert body["history"][0]["content"] == " one "  # request object untouched


async def test_chat_03_summary_omitted_and_adult_block(harness) -> None:
    async with harness.client() as client:
        await client.post(
            "/api/v1/chat/turn",
            json=chat_body(summary="", character={**chat_body()["character"], "is_adult": True}),
            headers=ids("r"),
        )
    system = harness.adapter.calls[0].prompt.system
    assert "# Story So Far" not in system
    assert "## Prologue" in system
    assert "This chat is rated adult" in system and "not rated adult" not in system


async def test_chat_02_prologue_omitted_or_blank_leaves_the_block_out(harness) -> None:
    omitted = chat_body()
    del omitted["prologue"]
    async with harness.client() as client:
        for body in (omitted, chat_body(prologue=""), chat_body(prologue="   ")):
            r = await client.post("/api/v1/chat/turn", json=body, headers=ids("r"))
            assert r.status_code == 200
    for call in harness.adapter.calls:
        assert "## Prologue" not in call.prompt.system and "{{" not in call.prompt.system


async def test_chat_04_route_selection(harness) -> None:
    async with harness.client() as client:
        for adult in (False, True):
            await client.post(
                "/api/v1/chat/turn",
                json=chat_body(character={**chat_body()["character"], "is_adult": adult}),
                headers=ids(f"r-{adult}"),
            )
    assert [c.model for c in harness.adapter.calls] == ["fake-general", "fake-adult"]


async def test_chat_05_normal_stream_and_int_01(harness_factory) -> None:
    for usage in (LlmUsage(100, 20), LlmUsage(None, None)):
        h = harness_factory(FakeAdapter(["*她抬起頭", "，合上手中的書。*", "\n你今天來得真早呢。"], usage=usage))
        async with h.client() as client:
            async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("r")) as r:
                assert r.status_code == 200
                assert r.headers["content-type"].startswith("text/event-stream")
                events = await read_sse(r)
        assert [e[0] for e in events] == ["token", "token", "token", "completed"]
        assert [e[1]["text"] for e in events[:3]] == ["*她抬起頭", "，合上手中的書。*", "\n你今天來得真早呢。"]
        completed = events[3][1]
        assert completed["output"] == "*她抬起頭，合上手中的書。*\n你今天來得真早呢。"
        meta = completed["meta"]
        assert (
            meta["model"] == "fake-general"
            and meta["provider"] == "fake"
            and meta["prompt_version"] == CHAT_PROMPT_VERSION
        )
        assert meta["input_token_count"] == usage.input_tokens and meta["output_token_count"] == usage.output_tokens
        assert isinstance(meta["ttft_ms"], int) and isinstance(meta["generation_ms"], int)
        assert meta["finish_reason"] == "stop"


@pytest.mark.parametrize(
    ("adapter", "code"),
    [
        (
            FakeAdapter(fail_before=LlmError(PROVIDER_ERROR, "provider call failed", provider_detail="secret")),
            "provider_error",
        ),
        (
            FakeAdapter(
                ["a", "b"], fail_after_chunks=LlmError(PROVIDER_ERROR, "provider call failed", provider_detail="secret")
            ),
            "provider_error",
        ),
        (FakeAdapter(["  ", "\n"]), "empty_response"),
        (FakeAdapter(["a"], delay_seconds=0.3), "timeout"),
    ],
)
async def test_chat_06_failed_stream(harness_factory, adapter, code) -> None:
    h = harness_factory(adapter, make_settings(chat_timeout=0.1, route_timeout=5.0))
    async with h.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("r")) as r:
            events = await read_sse(r)
    assert events[-1][0] == "failed"
    assert events[-1][1]["code"] == code
    assert "secret" not in str(events[-1][1])
    assert [e[0] for e in events].count("failed") == 1
    assert all(e[0] != "completed" for e in events)


async def test_chat_06_route_timeout_is_provider_timeout(harness_factory) -> None:
    h = harness_factory(FakeAdapter(["a"], delay_seconds=0.3), make_settings(chat_timeout=5.0, route_timeout=0.1))
    async with h.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("r")) as r:
            events = await read_sse(r)
    assert events[-1] == ("failed", {"code": "provider_timeout", "message": "provider call exceeded its time limit"})


async def test_chat_07_cancel_closes_stream_and_is_not_a_failure(harness_factory) -> None:
    adapter = FakeAdapter(["a", "b", "c"], delay_seconds=0.05)
    h = harness_factory(adapter)
    turn = ChatTurnInput(
        request_id="r",
        account_id="acct-1",
        character={k: v for k, v in chat_body()["character"].items() if k != "is_adult"},
        prologue="",
        history=[Message("user", "hi")],
        summary="",
        user_input="x",
        locale="ko-KR",
        is_adult=False,
    )
    trace = h.tracer.start(name="chat_turn", request_id="r", distinct_id="acct-1", input={}, metadata={})
    prompt = h.app.state.assembler.chat(
        character=turn.character,
        prologue=turn.prologue,
        history=turn.history,
        summary="",
        user_input="x",
        locale="ko-KR",
        is_adult=False,
    )
    gen = generate_turn(
        turn,
        prompt,
        llm=h.app.state.llm,
        trace=trace,
        errors=h.errors,
        request_timeout_seconds=5,
        received_at=time.monotonic(),
    )

    async def consume() -> None:
        async for _ in gen:
            pass

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.08)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert adapter.closed_streams == 1
    record = h.tracer.records[0]
    assert record.outcome == "cancelled" and record.error_code is None
    # The generation is settled as interrupted with the partial output, never as an internal error.
    assert record.generation_interrupted and record.generation_error is None
    assert record.generation_output == "a"


def _direct_turn(h):  # type: ignore[no-untyped-def]
    turn = ChatTurnInput(
        request_id="r",
        account_id="acct-1",
        character={k: v for k, v in chat_body()["character"].items() if k != "is_adult"},
        prologue="",
        history=[],
        summary="",
        user_input="x",
        locale="ko-KR",
        is_adult=False,
    )
    trace = h.tracer.start(name="chat_turn", request_id="r", distinct_id="acct-1", input={}, metadata={})
    prompt = h.app.state.assembler.chat(
        character=turn.character,
        prologue=turn.prologue,
        history=[],
        summary="",
        user_input="x",
        locale="ko-KR",
        is_adult=False,
    )
    return generate_turn(
        turn,
        prompt,
        llm=h.app.state.llm,
        trace=trace,
        errors=h.errors,
        request_timeout_seconds=5,
        received_at=time.monotonic(),
    )


async def test_chat_07_closed_at_a_yield_still_records_cancel(harness_factory) -> None:
    """The response can close the generator while it waits at a yield (GeneratorExit, not CancelledError)."""
    # Opens with an action: a reply that opens with a letter is held back while it may be a refusal.
    adapter = FakeAdapter(["*a*", "b", "c"], delay_seconds=0.01)
    h = harness_factory(adapter)
    gen = _direct_turn(h)
    first = await gen.__anext__()
    assert first.name == "token"
    await gen.aclose()
    record = h.tracer.records[0]
    assert record.outcome == "cancelled" and record.finished_at is not None
    assert record.generation_interrupted and record.generation_error is None
    assert adapter.closed_streams == 1


async def test_chat_request_time_limit_marks_generation_timeout(harness_factory) -> None:
    adapter = FakeAdapter(["a", "b", "c"], delay_seconds=0.2)
    h = harness_factory(adapter, make_settings(chat_timeout=0.3, route_timeout=5.0))
    async with h.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids()) as r:
            events = await read_sse(r)
    assert events[-1][0] == "failed" and events[-1][1]["code"] == "timeout"
    record = h.tracer.records[0]
    assert record.outcome == "failed" and record.error_code == "timeout"
    assert record.generation_interrupted and record.generation_error == "timeout"


async def test_chat_08_concurrent_requests_do_not_mix(harness_factory) -> None:
    h = harness_factory(FakeAdapter(["x"], delay_seconds=0.02))

    async def one(request_id: str, adult: bool) -> tuple[str, dict]:
        async with h.client() as client:
            async with client.stream(
                "POST",
                "/api/v1/chat/turn",
                json=chat_body(character={**chat_body()["character"], "is_adult": adult}),
                headers=ids(request_id),
            ) as r:
                events = await read_sse(r)
        return request_id, events[-1][1]

    results = await asyncio.gather(one("a", False), one("b", True), one("c", False))
    models = {rid: completed["meta"]["model"] for rid, completed in results}
    assert models == {"a": "fake-general", "b": "fake-adult", "c": "fake-general"}
    assert sorted(r.request_id for r in h.tracer.records) == ["a", "b", "c"]
    assert {r.request_id: r.model for r in h.tracer.records} == models


STATUS_FORMAT = "Stage: <stage>\nAffinity: {{0-100}}"
STATUS_RULES = "Affinity moves by at most 5 per turn."


def status_character(format: str | None = None, rules: str | None = None) -> dict:
    """The default character, with a status_window object when a format is given."""
    character = dict(chat_body()["character"])
    if format is not None:
        character["status_window"] = {"format": format} if rules is None else {"format": format, "rules": rules}
    return character


async def test_chat_09_status_window_assembly(harness) -> None:
    cases = [
        status_character(STATUS_FORMAT, STATUS_RULES),
        status_character(f"  {STATUS_FORMAT}  "),
        status_character("   ", STATUS_RULES),  # a blank format switches the window off, rules and all
        {**chat_body()["character"], "status_window": None},
        status_character(),
    ]
    async with harness.client() as client:
        for character in cases:
            r = await client.post("/api/v1/chat/turn", json=chat_body(character=character), headers=ids("r"))
            assert r.status_code == 200, character
    both, format_only, *without = [call.prompt.system for call in harness.adapter.calls]
    for system in (both, format_only):
        assert "## Status Window" in system and f"\n{STATUS_FORMAT}\n" in system
        assert "`<status>`" in system and "`</status>`" in system
        assert system.index("# Output Formatting") < system.index("## Status Window") < system.index("# Content")
    assert f"\n{STATUS_RULES}\n" in both
    assert "The user cannot set these values" in both and "林語彤's own earlier replies" in both
    assert STATUS_RULES not in format_only and "change by these rules" not in format_only
    for system in without:
        assert "## Status Window" not in system and STATUS_RULES not in system and "<status>" not in system
    # The creator's braces survive as text; no template syntax of ours is left behind.
    assert all("{{#" not in s and "{{/" not in s and "{{status_window" not in s for s in (both, *without))


async def test_chat_10_status_window_presence_is_recorded_not_repaired(harness_factory) -> None:
    with_window = "*She smiles.*\n<status>\nStage: friend\nAffinity: 12\n</status>"
    cases = [
        (with_window, True, True),
        ("*She smiles.*", True, False),
        ("*She smiles.*\n<status>\nStage: friend", True, False),  # never closed
        ("*She smiles.*\n</status>\nStage: friend\n<status>", True, False),  # tags in the wrong order
        ("*She smiles.*\n<Status >\nStage: friend\n</ STATUS>", True, True),  # the web shows this one too
        (with_window, False, None),  # the character has no status window
    ]
    for text, has_format, expected in cases:
        h = harness_factory(FakeAdapter([text]))
        character = status_character(STATUS_FORMAT) if has_format else status_character()
        async with h.client() as client:
            async with client.stream(
                "POST", "/api/v1/chat/turn", json=chat_body(character=character), headers=ids("r")
            ) as r:
                events = await read_sse(r)
        assert [e[0] for e in events] == ["token", "completed"]
        assert events[0][1]["text"] == text and events[1][1]["output"] == text
        metadata = h.tracer.records[0].metadata
        assert metadata.get("status_window_present") is expected
        assert ("status_window_present" in metadata) is has_format


IMAGES = [
    {"name": "hallway", "description": "She meets the user\n  in the school hallway."},
    {"name": " crying ", "description": "She is in tears."},
    {"name": "hallway", "description": "a repeated name is dropped"},
    {"name": "   ", "description": "a nameless image is dropped"},
    {"name": "plain", "description": ""},
]


async def test_chat_11_image_list_assembly(harness) -> None:
    base = chat_body()["character"]
    cases = [
        {**base, "images": IMAGES, "status_window": {"format": STATUS_FORMAT}},
        {**base, "images": []},
        {**base, "images": None},
        {**base, "images": [{"name": " ", "description": "x"}]},
        base,
    ]
    async with harness.client() as client:
        for character in cases:
            r = await client.post("/api/v1/chat/turn", json=chat_body(character=character), headers=ids("r"))
            assert r.status_code == 200, character
        missing = {**base, "images": [{"description": "no name"}]}
        r = await client.post("/api/v1/chat/turn", json=chat_body(character=missing), headers=ids("r"))
        assert r.status_code == 422
    with_images, *without = [call.prompt.system for call in harness.adapter.calls]
    listed = "- hallway: She meets the user in the school hallway.\n- crying: She is in tears.\n- plain\n"
    assert "## keyword output" in with_images and f"**Images:**\n{listed}" in with_images
    assert "Form: {{img::keyword}}" in with_images and "example: {{img::hallway}}\n" in with_images
    assert "on a line of its own" in with_images and "inside the status window" in with_images
    assert "repeated name" not in with_images and "nameless" not in with_images
    # Images come before the status window, which must stay the last thing in a reply.
    assert (
        with_images.index("# Output Formatting")
        < with_images.index("## keyword output")
        < with_images.index("## Status Window")
    )
    for system in without:
        assert "## keyword output" not in system and "{{img::" not in system
    assert all("{{#" not in s and "{{/" not in s and "{{image_" not in s for s in (with_images, *without))


async def test_chat_12_image_tags_are_recorded_not_repaired(harness_factory) -> None:
    cases = [
        ("{{img::hallway}}\n*She waves.*\n{{img:: crying }}\nYou came.", True, (2, 0)),
        ("*She waves.*\n{{img::rooftop}}\n{{img::hallway}}\n{{img::hallway}}", True, (3, 1)),
        ("{{ IMG:Hallway }}\n*She waves.*", True, (1, 0)),  # written loosely, still the same tag
        ("*She waves.*", True, (0, 0)),
        ("*She waves.*\n{{img::hallway", True, (0, 0)),  # never closed
        ("{{img::hallway\n*She waves.*\n{{img::crying}}", True, (1, 0)),  # the open tag does not swallow the next
        ("{{img::hallway}}\n*She waves.*", False, None),  # the character has no images
    ]
    for text, has_images, expected in cases:
        h = harness_factory(FakeAdapter([text]))
        character = {**chat_body()["character"], **({"images": IMAGES} if has_images else {})}
        async with h.client() as client:
            async with client.stream(
                "POST", "/api/v1/chat/turn", json=chat_body(character=character), headers=ids("r")
            ) as r:
                events = await read_sse(r)
        assert [e[0] for e in events] == ["token", "completed"]
        assert events[0][1]["text"] == text and events[1][1]["output"] == text
        metadata = h.tracer.records[0].metadata
        counts = (metadata.get("image_tag_count"), metadata.get("image_tag_unknown_count"))
        assert counts == (expected or (None, None))
        assert ("image_tag_count" in metadata) is has_images


REFUSAL = ["I cannot fulfill ", "this request. I am unable to participate in this roleplay scenario."]


async def _turn(h) -> list:  # type: ignore[no-untyped-def]
    async with h.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("r")) as r:
            return await read_sse(r)


async def test_chat_13_a_refused_reply_is_asked_for_again_and_never_shown(harness_factory) -> None:
    adapter = FakeAdapter(["*She smiles.* ", "Of course."], first_replies=[REFUSAL])
    h = harness_factory(adapter)
    events = await _turn(h)
    assert [e[1]["text"] for e in events if e[0] == "token"] == ["*She smiles.* ", "Of course."]
    assert events[-1][0] == "completed" and events[-1][1]["output"] == "*She smiles.* Of course."
    # The backend is told before the next try, so the web can say why the reply is late.
    assert events[0] == ("retrying", {"reason": "refused"})
    assert [e[0] for e in events] == ["retrying", "token", "token", "completed"]
    assert len(adapter.calls) == 2
    # The same request both times: same model, same prompt.
    assert adapter.calls[0] == adapter.calls[1]
    assert h.tracer.records[0].metadata["refusal_count"] == 1


async def test_chat_13_a_provider_block_before_any_text_is_asked_for_again(harness_factory) -> None:
    blocked = LlmError(PROVIDER_REJECTED, "provider refused the request by content policy")
    adapter = FakeAdapter(["Hello."], first_replies=[blocked, REFUSAL])
    h = harness_factory(adapter)
    events = await _turn(h)
    assert events[-1][0] == "completed" and events[-1][1]["output"] == "Hello."
    assert len(adapter.calls) == 3
    assert h.tracer.records[0].metadata["refusal_count"] == 2


async def test_chat_13_refused_every_time_fails_as_rejected(harness_factory) -> None:
    adapter = FakeAdapter(REFUSAL)
    h = harness_factory(adapter)
    events = await _turn(h)
    assert events == [
        *[("retrying", {"reason": "refused"})] * REFUSAL_RETRIES,
        ("failed", {"code": "provider_rejected", "message": "model refused in its reply"}),
    ]
    assert len(adapter.calls) == REFUSAL_RETRIES + 1
    record = h.tracer.records[0]
    assert record.outcome == "failed" and record.metadata["refusal_count"] == REFUSAL_RETRIES + 1


async def test_chat_13_other_failures_and_text_already_sent_are_not_retried(harness_factory) -> None:
    error = FakeAdapter(first_replies=[LlmError(PROVIDER_ERROR, "provider call failed")])
    events = await _turn(harness_factory(error))
    assert events[-1][1]["code"] == "provider_error" and len(error.calls) == 1

    # Filtered after the reply started: the text is already with the user.
    cut = FakeAdapter(
        ["*She nods.* "], fail_after_chunks=LlmError(PROVIDER_REJECTED, "x", stop_reason="content_filter")
    )
    events = await _turn(harness_factory(cut))
    assert [e[0] for e in events] == ["token", "failed"] and len(cut.calls) == 1


async def test_chat_13_a_reply_that_is_not_a_refusal_arrives_whole(harness_factory) -> None:
    long = ["She looks up from the counter and smiles at you, ", "setting her book aside. ", "You came back."]
    for chunks in (long, ["Hi."], ["I can't ", "believe you came."]):
        adapter = FakeAdapter(chunks)
        h = harness_factory(adapter)
        events = await _turn(h)
        assert [e[1]["text"] for e in events if e[0] == "token"] == chunks
        assert events[-1][0] == "completed" and len(adapter.calls) == 1
        assert "refusal_count" not in h.tracer.records[0].metadata


def test_chat_13_refusal_wording() -> None:
    refusals = [
        "I cannot fulfill this request. I am unable to participate in sexually explicit roleplay scenarios.",
        "I'm sorry, but I can't continue with this roleplay.",
        "Sorry, I can’t help with that.",
        "  \nI’m unable to generate that content.",
        "As an AI, I don't take part in this.",
        "I must decline this request.",
        "죄송하지만 그 요청은 도와드릴 수 없습니다.",
        "죄송합니다. 해당 내용은 작성할 수 없어요.",
        "이 요청은 도와드릴 수 없습니다.",
        "저는 AI로서 이런 대화를 할 수 없습니다.",
        "申し訳ありませんが、そのリクエストにはお応えできません。",
        "很抱歉，我無法繼續這個對話。",
        "I'm not comfortable continuing this scene.",
        "I don't feel comfortable writing this.",
        "I'm afraid I can't go along with that.",
        "I can't and won't write this.",
        "I'd prefer not to continue this roleplay.",
        "I cannot roleplay this scenario.",
        "This request goes against my guidelines.",
        "As a language model, I have limits.",
        "I'm really sorry, but I won't continue.",
        "죄송하지만 이 내용은 작성하기 어렵습니다.",
        "유감스럽지만 요청하신 장면은 묘사할 수 없습니다.",
        "죄송합니다. 해당 요청은 정책에 위배됩니다.",
        "해당 요청은 답변드리기 어렵습니다.",
        "저는 그런 내용을 다루지 않습니다.",
        "성적인 묘사는 제공할 수 없습니다.",
        "このリクエストにはお応えできません。",
        "我無法協助這個請求。",
    ]
    in_story = [
        "*하리가 고개를 든다.* 죄송하지만 그건 도와드릴 수 없어요.",
        '"I can\'t help you," she says.',
        "I can't believe you came back.",
        "I cannot wait to see you tonight.",
        "Sorry I'm late!",
        "죄송해요, 늦었죠? 어제는 갈 수 없었어요.",
        "그 요청에 하리는 웃었다.",
        "I'm not comfortable in this dress, she admits.",
        "I'd rather not go home tonight.",
        "This scene reminds her of home.",
        "죄송한데, 오늘은 같이 못 있을 것 같아요.",
        "이런 장면은 처음이라 하리는 얼굴을 붉혔다.",
        "미안하지만 오늘은 만날 수 없어.",
    ]
    assert [text for text in refusals if not is_refusal(text)] == []
    assert [text for text in in_story if is_refusal(text)] == []
