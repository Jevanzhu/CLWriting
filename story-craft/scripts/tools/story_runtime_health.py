#!/usr/bin/env python3
"""Runtime health checks for story-craft projects."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.runtime_diagnostics import build_runtime_diagnostics
from core.state_manager import StateManager
from tools.entity_linker import build_entity_graph


class StoryRuntimeHealth:
    """Validate files, memory pressure, and medium-mode maintenance signals."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "StoryRuntimeHealth":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def check(self) -> dict[str, Any]:
        blockers: list[str] = []
        warnings: list[str] = []
        info: list[str] = []

        if not self.config.state_file.exists():
            blockers.append("缺少 .story/state.json。")
        if not self.config.memory_file.exists():
            blockers.append("缺少 .story/memory.json。")
        if not (self.config.outline_dir / "总纲.md").exists():
            warnings.append("缺少 大纲/总纲.md。")
        if not (self.config.settings_dir / "世界观.md").exists():
            warnings.append("缺少 设定集/世界观.md。")

        state = StateManager(self.config).get_full_state()
        memory = MemoryManager(self.config).load()
        project = state.get("project", {})
        progress = state.get("progress", {})
        open_high = [
            item
            for item in memory.get("foreshadowing", []) or []
            if item.get("status") != "resolved" and item.get("urgency") == "high"
        ]
        if len(open_high) >= 3:
            warnings.append(f"高紧急度伏笔债较多：{len(open_high)} 条。")
        if project.get("tier") == "medium" and not self.config.memory_db.exists():
            warnings.append("中篇项目尚未重建 SQLite 查询缓存。")
        if project.get("tier") == "medium":
            backup_count = (
                len(list(self.config.backups_dir.glob("*.zip")))
                if self.config.backups_dir.exists()
                else 0
            )
            if backup_count == 0:
                warnings.append("中篇项目尚未创建备份快照。")
        graph = build_entity_graph(memory)
        if graph["orphan_edges"]:
            warnings.append(f"存在未匹配目标的角色关系：{len(graph['orphan_edges'])} 条。")

        try:
            runtime = build_runtime_diagnostics()
            warnings.extend(runtime.get("warnings") or [])
        except Exception:
            runtime = None

        info.append(f"当前章节：{progress.get('current_chapter', 0)}")
        info.append(f"累计字数：{progress.get('total_words', 0)}")
        info.append(f"角色数：{len(memory.get('characters', []) or [])}")

        health = {
            "ok": not blockers,
            "blockers": blockers,
            "warnings": warnings,
            "info": info,
            "counts": {
                "characters": len(memory.get("characters", []) or []),
                "foreshadowing": len(memory.get("foreshadowing", []) or []),
                "timeline": len(memory.get("timeline", []) or []),
                "chapter_summaries": len(memory.get("chapter_summaries", []) or []),
                "orphan_relationships": len(graph["orphan_edges"]),
            },
            "runtime": runtime,
        }

        if self.config.state_file.exists():
            manager = StateManager(self.config)
            manager.update_maintenance(
                last_health_check_at=datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
            manager.flush()
        return health
