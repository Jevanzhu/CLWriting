#!/usr/bin/env python3
"""Writing context assembly for story-craft."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from core.chapter_paths import iter_chapter_record_files
from core.config import StoryCraftConfig
from core.directive_resolver import resolve_chapter_directive
from core.memory_manager import MemoryManager
from core.security_utils import read_json_safe
from core.state_manager import StateManager
from tools.genre_profile_builder import build_genre_hints
from tools.project_memory import get_learning_patterns, rank_learning_patterns
from tools.context_ranker import rank_context_items
from tools.writing_guidance_builder import (
    build_anti_ai_checklist,
    build_writing_checklist,
)

logger = logging.getLogger("core.context_manager")


class ContextManager:
    """Build structured context for chapter drafting."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()
        self.state = StateManager(self.config)
        self.memory = MemoryManager(self.config)

    @classmethod
    def from_project(cls, project_root: str | Path) -> "ContextManager":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def build_context(self, chapter: int, template: str = "default") -> dict[str, Any]:
        """Build the four-section writing context."""
        chapter_num = int(chapter)
        memory = self.memory.load()
        actual_timeline = [
            item
            for item in memory.get("timeline", [])
            if not item.get("planned") and int(item.get("chapter") or 0) < chapter_num
        ]
        payload = {
            "chapter": chapter_num,
            "template": template,
            "core": self._build_core(chapter_num, actual_timeline),
            "scene": self._build_scene(chapter_num, actual_timeline),
            "continuity": self._build_continuity(chapter_num),
            "guidance": self._build_guidance(chapter_num),
        }
        project = self.state.get_project()
        if project.get("tier") == "medium":
            payload["ranked_context"] = rank_context_items(
                memory,
                chapter=chapter_num,
                budget=20,
            )
        logger.debug("context built for chapter %d, timeline=%d entries", chapter_num, len(actual_timeline))
        return payload

    def _build_core(self, chapter: int, timeline: list[dict[str, Any]]) -> dict[str, Any]:
        state = self.state.get_full_state()
        project = state.get("project", {})
        constraints = state.get("creative_constraints", {})
        directive = resolve_chapter_directive(self.config, chapter)
        return {
            "project": project,
            "creative_constraints": constraints,
            "chapter_goal": directive["chapter_directive"],
            "chapter_outline": directive["chapter_directive"],
            "must_cover": directive["must_cover"],
            "chapter_title": directive["title"],
            "planned_word_count": directive["planned_word_count"],
            "directive_source": directive["source"],
            "forbidden": self._build_forbidden_list(constraints),
            "time_anchor": self._latest_time_anchor(timeline),
        }

    def _build_scene(self, chapter: int, timeline: list[dict[str, Any]]) -> dict[str, Any]:
        recent_start = max(0, chapter - self.config.context_recent_summaries)
        active_since = max(0, chapter - 3)
        active_characters = self.memory.get_active_characters(active_since)
        return {
            "active_characters": active_characters[: self.config.context_max_active_characters],
            "recent_summaries": self.memory.get_chapter_summaries(recent_start),
            "recent_timeline": timeline[-self.config.context_recent_timeline :],
            "location": self._infer_latest_location(timeline),
            "time_constraint": self._infer_time_constraint(chapter, timeline),
        }

    def _build_continuity(self, chapter: int) -> dict[str, Any]:
        foreshadowing = self.memory.get_open_foreshadowing()[
            : self.config.context_max_urgent_foreshadowing
        ]
        return {
            "last_chapter_hook": self._last_chapter_hook(chapter),
            "unresolved_foreshadowing": foreshadowing,
            "world_rules": self.memory.get_world_rules(),
        }

    def _build_guidance(self, chapter: int) -> dict[str, Any]:
        project = self.state.get_project()
        learning_patterns = rank_learning_patterns(
            get_learning_patterns(self.config.project_root)
        )
        review_history = self._load_review_history()
        genre_profile = build_genre_hints(
            str(project.get("genre") or ""),
            project.get("sub_genre"),
        )
        return {
            "genre_profile": genre_profile,
            "learning_patterns": learning_patterns,
            "writing_checklist": build_writing_checklist(
                chapter,
                review_history,
                learning_patterns,
            ),
            "anti_ai_checklist": build_anti_ai_checklist(),
            "warnings": self._recent_review_warnings(review_history),
            "style_notes": self._style_notes(),
        }

    def _read_text(self, path: Path) -> str:
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def _build_forbidden_list(self, constraints: dict[str, Any]) -> list[str]:
        forbidden = []
        anti_trope = constraints.get("anti_trope")
        if anti_trope:
            forbidden.append(f"避免套路：{anti_trope}")
        hard_constraints = constraints.get("hard_constraints")
        if isinstance(hard_constraints, list):
            forbidden.extend(str(item) for item in hard_constraints if item)
        return forbidden

    def _latest_time_anchor(self, timeline: list[dict[str, Any]]) -> str:
        if not timeline:
            return ""
        latest = timeline[-1]
        return str(latest.get("time_marker") or latest.get("time_elapsed") or "")

    def _infer_latest_location(self, timeline: list[dict[str, Any]]) -> str:
        if not timeline:
            return ""
        latest = timeline[-1]
        return str(latest.get("location") or "")

    def _infer_time_constraint(self, chapter: int, timeline: list[dict[str, Any]]) -> dict[str, Any]:
        latest = timeline[-1] if timeline else {}
        return {
            "chapter": chapter,
            "previous_time_marker": latest.get("time_marker", ""),
            "previous_time_delta": latest.get("time_delta", ""),
        }

    def _last_chapter_hook(self, chapter: int) -> str:
        summaries = self.memory.get_chapter_summaries(max(0, chapter - 1))
        previous = [
            item for item in summaries if int(item.get("chapter") or 0) == chapter - 1
        ]
        if not previous:
            return ""
        item = previous[-1]
        return str(item.get("hook") or item.get("hook_type") or item.get("summary") or "")

    def _load_review_history(self) -> list[dict[str, Any]]:
        history: list[dict[str, Any]] = []
        for path in iter_chapter_record_files(config=self.config):
            payload = read_json_safe(path, {})
            if payload:
                history.append(payload)
        return history

    def _recent_review_warnings(self, review_history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        warnings: list[dict[str, Any]] = []
        for payload in review_history[-5:]:
            review = payload.get("review", {})
            for item in review.get("warnings", []) or []:
                if isinstance(item, dict):
                    warning = dict(item)
                else:
                    warning = {"description": str(item)}
                warning.setdefault("chapter", payload.get("chapter"))
                warnings.append(warning)
        return warnings

    def _style_notes(self) -> list[str]:
        notes = []
        settings_files = [
            self.config.settings_dir / "世界观.md",
            self.config.settings_dir / "主角卡.md",
            self.config.settings_dir / "独特优势.md",
        ]
        for path in settings_files:
            text = self._read_text(path).strip()
            if text:
                notes.append(f"{path.stem}已存在，写作时保持一致。")
        return notes
