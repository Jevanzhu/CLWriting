#!/usr/bin/env python3
"""Deterministic deployment helpers for story-craft Claude Code assets."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import re
from pathlib import Path
from typing import Any

from core.config import StoryCraftConfig
from core.contract_store import ContractStore


AGENTS_VERSION = 9
SETUP_SKILL_VERSION = "4.0.0"
TARGET_CLI = "claude-code"
RESOLVER_STRATEGY = "project-root-state-json"

OWNER_MANAGED = "managed"
OWNER_USER = "user"
OWNER_SHARED = "shared"
MERGE_OVERWRITE = "overwrite"
MERGE_MERGE = "merge"
MERGE_SKIP_IF_EXISTS = "skip-if-exists"

SHORT_AGENT_NAMES = (
    "context-agent",
    "narrative-writer",
    "reviewer",
    "data-agent",
)
LONG_AGENT_NAMES = (
    "story-architect",
    "character-designer",
    "context-agent",
    "narrative-writer",
    "reviewer",
    "consistency-checker",
    "data-agent",
    "story-explorer",
    "story-researcher",
)
COMMAND_NAMES = (
    "story-init",
    "story-review",
    "story-deslop",
    "story-repair",
    "story-import",
    "story-query",
    "story-learn",
    "story-preflight",
    "story-long-write",
    "story-long-plan",
    "story-long-analyze",
    "story-long-scan",
    "story-short-write",
)
HOOK_TEMPLATE_FILES = (
    "session-start.sh",
    "session-end.sh",
    "pre-compact.sh",
    "post-compact.sh",
    "detect-story-gaps.sh",
    "validate-story-commit.sh",
    "lib/common.sh",
    "lib/sentinel.sh",
)


@dataclass(frozen=True)
class Asset:
    source: str
    target: str
    owner_class: str
    merge_mode: str
    validation: str


def deployment_manifest(project_type: str) -> list[Asset]:
    """Return the deployment manifest for a short or long project."""
    track = _normalize_project_type(project_type)
    agents = SHORT_AGENT_NAMES if track == "short" else LONG_AGENT_NAMES
    assets: list[Asset] = []

    for relative_path in HOOK_TEMPLATE_FILES:
        assets.append(
            Asset(
                source=f"skills/story-init/references/templates/hooks/{relative_path}",
                target=f".claude/hooks/{relative_path}",
                owner_class=OWNER_MANAGED,
                merge_mode=MERGE_OVERWRITE,
                validation="bash -n" if relative_path.endswith(".sh") else "source-exists",
            )
        )

    for agent_name in agents:
        assets.append(
            Asset(
                source=f"agents/{agent_name}.md",
                target=f".claude/agents/story-craft/{agent_name}.md",
                owner_class=OWNER_MANAGED,
                merge_mode=MERGE_OVERWRITE,
                validation="frontmatter:name-description-tools-model",
            )
        )

    for command_name in COMMAND_NAMES:
        assets.append(
            Asset(
                source=f"commands/{command_name}.md",
                target=f".claude/commands/{command_name}.md",
                owner_class=OWNER_MANAGED,
                merge_mode=MERGE_OVERWRITE,
                validation="frontmatter:description",
            )
        )

    assets.extend(
        [
            Asset(
                source="references/",
                target=".claude/story-craft/references/",
                owner_class=OWNER_SHARED,
                merge_mode=MERGE_OVERWRITE,
                validation="directory-exists",
            ),
            Asset(
                source="skills/story-init/references/templates/settings-hooks.json",
                target=".claude/settings.json",
                owner_class=OWNER_SHARED,
                merge_mode=MERGE_MERGE,
                validation="json:hooks",
            ),
            Asset(
                source="skills/story-init/references/templates/CLAUDE.md",
                target="CLAUDE.md",
                owner_class=OWNER_SHARED,
                merge_mode=MERGE_MERGE,
                validation="markdown:managed-sections",
            ),
            Asset(
                source="deployment-sentinel",
                target=".story/contracts/deployment.json",
                owner_class=OWNER_MANAGED,
                merge_mode=MERGE_OVERWRITE,
                validation="json:deployment",
            ),
        ]
    )
    return assets


def merge_claude_md(existing: str, managed_sections: dict[str, str]) -> str:
    """Merge managed ## sections while preserving user-only sections."""
    sections = _split_markdown_sections(existing)
    seen_managed: set[str] = set()
    output: list[str] = []

    preamble = sections[0][1] if sections and sections[0][0] is None else ""
    if preamble.strip():
        output.append(preamble.strip())

    for heading, body in sections:
        if heading is None:
            continue
        if heading in managed_sections:
            if heading in seen_managed:
                continue
            output.append(_render_markdown_section(heading, managed_sections[heading]))
            seen_managed.add(heading)
        else:
            output.append(_render_markdown_section(heading, body))

    for heading, body in managed_sections.items():
        if heading not in seen_managed:
            output.append(_render_markdown_section(heading, body))
            seen_managed.add(heading)

    return "\n\n".join(part.strip() for part in output if part.strip()) + "\n"


