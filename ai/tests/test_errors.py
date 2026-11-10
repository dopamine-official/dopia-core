"""7-2-4 ERR-01..05: adapter error classification, settings, internal errors, tracing, module boundaries."""

from __future__ import annotations

import os
import re
from pathlib import Path

import anthropic
import httpx2
import pytest

from chat_ai.llm.adapters.anthropic import classify, rejected
from chat_ai.llm.adapters.fake import FakeAdapter
from chat_ai.llm.types import TextChunk
from chat_ai.settings import ROOT_DIR, SettingsError, load_settings
from tests.conftest import SRC_DIR, chat_body, compact_body, ids


def _status(status: int) -> anthropic.APIStatusError:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(status, request=request, json={"error": {"message": "secret provider text"}})
    cls = {429: anthropic.RateLimitError, 401: anthropic.AuthenticationError, 500: anthropic.InternalServerError}
    return cls.get(status, anthropic.APIStatusError)("secret provider text", response=response, body=None)


def test_err_01_adapter_error_classification() -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    cases = [
        (anthropic.APITimeoutError(request), "provider_timeout"),
        (_status(429), "provider_rate_limited"),
        (_status(401), "provider_error"),
        (_status(500), "provider_error"),
        (anthropic.APIConnectionError(request=request), "provider_error"),
        (RuntimeError("secret provider text"), "provider_error"),
    ]
    for exc, code in cases:
        error = classify(exc)
        assert error.code == code, type(exc)
        assert "secret provider text" not in error.message
        assert error.provider_detail is not None
    refusal = rejected("refusal", type("Details", (), {"category": "general_harms"})())
    assert refusal is not None and refusal.code == "provider_rejected"
    assert rejected("end_turn", None) is None


def test_err_02_settings_errors_list_every_missing_item(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ANTHROPIC_API_KEY", "MODELS_CONFIG_PATH"):
        monkeypatch.delenv(name, raising=False)
    config = tmp_path / "models.yaml"
    prompt_dir = tmp_path / "prompt"
    prompt_dir.mkdir()
    (prompt_dir / "chat.md").write_text("<!-- system -->\nno frontmatter\n", encoding="utf-8")
    monkeypatch.setenv("PROMPT_DIR", str(prompt_dir))
    config.write_text(
        "routes:\n"
        "  chat_general: {provider: anthropic, model: m, max_output_tokens: 10, timeout_seconds: 1}\n"
        "  compact: {provider: anthropic, model: m, max_output_tokens: 10}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MODELS_CONFIG_PATH", str(config))
    with pytest.raises(SettingsError) as info:
        load_settings(env_file=tmp_path / "none.env")
    message = str(info.value)
    assert "routes.chat_adult" in message
    assert "routes.compact.timeout_seconds" in message
    assert "chat.md has no frontmatter" in message
    (prompt_dir / "compact.md").write_text("---\nversion: compact_v9\n---\n<!-- system -->\nS\n", encoding="utf-8")
    with pytest.raises(SettingsError) as info:
        load_settings(env_file=tmp_path / "none.env")
    assert "compact.md needs a <!-- user --> section" in str(info.value)
    assert "compact.md" in message
    assert "ANTHROPIC_API_KEY" in message


def test_err_02_params_cannot_repeat_what_the_route_sets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PROMPT_DIR", raising=False)
    config = tmp_path / "models.yaml"
    route = "{provider: fake, model: m, max_output_tokens: 10, timeout_seconds: 1"
    config.write_text(
        "routes:\n"
        f"  chat_general: {route}, params: {{stream: false, temperature: 0.7}}}}\n"
        f"  chat_adult: {route}, params: {{max_tokens: 5, model: other}}}}\n"
        f"  compact: {route}, params: {{temperature: 0.2}}}}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MODELS_CONFIG_PATH", str(config))
    with pytest.raises(SettingsError) as info:
        load_settings(env_file=tmp_path / "none.env")
    message = str(info.value)
    assert "routes.chat_general.params.stream is not allowed" in message
    assert "routes.chat_adult.params.max_tokens is not allowed" in message
    assert "routes.chat_adult.params.model is not allowed" in message
    assert "temperature" not in message and "routes.compact" not in message


def test_err_02_real_config_loads_with_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("MODELS_CONFIG_PATH", raising=False)
    settings = load_settings(env_file=tmp_path / "none.env")
    assert set(settings.routes) == {"chat_general", "chat_adult", "compact"}
    assert settings.routes["chat_general"].provider == "anthropic"
    assert settings.prompt_dir == ROOT_DIR / "prompt"
    assert (ROOT_DIR / "config" / "models.fake.yaml").is_file()
    assert os.environ["ANTHROPIC_API_KEY"] == "test-key"


def test_err_02_posthog_needs_an_explicit_app_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # PostHog hides `dev`: a production server that fell back to it would vanish from every chart.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("MODELS_CONFIG_PATH", raising=False)
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    monkeypatch.delenv("APP_ENV", raising=False)
    with pytest.raises(SettingsError, match="APP_ENV \\(required when POSTHOG_API_KEY is set\\)"):
        load_settings(env_file=tmp_path / "none.env")
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SettingsError, match="APP_ENV must be one of dev, prod"):
        load_settings(env_file=tmp_path / "none.env")
    monkeypatch.setenv("APP_ENV", "prod")
    assert load_settings(env_file=tmp_path / "none.env").app_env == "prod"
    monkeypatch.delenv("POSTHOG_API_KEY")
    monkeypatch.delenv("APP_ENV")
    assert load_settings(env_file=tmp_path / "none.env").app_env == "dev"


