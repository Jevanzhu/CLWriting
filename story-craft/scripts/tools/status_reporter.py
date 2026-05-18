#!/usr/bin/env python3
"""Project status report for story-craft."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from tools.quality_trend_report import QualityTrendReporter


class StatusReporter:
    """Summarize project progress and medium-mode maintenance state."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "StatusReporter":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def build(self) -> dict[str, Any]:
        state = StateManager(self.config).get_full_state()
        memory = MemoryManager(self.config).load()
        quality = QualityTrendReporter(self.config).build()
        project = state.get("project", {})
        progress = state.get("progress", {})
        word_target = int(project.get("word_count_target") or 0)
        total_words = int(progress.get("total_words") or 0)
        percent = round(total_words / word_target * 100, 2) if word_target else 0
        open_foreshadowing = [
            item
            for item in memory.get("foreshadowing", []) or []
            if item.get("status") != "resolved"
        ]
        return {
            "project": project,
            "progress": {
                **progress,
                "word_target": word_target,
                "completion_percent": percent,
            },
            "memory_counts": {
                "characters": len(memory.get("characters", []) or []),
                "open_foreshadowing": len(open_foreshadowing),
                "world_rules": len(memory.get("world_rules", []) or []),
                "chapter_summaries": len(memory.get("chapter_summaries", []) or []),
            },
            "quality": quality,
            "maintenance": state.get("maintenance", {}),
            "medium_mode": {
                "enabled": project.get("tier") == "medium",
                "sqlite_index_exists": self.config.memory_db.exists(),
                "backup_count": len(list(self.config.backups_dir.glob("*.zip")))
                if self.config.backups_dir.exists()
                else 0,
            },
        }
