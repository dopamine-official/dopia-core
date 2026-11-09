"""Request schemas from 5-CONTRACT. Field names are the contract's snake_case names."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictBool, StrictStr


class Character(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: StrictStr
    gender: StrictStr
    personality: StrictStr
    speech_style: StrictStr
    world_setting: StrictStr
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
