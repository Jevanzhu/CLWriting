#!/usr/bin/env python3
"""Backup helpers for medium story-craft projects."""

from __future__ import annotations

import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from core.config import StoryCraftConfig
from core.security_utils import sanitize_filename
from core.state_manager import StateManager


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class BackupManager:
    """Create compact zip snapshots for project source files."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "BackupManager":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def create_backup(self, label: str = "manual") -> dict[str, object]:
        self.config.backups_dir.mkdir(parents=True, exist_ok=True)
        safe_label = sanitize_filename(label, max_length=40)
        backup_file = self.config.backups_dir / f"{now_stamp()}-{safe_label}.zip"
        files = list(self._iter_backup_files())
        with zipfile.ZipFile(backup_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in files:
                archive.write(path, path.relative_to(self.config.project_root).as_posix())

        state = StateManager(self.config)
        state.update_maintenance(
            last_backup_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            last_backup_file=str(backup_file),
        )
        state.flush()

        return {
            "backup_file": str(backup_file),
            "file_count": len(files),
            "bytes": backup_file.stat().st_size,
        }

    def _iter_backup_files(self) -> Iterable[Path]:
        roots = [
            self.config.story_dir,
            self.config.outline_dir,
            self.config.settings_dir,
            self.config.project_chapters_dir,
            self.config.review_dir,
        ]
        for root in roots:
            if not root.exists():
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file():
                    continue
                if self.config.backups_dir in path.parents:
                    continue
                if path.suffix in {".lock", ".tmp", ".bak"}:
                    continue
                yield path
