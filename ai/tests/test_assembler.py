"""Template renderer unit tests (blocks, inverted blocks, missing placeholders)."""

from __future__ import annotations

from pathlib import Path

import pytest

from chat_ai.prompt.assembler import PromptAssembler, TemplateError, parse_template, render


def test_render_blocks_and_variables() -> None:
    text = "Hi {{name}}\n{{#summary}}S: {{summary}}\n{{/summary}}{{^summary}}no summary\n{{/summary}}end"
    assert render(text, {"name": "A", "summary": "x"}) == "Hi A\nS: x\nend\n"
    assert render(text, {"name": "A", "summary": ""}) == "Hi A\nno summary\nend\n"


def test_render_rejects_unknown_placeholder() -> None:
    with pytest.raises(TemplateError):
        render("{{nope}}", {})


def test_render_leaves_braces_in_values_alone() -> None:
    # Creators and the summary model can write "{{...}}"; it is text, not a placeholder.
    text = "{{#format}}\n{{format}}\n{{/format}}\n{{name}}"
    out = render(text, {"format": "Affinity: {{affinity}}", "name": "{{char}}"})
    assert out == "Affinity: {{affinity}}\n{{char}}\n"


def test_parse_template_requires_system_section() -> None:
    with pytest.raises(TemplateError):
        parse_template("v", "just text")
    t = parse_template("v", "<!-- system -->\nS\n<!-- user -->\nU\n")
    assert t.system == "S" and t.user == "U"


def test_assembler_versions_come_from_frontmatter(tmp_path: Path) -> None:
    (tmp_path / "chat.md").write_text(
        "---\nversion: chat_v2\n---\n<!-- system -->\n"
        "{{name}} {{locale}} {{is_adult}} {{summary}}\n{{#prologue}}P:{{prologue}}{{/prologue}}",
        encoding="utf-8",
    )
    (tmp_path / "compact.md").write_text(
        "---\nversion: compact_v2\n---\n<!-- system -->\n{{locale}}\n<!-- user -->\n{{history}}", encoding="utf-8"
    )
    assembler = PromptAssembler(tmp_path)
    assert assembler.version("chat") == "chat_v2"
    prompt = assembler.chat(
        character={"name": "N", "gender": "g", "personality": "p", "speech_style": "s", "world_setting": "w"},
        prologue="",
        history=[],
        summary="",
        user_input="hi",
        locale="ko-KR",
        is_adult=True,
    )
    assert prompt.prompt_version == "chat_v2" and prompt.system == "N ko-KR\n"
    character = {"name": "N", "gender": "g", "personality": "p", "speech_style": "s", "world_setting": "w"}
    opened = assembler.chat(
        character=character, prologue="once", history=[], summary="", user_input="hi", locale="ko-KR", is_adult=True
    )
    # The prologue goes into the system prompt only; the messages start with the user.
    assert opened.system == "N ko-KR  \nP:once\n"
    assert [(m.role, m.content) for m in opened.messages] == [("user", "hi")]
    (tmp_path / "chat.md").write_text("---\ntitle: no version\n---\n<!-- system -->\nS", encoding="utf-8")
    with pytest.raises(TemplateError, match="no version"):
        PromptAssembler(tmp_path)
    (tmp_path / "chat.md").unlink()
    with pytest.raises(TemplateError, match="missing"):
        PromptAssembler(tmp_path)
