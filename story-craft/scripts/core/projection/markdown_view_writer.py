#!/usr/bin/env python3
"""Markdown read-model projection writer."""

from __future__ import annotations

from collections.abc import Iterable
import shutil
from typing import Any

from core.commit_store import CommitStore
from core.projection.base import ProjectionResult, ProjectionWriter
from core.security_utils import atomic_write_text, sanitize_filename
from core.types import AcceptedEvent, ChapterCommit, EntityDelta, StateDelta


class MarkdownViewProjectionWriter(ProjectionWriter):
    """Render project-root markdown views from chapter commits."""

    name = "markdown_view"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )
        _render_commit_views(self.config, _accepted_commits_with_current(self.config, commit))
        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=False,
            detail="markdown views updated",
        )

    def rebuild_all(self, commits: Iterable[ChapterCommit]) -> ProjectionResult:
        accepted = [commit for commit in commits if self.should_run(commit)]
        shutil.rmtree(self.config.settings_view_dir, ignore_errors=True)
        shutil.rmtree(self.config.tracking_dir, ignore_errors=True)
        _render_commit_views(self.config, accepted)
        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=False,
            detail=f"markdown views rebuilt from {len(accepted)} commits",
        )


def _accepted_commits_with_current(config, commit: ChapterCommit) -> list[ChapterCommit]:
    commits_by_chapter: dict[int, ChapterCommit] = {}
    for stored in CommitStore(config).iter_all():
        if stored.get("status") == "rejected":
            continue
        chapter = _commit_chapter(stored)
        if chapter:
            commits_by_chapter[chapter] = stored

    chapter = _commit_chapter(commit)
    if chapter:
        commits_by_chapter[chapter] = commit
    return [commits_by_chapter[key] for key in sorted(commits_by_chapter)]


def _commit_chapter(commit: ChapterCommit) -> int:
    try:
        return int(commit.get("chapter") or 0)
    except (TypeError, ValueError):
        return 0


def _render_commit_views(config, commits: list[ChapterCommit]) -> None:
    entity_deltas: list[EntityDelta] = []
    state_deltas: list[StateDelta] = []
    world_rules: list[dict[str, Any]] = []
    events: list[AcceptedEvent] = []
    summaries: list[str] = []
    dominant_strands: list[str] = []

    for commit in commits:
        entity_deltas.extend(commit.get("entity_deltas", []) or [])
        state_deltas.extend(commit.get("state_deltas", []) or [])
        world_rules.extend(commit.get("world_rules", []) or [])
        events.extend(commit.get("accepted_events", []) or [])
        summary = str(commit.get("summary_text") or "")
        if summary:
            summaries.append(f"- 第{int(commit.get('chapter') or 0):03d}章：{summary}")
        dominant = str(commit.get("dominant_strand") or "")
        if dominant:
            dominant_strands.append(f"- 第{int(commit.get('chapter') or 0):03d}章：{dominant}")

    _write_entity_views(config, entity_deltas, state_deltas)
    _write_world_views(config, world_rules)
    _write_tracking_views(config, events, state_deltas, summaries, dominant_strands)


def _write_entity_views(
    config,
    entity_deltas: list[EntityDelta],
    state_deltas: list[StateDelta],
) -> None:
    states_by_entity: dict[str, list[StateDelta]] = {}
    for delta in state_deltas:
        entity_id = str(delta.get("entity_id") or "")
        if entity_id:
            states_by_entity.setdefault(entity_id, []).append(delta)

    for entity in entity_deltas:
        entity_type = str(entity.get("entity_type") or "")
        if entity_type not in {"角色", "character", "势力", "faction"}:
            continue
        name = str(entity.get("name") or entity.get("entity_id") or "未命名")
        directory = "角色" if entity_type in {"角色", "character"} else "势力"
        path = config.settings_view_dir / directory / f"{sanitize_filename(name)}.md"
        atomic_write_text(path, _render_entity(entity, states_by_entity), use_lock=True, backup=True)


