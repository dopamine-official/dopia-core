"""Cleaned request inputs (6-1 입력 정리). Built by the router from validated schemas."""

from __future__ import annotations

from dataclasses import dataclass

from chat_ai.prompt.assembler import Message


@dataclass(frozen=True)
class ChatTurnInput:
    request_id: str
    account_id: str
    # name, gender, personality, speech_style, world_setting, plus status_window_format and
    # status_window_rules from the request's status_window (both empty when it has none), and
    # image_list, one "- name: description" line per situation image, with image_example, the
    # first image's name (both empty when it has none)
    character: dict[str, str]
    prologue: str  # the room's first message; never part of history
    history: list[Message]
    summary: str
    user_input: str
    locale: str
    is_adult: bool
    image_names: frozenset[str] = frozenset()  # the names in image_list, for checking the reply's tags

    @property
    def has_status_window(self) -> bool:
        return bool(self.character.get("status_window_format"))

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
