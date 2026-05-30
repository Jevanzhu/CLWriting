#!/usr/bin/env python3
"""Summary projection writer."""

from __future__ import annotations

from collections.abc import Iterable
import shutil

from core.chapter_paths import summary_file_name
from core.projection.base import ProjectionResult, ProjectionWriter
from core.security_utils import atomic_write_text
from core.types import ChapterCommit


class SummaryProjectionWriter(ProjectionWriter):
    """Render chapter summary projection markdown."""

    name = "summary"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )

        try:
            chapter = int(commit["chapter"])
        except (KeyError, TypeError, ValueError) as exc:
            return ProjectionResult(
                name=self.name,
                ok=False,
                skipped=False,
                detail=f"invalid summary projection commit: {exc}",
            )

        path = self.config.summaries_dir / summary_file_name(chapter)
        atomic_write_text(path, _render_summary(commit), use_lock=True, backup=True)
        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=False,
            detail=str(path),
        )

    def rebuild_all(self, commits: Iterable[ChapterCommit]) -> ProjectionResult:
        items = [commit for commit in commits if self.should_run(commit)]
        shutil.rmtree(self.config.summaries_dir, ignore_errors=True)
        results = [self.write(commit) for commit in items]
        failed = [result for result in results if not result.ok]
        return ProjectionResult(
            name=self.name,
            ok=not failed,
            skipped=not items,
            detail=(
                f"replayed {len(items)} accepted commits"
                if not failed
                else f"{len(failed)} replay failures"
            ),
        )


def _render_summary(commit: ChapterCommit) -> str:
    chapter = int(commit.get("chapter") or 0)
    chapter_summary = commit.get("chapter_summary") or {}
    title = str(chapter_summary.get("title") or commit.get("title") or f"第{chapter:04d}章")
    summary_text = str(commit.get("summary_text") or chapter_summary.get("summary") or "")
    key_events = [str(item) for item in chapter_summary.get("key_events", []) or []]
    characters = [
        str(item) for item in chapter_summary.get("characters_appeared", []) or []
    ]
    hook_type = str(chapter_summary.get("hook_type") or "")
    hook_strength = str(chapter_summary.get("hook_strength") or "")

    lines = [
        f"# 第{chapter:04d}章 {title}",
        "",
        "## 摘要",
        summary_text or "未记录",
        "",
        "## 钩子",
        f"- 类型：{hook_type or '未记录'}",
        f"- 强度：{hook_strength or '未记录'}",
        "",
        "## 关键事件",
    ]
    if key_events:
        lines.extend(f"- {item}" for item in key_events)
    else:
        lines.append("- 未记录")
    lines.append("")
    lines.append("## 出场角色")
    if characters:
        lines.extend(f"- {item}" for item in characters)
    else:
        lines.append("- 未记录")
    lines.append("")
    return "\n".join(lines)