def _render_entity(
    entity: EntityDelta,
    states_by_entity: dict[str, list[StateDelta]],
) -> str:
    entity_id = str(entity.get("entity_id") or "")
    lines = [
        f"# {entity.get('name') or entity_id or '未命名'}",
        "",
        f"- ID：{entity_id or '未记录'}",
        f"- 类型：{entity.get('entity_type') or '未记录'}",
        f"- 角色：{entity.get('role') or '未记录'}",
        f"- 层级：{entity.get('tier') or '未记录'}",
        f"- 操作：{entity.get('operation') or '未记录'}",
        "",
        "## 状态变化",
    ]
    states = states_by_entity.get(entity_id, [])
    if not states:
        lines.append("- 未记录")
    for state in states:
        lines.append(
            f"- 第{int(state.get('chapter') or 0):03d}章 "
            f"{state.get('field') or '状态'}：{state.get('old') or '未记录'} -> {state.get('new') or '未记录'}"
        )
    lines.append("")
    return "\n".join(lines)


def _write_world_views(config, world_rules: list[dict[str, Any]]) -> None:
    for index, rule in enumerate(world_rules, start=1):
        title = str(rule.get("id") or rule.get("title") or f"world_rule_{index:03d}")
        path = config.settings_view_dir / "世界观" / f"{sanitize_filename(title)}.md"
        lines = [
            f"# {title}",
            "",
            str(rule.get("rule") or rule.get("content") or rule),
            "",
        ]
        atomic_write_text(path, "\n".join(lines), use_lock=True, backup=True)


def _write_tracking_views(
    config,
    events: list[AcceptedEvent],
    state_deltas: list[StateDelta],
    summaries: list[str],
    dominant_strands: list[str],
) -> None:
    atomic_write_text(
        config.tracking_dir / "上下文.md",
        _context_tracking(summaries, dominant_strands),
        use_lock=True,
        backup=True,
    )
    atomic_write_text(
        config.tracking_dir / "伏笔.md",
        _loop_tracking(events),
        use_lock=True,
        backup=True,
    )
    atomic_write_text(
        config.tracking_dir / "时间线.md",
        _timeline_tracking(events),
        use_lock=True,
        backup=True,
    )
    atomic_write_text(
        config.tracking_dir / "角色状态.md",
        _state_tracking(state_deltas),
        use_lock=True,
        backup=True,
    )


def _context_tracking(summaries: list[str], dominant_strands: list[str]) -> str:
    lines = ["# 上下文", "", "## 章节摘要"]
    lines.extend(summaries or ["- 未记录"])
    lines.extend(["", "## 主导叙事线"])
    lines.extend(dominant_strands or ["- 未记录"])
    lines.append("")
    return "\n".join(lines)


def _loop_tracking(events: list[AcceptedEvent]) -> str:
    lines = ["# 伏笔", "", "## 新增"]
    created = [
        event for event in events if event.get("event_type") == "open_loop_created"
    ]
    closed = [event for event in events if event.get("event_type") == "open_loop_closed"]
    lines.extend(_payload_lines(created) or ["- 未记录"])
    lines.extend(["", "## 回收"])
    lines.extend(_payload_lines(closed) or ["- 未记录"])
    lines.append("")
    return "\n".join(lines)


def _timeline_tracking(events: list[AcceptedEvent]) -> str:
    lines = ["# 时间线", ""]
    timeline = [
        event for event in events if event.get("event_type") == "timeline_advanced"
    ]
    lines.extend(_payload_lines(timeline) or ["- 未记录"])
    lines.append("")
    return "\n".join(lines)


def _state_tracking(state_deltas: list[StateDelta]) -> str:
    lines = ["# 角色状态", ""]
    if not state_deltas:
        lines.append("- 未记录")
    for state in state_deltas:
        lines.append(
            f"- 第{int(state.get('chapter') or 0):03d}章 {state.get('entity_id') or '未知实体'} "
            f"{state.get('field') or '状态'}：{state.get('old') or '未记录'} -> {state.get('new') or '未记录'}"
        )
    lines.append("")
    return "\n".join(lines)


def _payload_lines(events: list[AcceptedEvent]) -> list[str]:
    lines: list[str] = []
    for event in events:
        payload = event.get("payload") or {}
        label = payload.get("content") or payload.get("summary") or payload.get("rule")
        if not label and payload.get("events"):
            label = "；".join(str(item) for item in payload["events"] if item)
        if not label:
            label = payload.get("id") or event.get("entity_id") or "未记录"
        lines.append(f"- 第{int(event.get('chapter') or 0):03d}章：{label}")
    return lines
