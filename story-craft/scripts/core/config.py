#!/usr/bin/env python3
"""Configuration for story-craft."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from core.runtime_compat import normalize_windows_path


@dataclass
class StoryCraftConfig:
    """story-craft runtime configuration."""

    project_root: Path = field(default_factory=lambda: Path.cwd())

    @property
    def story_dir(self) -> Path:
        return self.project_root / ".story"

    @property
    def state_file(self) -> Path:
        return self.story_dir / "state.json"

    @property
    def memory_file(self) -> Path:
        return self.story_dir / "memory.json"

    @property
    def learning_file(self) -> Path:
        return self.story_dir / "project_learning.json"

    @property
    def memory_db(self) -> Path:
        return self.story_dir / "memory.db"

    @property
    def chapters_dir(self) -> Path:
        return self.story_dir / "chapters"

    @property
    def backups_dir(self) -> Path:
        return self.story_dir / "backups"

    @property
    def project_chapters_dir(self) -> Path:
        return self.project_root / "正文"

    @property
    def settings_dir(self) -> Path:
        return self.project_root / "设定集"

    @property
    def outline_dir(self) -> Path:
        return self.project_root / "大纲"

    @property
    def review_dir(self) -> Path:
        return self.project_root / "审查报告"

    medium_threshold_chapters: int = 15
    context_recent_summaries: int = 5
    context_recent_timeline: int = 5
    context_max_active_characters: int = 10
    context_max_urgent_foreshadowing: int = 5
    chapter_pad_width: int = 2
    api_base_url: str = field(
        default_factory=lambda: os.getenv("STORYCRAFT_API_BASE_URL", "")
    )
    api_key: str = field(default_factory=lambda: os.getenv("STORYCRAFT_API_KEY", ""))
    api_max_retries: int = 3

    @property
    def use_sqlite(self) -> bool:
        return self.memory_db.exists()

    @classmethod
    def from_project_root(cls, root: str | Path) -> "StoryCraftConfig":
        project_root = normalize_windows_path(root).expanduser().resolve()
        return cls(project_root=project_root)

    def ensure_dirs(self) -> None:
        for path in (
            self.story_dir,
            self.chapters_dir,
            self.project_chapters_dir,
            self.settings_dir,
            self.outline_dir,
            self.review_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


def get_config(project_root: Optional[Path] = None) -> StoryCraftConfig:
    """Return a new config instance."""
    if project_root is not None:
        return StoryCraftConfig.from_project_root(project_root)
    return StoryCraftConfig(project_root=Path.cwd())


def set_project_root(project_root: str | Path) -> None:
    """Set STORYCRAFT_PROJECT_ROOT for the current process."""
    os.environ["STORYCRAFT_PROJECT_ROOT"] = str(
        normalize_windows_path(project_root).expanduser().resolve()
    )
