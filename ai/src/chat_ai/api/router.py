"""Router (6-2): validation, input cleanup, SSE/JSON responses, failure mapping."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse

from chat_ai.api.schemas import ChatTurnRequest, CompactRequest, HistoryItem
from chat_ai.chat.compact import CompactFailure, compact
from chat_ai.chat.generate import Event, assemble_chat_prompt, generate_turn
from chat_ai.chat.inputs import ChatTurnInput, CompactInput
from chat_ai.llm.types import INPUT_INVALID, INTERNAL_ERROR
from chat_ai.prompt.assembler import Message

log = logging.getLogger("chat_ai.api")
router = APIRouter(prefix="/api/v1/chat")


class InputInvalid(Exception):
    def __init__(self, detail: list[dict[str, str]]) -> None:
        super().__init__("input invalid")
        self.detail = detail


def failure_response(status: int, code: str, message: str, detail: list[dict[str, str]] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def sse(event: Event) -> str:
    return f"event: {event.name}\ndata: {json.dumps(event.data, ensure_ascii=False)}\n\n"


def _ids(request_id: str | None, account_id: str | None) -> tuple[str, str]:
    """Both headers are required: X-Request-Id is the trace id, X-Account-Id the PostHog distinct_id."""
    values = {"X-Request-Id": request_id, "X-Account-Id": account_id}
    detail = [{"field": k, "reason": "missing"} for k, v in values.items() if v is None or not v.strip()]
    if detail:
        raise InputInvalid(detail)
    return (request_id or "").strip(), (account_id or "").strip()


def _clean_history(items: list[HistoryItem]) -> list[Message]:
    return [Message(role=i.role, content=i.content.strip()) for i in items if i.content.strip()]


def chat_input(request_id: str, account_id: str, body: ChatTurnRequest) -> ChatTurnInput:
    character = {k: v.strip() for k, v in body.character.model_dump(exclude={"is_adult"}).items()}
    detail = [{"field": f"character.{k}", "reason": "empty"} for k, v in character.items() if not v]
    user_input = body.user_input.strip()
    if not user_input:
        detail.append({"field": "user_input", "reason": "empty"})
    if detail:
        raise InputInvalid(detail)
    return ChatTurnInput(
        request_id=request_id,
        account_id=account_id,
        character=character,
        history=_clean_history(body.history),
        summary=(body.summary or "").strip(),
        user_input=user_input,
        locale=body.generation.locale.strip(),
        is_adult=body.character.is_adult,
    )


def compact_input(request_id: str, account_id: str, body: CompactRequest) -> CompactInput:
    history = _clean_history(body.history)
    summary = (body.summary or "").strip()
    if not history and not summary:
        raise InputInvalid([{"field": "history", "reason": "empty"}, {"field": "summary", "reason": "empty"}])
    return CompactInput(
        request_id=request_id,
        account_id=account_id,
        summary=summary,
        history=history,
        locale=body.generation.locale.strip(),
    )


@router.post("/turn")
async def chat_turn(
    request: Request,
    body: ChatTurnRequest,
    x_request_id: str | None = Header(default=None),
    x_account_id: str | None = Header(default=None),
) -> Any:
    received_at = time.monotonic()
    state = request.app.state
    try:
        turn = chat_input(*_ids(x_request_id, x_account_id), body)
    except InputInvalid as e:
        return failure_response(422, INPUT_INVALID, "input invalid", e.detail)

    trace = state.tracer.start(
        name="chat_turn",
        request_id=turn.request_id,
        distinct_id=turn.account_id,
        input=body.model_dump(),
        metadata={
            "model_route": turn.model_route,
            "locale": turn.locale,
            "character_name": turn.character["name"],
            "prompt_version": state.assembler.version("chat"),
        },
    )
    try:
        prompt = assemble_chat_prompt(state.assembler, turn, trace)
    except Exception as exc:  # noqa: BLE001
        state.errors.report(exc, request_id=turn.request_id, account_id=turn.account_id, subtask="chat")
        trace.finish(outcome="failed", output={"code": INTERNAL_ERROR}, error_code=INTERNAL_ERROR)
        log.exception("request_id=%s subtask=chat prompt assembly failed", turn.request_id)
        return failure_response(500, INTERNAL_ERROR, "internal error")

    async def body_stream() -> AsyncIterator[str]:
        async for event in generate_turn(
            turn,
            prompt,
            llm=state.llm,
            trace=trace,
            errors=state.errors,
            request_timeout_seconds=state.settings.chat_request_timeout_seconds,
            received_at=received_at,
        ):
            yield sse(event)

    return StreamingResponse(
        body_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/compact")
async def chat_compact(
    request: Request,
    body: CompactRequest,
    x_request_id: str | None = Header(default=None),
    x_account_id: str | None = Header(default=None),
) -> Any:
    state = request.app.state
    try:
        data = compact_input(*_ids(x_request_id, x_account_id), body)
    except InputInvalid as e:
        return failure_response(422, INPUT_INVALID, "input invalid", e.detail)

    trace = state.tracer.start(
        name="chat_compact",
        request_id=data.request_id,
        distinct_id=data.account_id,
        input=body.model_dump(),
        metadata={
            "model_route": "summary",
            "locale": data.locale,
            "prompt_version": state.assembler.version("compact"),
        },
    )
    try:
        result = await compact(
            data,
            assembler=state.assembler,
            llm=state.llm,
            trace=trace,
            request_timeout_seconds=state.settings.compact_request_timeout_seconds,
        )
    except CompactFailure as failure:
        return failure_response(502, failure.code, failure.message)
    except Exception as exc:  # noqa: BLE001
        state.errors.report(exc, request_id=data.request_id, account_id=data.account_id, subtask="compact")
        trace.finish(outcome="failed", output={"code": INTERNAL_ERROR}, error_code=INTERNAL_ERROR)
        log.exception("request_id=%s subtask=compact internal error", data.request_id)
        return failure_response(500, INTERNAL_ERROR, "internal error")
    return JSONResponse(content=result)
