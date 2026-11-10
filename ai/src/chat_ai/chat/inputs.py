"""Cleaned request inputs (6-1 입력 정리). Built by the router from validated schemas."""

from __future__ import annotations

from dataclasses import dataclass

from chat_ai.prompt.assembler import Message


@dataclass(frozen=True)
class ChatTurnInput:
    request_id: str
    account_id: str
    character: dict[str, str]  # name, gender, personality, speech_style, world_setting
    prologue: str  # the room's first message; never part of history
    history: list[Message]
    summary: str
    user_input: str
    locale: str
    is_adult: bool

    @property
    def route_name(self) -> str:
        return "chat_adult" if self.is_adult else "chat_general"

    @property
    def model_route(self) -> str:
        return "adult" if self.is_adult else "general"


@dataclass(frozen=True)
class CompactInput:
    request_id: str
    account_id: str
    summary: str
    history: list[Message]
    locale: str