def merge_settings(existing: dict[str, Any], managed_hooks: dict[str, Any]) -> dict[str, Any]:
    """Merge Claude settings hooks by command while preserving user keys."""
    merged = deepcopy(existing)
    existing_hooks = deepcopy(existing.get("hooks") if isinstance(existing.get("hooks"), dict) else {})
    incoming_hooks = deepcopy(managed_hooks.get("hooks") if isinstance(managed_hooks.get("hooks"), dict) else managed_hooks)
    merged_hooks: dict[str, Any] = deepcopy(existing_hooks)

    for event_name, managed_entries in incoming_hooks.items():
        managed_entries = _as_list(managed_entries)
        managed_commands = _hook_commands(managed_entries)
        preserved_entries = _without_hook_commands(_as_list(existing_hooks.get(event_name)), managed_commands)
        merged_hooks[event_name] = preserved_entries + managed_entries

    merged["hooks"] = merged_hooks
    return merged


def read_deployment(config: StoryCraftConfig) -> dict[str, Any]:
    """Read deployment sentinel from ContractStore."""
    return ContractStore(config).read_deployment()


def write_deployment(
    config: StoryCraftConfig,
    *,
    agents_version: int,
    setup_skill_version: str,
    target_cli: str,
    project_type: str,
    resolver_strategy: str,
    references_dir: str,
) -> Path:
    """Write deployment sentinel through ContractStore."""
    payload = {
        "schema_version": "story-craft/deployment-v1",
        "agents_version": int(agents_version),
        "setup_skill_version": str(setup_skill_version),
        "target_cli": str(target_cli),
        "project_type": _normalize_project_type(project_type),
        "resolver_strategy": str(resolver_strategy),
        "references_dir": str(references_dir),
    }
    return ContractStore(config).write_deployment(payload)


def needs_redeploy(current: dict[str, Any], target_agents_version: int) -> bool:
    """Return whether deployment should be refreshed for target agent version."""
    if not isinstance(current, dict):
        return True
    current_version = _version_number(current.get("agents_version"))
    return current_version is None or current_version < int(target_agents_version)


def _normalize_project_type(project_type: str) -> str:
    value = str(project_type or "").strip()
    if value not in {"short", "long"}:
        raise ValueError("project_type 必须是 short 或 long")
    return value


def _split_markdown_sections(text: str) -> list[tuple[str | None, str]]:
    lines = str(text or "").splitlines()
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in lines:
        if line.startswith("## "):
            sections.append((line[3:].strip(), []))
            continue
        sections[-1][1].append(line)
    return [(heading, "\n".join(body).strip()) for heading, body in sections]


def _render_markdown_section(heading: str, body: str) -> str:
    clean_body = str(body or "").strip()
    return f"## {heading}\n\n{clean_body}" if clean_body else f"## {heading}"


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _hook_commands(entries: list[Any]) -> set[str]:
    commands: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for hook in _as_list(entry.get("hooks")):
            if isinstance(hook, dict) and isinstance(hook.get("command"), str):
                commands.add(hook["command"])
    return commands


def _without_hook_commands(entries: list[Any], blocked_commands: set[str]) -> list[Any]:
    preserved: list[Any] = []
    for entry in entries:
        if not isinstance(entry, dict):
            preserved.append(entry)
            continue
        clone = deepcopy(entry)
        hooks = []
        for hook in _as_list(clone.get("hooks")):
            if not isinstance(hook, dict):
                hooks.append(hook)
                continue
            command = hook.get("command")
            if not isinstance(command, str) or command not in blocked_commands:
                hooks.append(hook)
        clone["hooks"] = hooks
        if hooks or any(key != "hooks" for key in clone):
            preserved.append(clone)
    return preserved


def _version_number(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    match = re.search(r"\d+", str(value or ""))
    return int(match.group(0)) if match else None
