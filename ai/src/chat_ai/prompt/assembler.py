"""Prompt assembly module (6-1 3, 6-2 프롬프트 조립 모듈).

Templates live in prompt/<key>.md (chat.md, compact.md) and are never inlined in code.
A template starts with a frontmatter block whose `version` names the template version:
  ---
  version: chat_v1
  ---
Then come sections marked by `<!-- system -->` and optionally `<!-- user -->`. Inside a section:
  {{key}}            value substitution
  {{#key}} … {{/key}} kept only when the value is truthy (non-empty string or True)
  {{^key}} … {{/key}} kept only when the value is falsy
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

PROMPT_KEYS = ("chat", "compact")
NEEDS_USER_SECTION = ("compact",)
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
SECTION_RE = re.compile(r"^<!--\s*(system|user)\s*-->\s*$", re.MULTILINE)
BLOCK_RE = re.compile(r"\{\{([#^])(\w+)\}\}\n?(.*?)\{\{/\2\}\}\n?", re.DOTALL)
VAR_RE = re.compile(r"\{\{(\w+)\}\}")


class TemplateError(Exception):
    pass


@dataclass(frozen=True)
class Template:
    version: str
    system: str
    user: str | None


@dataclass(frozen=True)
class Message:
    role: str  # user | assistant
    content: str


@dataclass(frozen=True)
class AssembledPrompt:
    prompt_version: str
    system: str
    messages: list[Message] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"system": self.system, "messages": [{"role": m.role, "content": m.content} for m in self.messages]}


def split_frontmatter(name: str, text: str) -> tuple[str, str]:
    """Returns (version, body). Raises TemplateError when the frontmatter or its version is missing."""
    match = FRONTMATTER_RE.match(text)
    if match is None:
        raise TemplateError(f"template {name} has no frontmatter")
    meta = yaml.safe_load(match.group(1)) or {}
    version = meta.get("version") if isinstance(meta, dict) else None
    if not isinstance(version, str) or not version.strip():
        raise TemplateError(f"template {name} frontmatter has no version")
    return version.strip(), text[match.end() :]


def load_template(path: Path) -> Template:
    version, body = split_frontmatter(path.name, path.read_text(encoding="utf-8"))
    return parse_template(version, body)


def load_prompt(key: str, prompt_dir: Path) -> Template:
    """Loads prompt/<key>.md and checks the sections that subtask needs. Raises TemplateError."""
    path = prompt_dir / f"{key}.md"
    if not path.is_file():
        raise TemplateError(f"prompt template missing: {path}")
    template = load_template(path)
    if key in NEEDS_USER_SECTION and template.user is None:
        raise TemplateError(f"template {path.name} needs a <!-- user --> section")
    return template


def parse_template(version: str, text: str) -> Template:
    parts = SECTION_RE.split(text)
    # parts: [preamble, name, body, name, body, ...]
    sections: dict[str, str] = {}
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i]] = parts[i + 1].strip("\n")
    if "system" not in sections:
        raise TemplateError(f"template {version} has no <!-- system --> section")
    return Template(version=version, system=sections["system"], user=sections.get("user"))


def render(text: str, values: dict[str, Any]) -> str:
    def block(match: re.Match[str]) -> str:
        kind, key, body = match.group(1), match.group(2), match.group(3)
        truthy = bool(values.get(key))
        keep = truthy if kind == "#" else not truthy
        return render(body, values) if keep else ""

    out = BLOCK_RE.sub(block, text)

    def var(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise TemplateError(f"template placeholder has no value: {key}")
        value = values[key]
        return "" if value is None or isinstance(value, bool) else str(value)

    out = VAR_RE.sub(var, out)
    return re.sub(r"\n{3,}", "\n\n", out).strip() + "\n"


class PromptAssembler:
    def __init__(self, prompt_dir: Path) -> None:
        self._templates: dict[str, Template] = {}
        for key in PROMPT_KEYS:
            self._templates[key] = load_prompt(key, prompt_dir)

    def version(self, key: str) -> str:
        return self._templates[key].version

    def chat(
        self,
        *,
        character: dict[str, str],
        history: list[Message],
        summary: str,
        user_input: str,
        locale: str,
        adult_mode: bool,
    ) -> AssembledPrompt:
        template = self._templates["chat"]
        system = render(
            template.system,
            {**character, "locale": locale, "adult_mode": adult_mode, "summary": summary},
        )
        messages = [*history, Message(role="user", content=user_input)]
        return AssembledPrompt(prompt_version=template.version, system=system, messages=messages)

    def compact(self, *, summary: str, history: list[Message], locale: str) -> AssembledPrompt:
        template = self._templates["compact"]
        if template.user is None:
            raise TemplateError(f"template {template.version} needs a <!-- user --> section")
        lines = "\n".join(f"{m.role}: {m.content}" for m in history)
        values = {"locale": locale, "summary": summary, "history": lines}
        system = render(template.system, values)
        user = render(template.user, values)
        return AssembledPrompt(prompt_version=template.version, system=system, messages=[Message("user", user)])
