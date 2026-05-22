#!/usr/bin/env python3
"""State management for story-craft projects."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.security_utils import HAS_FILELOCK, FileLock, atomic_write_json, read_json_safe
from core.time_utils import now_utc_iso


SCHEMA_VERSION = "story-craft/v1"


def default_creative_constraints() -> dict[str, Any]:
    return {
        "one_liner": "",
        "anti_trope": "",
        "hard_constraints": [],
        "ending_constraint": "",
        "theme_statement": "",
        "protagonist_flaw": "",
        "antagonist_mirror": "",
        "opening_hook": "",
        "score": {
            "novelty": 0.0,
            "writability": 0.0,
            "ending_power": 0.0,
            "total": 0.0,
        },
    }


def default_state(
    *,
    title: str = "",
    genre: str = "",
    sub_genre: Optional[str] = None,
    word_count_target: int = 30000,
) -> dict[str, Any]:
    created_at = now_utc_iso()
    tier = "medium" if int(word_count_target or 0) > 50000 else "short"
    return {
        "schema_version": SCHEMA_VERSION,
        "project": {
            "title": title,
            "genre": genre,
            "sub_genre": sub_genre,
            "word_count_target": int(word_count_target or 0),
            "tier": tier,
            "created_at": created_at,
            "updated_at": created_at,
        },
        "progress": {
            "current_chapter": 0,
            "total_words": 0,
            "last_updated": created_at,
            "phase": "init",
        },
        "inspiration": {
            "source_type": "",
            "reference_work": None,
            "reference_author": None,
            "analysis_summary": "",
            "free_description": "",
        },
        "creative_constraints": default_creative_constraints(),
        "generated_files": {
            "outline": False,
            "worldbuilding": False,
            "protagonist_card": False,
            "protagonist_group": False,
            "female_lead_card": False,
            "antagonist_design": False,
            "power_system": False,
            "unique_advantage": False,
            "golden_finger": False,
            "genre_fusion_logic": False,
        },
        "narrative_meta": {
            "pov": "",
            "tense": "",
            "tone": "",
            "opening_type": "",
        },
        "maintenance": {
            "last_backup_at": "",
            "last_backup_file": "",
            "last_index_rebuild_at": "",
            "last_outline_revision_at": "",
            "last_outline_revision_file": "",
            "last_health_check_at": "",
        },
    }


def _merge_schema_defaults(base: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, item in value.items():
        if isinstance(item, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_schema_defaults(merged[key], item)
        else:
            merged[key] = deepcopy(item)
    return merged


class StateManager:
    """Project state manager."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()
        self._state: dict[str, Any] = self._load_state()
        self._pending: dict[str, dict[str, Any]] = {}

    @classmethod
    def from_project(cls, project_root: str | Path) -> "StateManager":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def get_project(self) -> dict[str, Any]:
        return deepcopy(self._state["project"])

    def get_progress(self) -> dict[str, Any]:
        return deepcopy(self._state["progress"])

    def get_creative_constraints(self) -> dict[str, Any]:
        return deepcopy(self._state["creative_constraints"])

    def get_generated_files(self) -> dict[str, Any]:
        return deepcopy(self._state["generated_files"])

    def get_full_state(self) -> dict[str, Any]:
        return deepcopy(self._state)

    def get_maintenance(self) -> dict[str, Any]:
        return deepcopy(self._state["maintenance"])

    def update_project(self, **kwargs: Any) -> None:
        updates = self._pending.setdefault("project", {})
        updates.update(kwargs)
        updates["updated_at"] = now_utc_iso()

    def update_progress(
        self,
        chapter: Optional[int] = None,
        words_delta: int = 0,
        phase: Optional[str] = None,
    ) -> None:
        updates = self._pending.setdefault("progress", {})
        if chapter is not None:
            updates["current_chapter"] = int(chapter)
        if words_delta:
            updates["_words_delta"] = int(updates.get("_words_delta", 0)) + int(words_delta)
        if phase is not None:
            updates["phase"] = phase
        updates["last_updated"] = now_utc_iso()

    def set_creative_constraints(self, constraints: dict[str, Any]) -> None:
        self._pending["creative_constraints"] = deepcopy(constraints)

    def mark_file_generated(self, file_key: str) -> None:
        updates = self._pending.setdefault("generated_files", {})
        updates[file_key] = True

    def update_maintenance(self, **kwargs: Any) -> None:
        updates = self._pending.setdefault("maintenance", {})
        updates.update(kwargs)

    def flush(self) -> None:
        lock = None
        if HAS_FILELOCK:
            lock_path = self.config.state_file.with_suffix(
                self.config.state_file.suffix + ".lock"
            )
            lock = FileLock(str(lock_path), timeout=10)
            lock.acquire()

        try:
            disk_state = self._ensure_state_schema(
                read_json_safe(self.config.state_file, default_state())
            )
            for section, updates in self._pending.items():
                updates_to_apply = deepcopy(updates)
                if section == "progress":
                    words_delta = int(updates_to_apply.pop("_words_delta", 0))
                    if words_delta:
                        current_words = int(
                            disk_state.get("progress", {}).get("total_words", 0)
                        )
                        updates_to_apply["total_words"] = current_words + words_delta
                if isinstance(disk_state.get(section), dict) and isinstance(updates, dict):
                    disk_state[section].update(updates_to_apply)
                else:
                    disk_state[section] = updates_to_apply
            disk_state = self._ensure_state_schema(disk_state)
            atomic_write_json(self.config.state_file, disk_state, use_lock=False, backup=True)
            self._state = disk_state
            self._pending.clear()
        finally:
            if lock is not None:
                lock.release()

    def _load_state(self) -> dict[str, Any]:
        raw = read_json_safe(self.config.state_file, default_state())
        return self._ensure_state_schema(raw)

    def _ensure_state_schema(self, state: dict[str, Any]) -> dict[str, Any]:
        base = default_state()
        merged = _merge_schema_defaults(base, state) if isinstance(state, dict) else base
        merged["schema_version"] = SCHEMA_VERSION
        merged.setdefault("project", {})
        merged.setdefault("progress", {})
        merged["project"].setdefault("updated_at", now_utc_iso())
        merged["progress"].setdefault("last_updated", now_utc_iso())
        return merged
