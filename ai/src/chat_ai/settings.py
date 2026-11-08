"""Settings: environment variables plus the model route file (config/models.yaml).

Everything is read and validated once at startup. A missing required value stops
the server with a log line naming the item (7-1 설정 오류).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from chat_ai.prompt.assembler import PROMPT_KEYS, TemplateError, load_prompt

ROOT_DIR = Path(__file__).resolve().parents[2]
ROUTE_NAMES = ("chat_general", "chat_adult", "compact")


class SettingsError(Exception):
    """Raised at startup when configuration is missing or invalid."""


@dataclass(frozen=True)
class Route:
    name: str
    provider: str
    model: str
    max_output_tokens: int
    timeout_seconds: float
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Settings:
    app_env: str
    app_release: str
    port: int
    chat_request_timeout_seconds: float
    compact_request_timeout_seconds: float
    models_config_path: Path
    prompt_dir: Path
    routes: dict[str, Route]
    provider_api_keys: dict[str, str]
    posthog_api_key: str | None
    posthog_host: str | None

    def route(self, name: str) -> Route:
        try:
            return self.routes[name]
        except KeyError as e:
            raise SettingsError(f"unknown model route: {name}") from e


def load_env_file(path: Path) -> None:
    """Loads KEY=VALUE lines into os.environ without overriding existing variables."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _float_env(name: str, default: float, missing: list[str]) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        missing.append(f"{name} (not a number)")
        return default


def load_routes(path: Path, missing: list[str]) -> dict[str, Route]:
    if not path.is_file():
        missing.append(f"model config file {path}")
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    routes: dict[str, Route] = {}
    raw_routes = data.get("routes") or {}
    for name in ROUTE_NAMES:
        raw = raw_routes.get(name)
        if not isinstance(raw, dict):
            missing.append(f"routes.{name} in {path.name}")
            continue
        problems = [
            k for k in ("provider", "model", "max_output_tokens", "timeout_seconds") if raw.get(k) in (None, "")
        ]
        if problems:
            missing.extend(f"routes.{name}.{k} in {path.name}" for k in problems)
            continue
        params = raw.get("params") or {}
        if not isinstance(params, dict):
            missing.append(f"routes.{name}.params must be a mapping in {path.name}")
            continue
        routes[name] = Route(
            name=name,
            provider=str(raw["provider"]),
            model=str(raw["model"]),
            max_output_tokens=int(raw["max_output_tokens"]),
            timeout_seconds=float(raw["timeout_seconds"]),
            params=dict(params),
        )
    return routes


APP_ENVS = ("dev", "prod")


def load_settings(env_file: Path | None = None) -> Settings:
    """Reads env vars and the route file. Raises SettingsError listing every missing item."""
    load_env_file(env_file if env_file is not None else ROOT_DIR / ".env.local")
    missing: list[str] = []

    models_config_path = Path(_env("MODELS_CONFIG_PATH", "config/models.yaml") or "")
    if not models_config_path.is_absolute():
        models_config_path = ROOT_DIR / models_config_path
    prompt_dir = Path(_env("PROMPT_DIR", "prompt") or "")
    if not prompt_dir.is_absolute():
        prompt_dir = ROOT_DIR / prompt_dir
    if not prompt_dir.is_dir():
        missing.append(f"prompt directory {prompt_dir}")

    routes = load_routes(models_config_path, missing)

    if prompt_dir.is_dir():
        for key in PROMPT_KEYS:
            try:
                load_prompt(key, prompt_dir)
            except TemplateError as e:
                missing.append(str(e))

    provider_api_keys: dict[str, str] = {}
    for route in routes.values():
        if route.provider == "fake":
            continue
        env_name = f"{route.provider.upper()}_API_KEY"
        api_key = _env(env_name)
        if api_key is None:
            if env_name not in missing:
                missing.append(env_name)
            continue
        provider_api_keys[route.provider] = api_key

    # With PostHog on, APP_ENV must be explicit: PostHog hides `dev`, so a production server
    # that silently fell back to `dev` would vanish from every chart.
    app_env = _env("APP_ENV")
    posthog_api_key = _env("POSTHOG_API_KEY")
    if app_env is not None and app_env not in APP_ENVS:
        missing.append(f"APP_ENV must be one of {', '.join(APP_ENVS)} (got {app_env!r})")
    elif app_env is None and posthog_api_key is not None:
        missing.append("APP_ENV (required when POSTHOG_API_KEY is set)")

    settings = Settings(
        app_env=app_env or "dev",
        app_release=_env("APP_RELEASE") or _env("RAILWAY_GIT_COMMIT_SHA") or "local",
        port=int(_env("PORT", "8100") or "8100"),
        chat_request_timeout_seconds=_float_env("CHAT_REQUEST_TIMEOUT_SECONDS", 90.0, missing),
        compact_request_timeout_seconds=_float_env("COMPACT_REQUEST_TIMEOUT_SECONDS", 60.0, missing),
        models_config_path=models_config_path,
        prompt_dir=prompt_dir,
        routes=routes,
        provider_api_keys=provider_api_keys,
        posthog_api_key=posthog_api_key,
        posthog_host=_env("POSTHOG_HOST"),
    )
    if missing:
        raise SettingsError("missing configuration: " + ", ".join(missing))
    return settings
