"""FastAPI application. `uvicorn chat_ai.app:app` for runs; create_app(...) for tests."""

from __future__ import annotations

import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from chat_ai.api.router import failure_response, router
from chat_ai.llm.adapters import build_adapters
from chat_ai.llm.client import LlmClient
from chat_ai.llm.types import INPUT_INVALID, Adapter
from chat_ai.observe import posthog
from chat_ai.observe.errors import ErrorReporter, NoopErrorReporter, PostHogErrorReporter
from chat_ai.observe.shutdown import shutdown_within
from chat_ai.observe.tracer import NoopTracer, PostHogTracer, Tracer
from chat_ai.prompt.assembler import PromptAssembler
from chat_ai.settings import Settings, SettingsError, load_settings

log = logging.getLogger("chat_ai")

# Seconds the observation clients get to send what is queued at shutdown (7-3-6).
OBSERVE_SHUTDOWN_SECONDS = 10.0


def _validation_detail(exc: RequestValidationError) -> list[dict[str, str]]:
    detail = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", ()) if p != "body"]
        detail.append({"field": ".".join(loc) or "body", "reason": str(err.get("type", "invalid"))})
    return detail


def create_app(
    settings: Settings | None = None,
    *,
    adapters: dict[str, Adapter] | None = None,
    tracer: Tracer | None = None,
    errors: ErrorReporter | None = None,
) -> FastAPI:
    """Builds the app. Settings load at import for the real server; tests pass everything in."""
    if settings is None:
        try:
            settings = load_settings()
        except SettingsError as e:
            logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
            log.error("startup refused: %s", e)
            sys.exit(2)

    resolved_settings: Settings = settings
    assembler = PromptAssembler(resolved_settings.prompt_dir)
    llm = LlmClient(resolved_settings.routes, adapters if adapters is not None else build_adapters(resolved_settings))

    # One PostHog client for AI call records and error reports, closed once at shutdown.
    client = (
        posthog.connect(api_key=resolved_settings.posthog_api_key, host=resolved_settings.posthog_host)
        if resolved_settings.posthog_api_key and (tracer is None or errors is None)
        else None
    )
    if tracer is None:
        tracer = (
            PostHogTracer(client, environment=resolved_settings.app_env, release=resolved_settings.app_release)
            if client is not None
            else NoopTracer()
        )
    if errors is None:
        errors = (
            PostHogErrorReporter(client, environment=resolved_settings.app_env, release=resolved_settings.app_release)
            if client is not None
            else NoopErrorReporter()
        )
    resolved_tracer: Tracer = tracer
    resolved_errors: ErrorReporter = errors

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        log.info(
            "chat-ai started env=%s release=%s routes=%s",
            resolved_settings.app_env,
            resolved_settings.app_release,
            {n: f"{r.provider}/{r.model}" for n, r in resolved_settings.routes.items()},
        )
        try:
            yield
        finally:
            await llm.close()
            closers = [resolved_tracer.shutdown, resolved_errors.shutdown]
            if client is not None:
                closers.append(lambda: posthog.close(client))
            await shutdown_within(closers, OBSERVE_SHUTDOWN_SECONDS)

    app = FastAPI(title="chat-ai", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.assembler = assembler
    app.state.llm = llm
    app.state.tracer = resolved_tracer
    app.state.errors = resolved_errors
    app.include_router(router)

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        detail = _validation_detail(exc)
        log.info("request_id=%s input_invalid detail=%s", request.headers.get("x-request-id"), detail)
        return failure_response(422, INPUT_INVALID, "input invalid", detail)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "release": resolved_settings.app_release}

    return app


def _configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


if "pytest" not in sys.modules and __name__ != "__main__":
    _configure_logging()
    app = create_app()
