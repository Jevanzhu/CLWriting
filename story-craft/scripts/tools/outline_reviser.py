#!/usr/bin/env python3
"""Mid-project outline revision suggestions."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import sanitize_filename
from core.state_manager import StateManager
from core.time_utils import now_utc_iso, now_utc_stamp
from tools.quality_trend_report import QualityTrendReporter


class OutlineReviser:
    """Write a markdown revision note without changing the outline directly."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "OutlineReviser":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def suggest(self, chapter: int, note: str = "") -> dict[str, Any]:
        memory = MemoryManager(self.config).load()
        quality = QualityTrendReporter(self.config).build()
        state = StateManager(self.config).get_full_state()
        target = self.config.outline_dir / f"中期修正建议-{now_utc_stamp()}-{sanitize_filename(str(chapter))}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        content = self._render_markdown(
            chapter=int(chapter),
            note=note,
            state=state,
            memory=memory,
            quality=quality,
        )
        target.write_text(content, encoding="utf-8")

        manager = StateManager(self.config)
        manager.update_maintenance(
            last_outline_revision_at=now_utc_iso(),
            last_outline_revision_file=str(target),
        )
        manager.flush()
        return {
            "revision_file": str(target),
            "open_foreshadowing_count": len(
                [
                    item
                    for item in memory.get("foreshadowing", []) or []
                    if item.get("status") != "resolved"
                ]
            ),
            "risk_flags": quality.get("risk_flags", []),
        }

    def _render_markdown(
        self,
        *,
        chapter: int,
        note: str,
        state: dict[str, Any],
        memory: dict[str, Any],
        quality: dict[str, Any],
    ) -> str:
        project = state.get("project", {})
        progress = state.get("progress", {})
        open_foreshadowing = [
            item
            for item in memory.get("foreshadowing", []) or []
            if item.get("status") != "resolved"
        ]
        lines = [
            f"# 中期大纲修正建议：第{chapter:02d}章",
            "",
            "## 项目状态",
            "",
            f"- 标题：{project.get('title', '')}",
            f"- 当前字数：{progress.get('total_words', 0)} / {project.get('word_count_target', 0)}",
            f"- 当前章节：{progress.get('current_chapter', 0)}",
            "",
            "## 修正触发原因",
            "",
            note or "进入中篇推进阶段，需要核对主线、伏笔和节奏。",
            "",
            "## 需要优先回收的伏笔",
            "",
        ]
        if open_foreshadowing:
            for item in open_foreshadowing[:10]:
                lines.append(
                    f"- `{item.get('id', '')}` [{item.get('urgency', 'low')}] "
                    f"{item.get('content', item.get('title', ''))}"
                )
        else:
            lines.append("- 当前没有未回收伏笔。")
        lines.extend(["", "## 质量趋势提醒", ""])
        risk_flags = quality.get("risk_flags", [])
        if risk_flags:
            lines.extend(f"- {flag}" for flag in risk_flags)
        else:
            lines.append("- 暂无明显质量趋势风险。")
        lines.extend(
            [
                "",
                "## 建议动作",
                "",
                "- 核对下一阶段主线是否仍服务结尾回收。",
                "- 将高紧急度伏笔分配到明确章节。",
                "- 删除不服务结尾的新增副线。",
                "- 对重复 warning 对应的写法建立 `/story-learn` 规则。",
                "",
            ]
        )
        return "\n".join(lines)