async def test_err_03_internal_error_before_and_after_sse(harness_factory, monkeypatch: pytest.MonkeyPatch) -> None:
    h = harness_factory()

    def broken_chat(**kwargs):  # noqa: ANN003
        raise RuntimeError("assembly exploded")

    monkeypatch.setattr(h.app.state.assembler, "chat", broken_chat)
    async with h.client() as client:
        r = await client.post("/api/v1/chat/turn", json=chat_body(), headers=ids("r"))
    assert r.status_code == 500 and r.json() == {"code": "internal_error", "message": "internal error"}
    assert len(h.errors.reported) == 1
    # Reported under the requesting account, with the request it belongs to.
    assert h.errors.reported[0][1:] == ("r", "acct-1", "chat")

    class Exploding(FakeAdapter):
        async def stream(self, request):  # noqa: ANN001
            yield TextChunk("a")
            raise RuntimeError("mid-stream explosion")

    h2 = harness_factory(Exploding(["a"]))
    async with h2.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("r")) as r:
            assert r.status_code == 200
            text = await r.aread()
    assert b"event: failed" in text and b'"code": "internal_error"' in text
    assert b"explosion" not in text
    assert len(h2.errors.reported) == 1
    assert h2.errors.reported[0][1:] == ("r", "acct-1", "chat")
    # The llm_call record is closed even though the adapter died unexpectedly.
    assert h2.tracer.records[0].generation_error is not None
    assert h2.tracer.records[0].generation_output == "a"


async def test_err_04_trace_records_fields_and_no_prompt_text_in_logs(harness_factory, caplog) -> None:
    h = harness_factory(FakeAdapter(["hello"]))
    caplog.set_level("INFO", logger="chat_ai")
    async with h.client() as client:
        async with client.stream("POST", "/api/v1/chat/turn", json=chat_body(), headers=ids("trace-1")) as r:
            await r.aread()
        await client.post("/api/v1/chat/compact", json=compact_body(), headers=ids("trace-2"))
    chat, comp = h.tracer.records
    assert chat.request_id == "trace-1" and chat.name == "chat_turn"
    assert chat.model == "fake-general" and chat.provider == "fake" and chat.prompt_version == "v0.1"
    assert chat.usage is not None and chat.usage.input_tokens == 120
    assert chat.outcome == "completed" and chat.duration_ms is not None and chat.first_token_at is not None
    assert chat.distinct_id == "acct-1" and chat.metadata["model_route"] == "general"
    assert chat.stop_reason is not None
    assert comp.name == "chat_compact" and comp.outcome == "completed" and comp.prompt_version == "compact_v1"
    joined = "\n".join(caplog.messages)
    assert "trace-1" in joined and "trace-2" in joined
    assert "bookshop" not in joined and "hello" not in joined


def test_err_05_modules_do_not_import_provider_sdks() -> None:
    sdk = re.compile(r"^\s*(import|from)\s+(anthropic|openai|google|posthog)\b", re.MULTILINE)
    allowed = {
        SRC_DIR / "llm" / "adapters" / "anthropic.py",
        SRC_DIR / "llm" / "adapters" / "_chat_completions.py",
        SRC_DIR / "llm" / "adapters" / "gemini.py",
        SRC_DIR / "observe" / "posthog.py",
    }
    for path in SRC_DIR.rglob("*.py"):
        if path in allowed:
            continue
        assert not sdk.search(path.read_text(encoding="utf-8")), f"{path} imports a provider SDK"
