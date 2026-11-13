"""Request schemas from 5-CONTRACT. Field names are the contract's snake_case names."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, StrictStr


class StatusWindow(BaseModel):
    """Sent only for a character whose creator turned the status window on."""

    model_config = ConfigDict(extra="ignore")
    format: StrictStr
    rules: StrictStr | None = None


class Character(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: StrictStr
    gender: StrictStr
    # Optional: characters saved before the field existed have none.
    age: StrictInt | None = None
    personality: StrictStr
    speech_style: StrictStr
    world_setting: StrictStr
    status_window: StatusWindow | None = None
    is_adult: StrictBool


class HistoryItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: Literal["user", "assistant"]
    content: StrictStr


class ChatGeneration(BaseModel):
    model_config = ConfigDict(extra="ignore")
    locale: StrictStr


class ChatTurnRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    character: Character
    prologue: StrictStr | None = None
    history: list[HistoryItem] = []
    summary: StrictStr | None = None
    user_input: StrictStr
    generation: ChatGeneration


class CompactGeneration(BaseModel):
    model_config = ConfigDict(extra="ignore")
    locale: StrictStr


class CompactRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    summary: StrictStr | None = None
    history: list[HistoryItem]
    generation: CompactGeneration
