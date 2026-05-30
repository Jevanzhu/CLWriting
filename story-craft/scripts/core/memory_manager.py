#!/usr/bin/env python3
"""Runtime memory management for story-craft projects."""

from __future__ import annotations

from copy import deepcopy
import logging
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.security_utils import atomic_write_json, read_json_safe
from core.time_utils import now_utc_iso

logger = logging.getLogger("core.memory_manager")


def default_memory() -> dict[str, Any]:
    return {
        "last_updated": now_utc_iso(),
        "last_updated_chapter": 0,
        "characters": [],
        "foreshadowing": [],
        "timeline": [],
        "world_rules": [],
        "chapter_summaries": [],
    }


def _coerce_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _entity_identifier(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("id", "suggested_id", "name"):
            value = item.get(key)
            if value:
                return str(value)
        return ""
    if item is None:
        return ""
    return str(item)


def _timeline_entry_key(entry: dict[str, Any]) -> tuple[str, str, str] | None:
    if _coerce_positive_int(entry.get("chapter")) is not None:
        return None
    events = entry.get("events")
    if isinstance(events, list):
        events_key = "\n".join(str(event) for event in events)
    elif events is None:
        events_key = ""
    else:
        events_key = str(events)
    key = (
        events_key,
        str(entry.get("time_marker") or ""),
        str(entry.get("location") or ""),
    )
    return key if any(key) else None


def _events_chapter(events: list[dict[str, Any]]) -> int | None:
    for event in events or []:
        if isinstance(event, dict):
            chapter = _coerce_positive_int(event.get("chapter"))
            if chapter is not None:
                return chapter
    return None


class MemoryManager:
    """Runtime memory manager."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()
        self._memory = self._ensure_memory_schema(
            read_json_safe(self.config.memory_file, default_memory())
        )

    @classmethod
    def from_project(cls, project_root: str | Path) -> "MemoryManager":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def load(self) -> dict[str, Any]:
        self._memory = self._ensure_memory_schema(
            read_json_safe(self.config.memory_file, default_memory())
        )
        return deepcopy(self._memory)

    def save(self, memory: dict[str, Any]) -> None:
        self._memory = self._ensure_memory_schema(memory)
        self.flush()

    def get_characters(self, role: Optional[str] = None) -> list[dict[str, Any]]:
        chars = deepcopy(self._memory.get("characters", []))
        if role is None:
            return chars
        return [char for char in chars if char.get("role") == role]

    def get_active_characters(self, since_chapter: int) -> list[dict[str, Any]]:
        return [
            deepcopy(char)
            for char in self._memory.get("characters", [])
            if int(char.get("last_appearance_chapter") or 0) >= since_chapter
        ]

    def get_character(self, char_id: str) -> Optional[dict[str, Any]]:
        for char in self._memory.get("characters", []):
            if char.get("id") == char_id:
                return deepcopy(char)
        return None

    def upsert_character(self, char: dict[str, Any]) -> None:
        normalized = deepcopy(char)
        if "id" not in normalized and normalized.get("suggested_id"):
            normalized["id"] = normalized["suggested_id"]
        key = normalized.get("id") or normalized.get("name")
        if not key:
            raise ValueError("Character must include id or name")
        characters = self._memory.setdefault("characters", [])
        for index, existing in enumerate(characters):
            existing_key = existing.get("id") or existing.get("name")
            if existing_key == key:
                merged = deepcopy(existing)
                merged.update(normalized)
                characters[index] = merged
                return
        characters.append(normalized)

    def get_open_foreshadowing(self) -> list[dict[str, Any]]:
        priority = {"high": 0, "medium": 1, "low": 2}
        items = [
            deepcopy(item)
            for item in self._memory.get("foreshadowing", [])
            if item.get("status") != "resolved"
        ]
        return sorted(
            items,
            key=lambda item: (
                priority.get(str(item.get("urgency") or "low"), 2),
                int(item.get("planted_chapter") or 0),
            ),
        )

    def upsert_foreshadowing(self, item: dict[str, Any]) -> None:
        key = item.get("id")
        if not key:
            raise ValueError("Foreshadowing item must include id")
        items = self._memory.setdefault("foreshadowing", [])
        for index, existing in enumerate(items):
            if existing.get("id") == key:
                merged = deepcopy(existing)
                merged.update(deepcopy(item))
                items[index] = merged
                return
        items.append(deepcopy(item))

    def get_recent_timeline(self, chapters: int = 5) -> list[dict[str, Any]]:
        timeline = self._memory.get("timeline", [])
        return deepcopy(timeline[-chapters:] if chapters > 0 else timeline)

    def append_timeline_entry(self, entry: dict[str, Any]) -> None:
        timeline = self._memory.setdefault("timeline", [])
        chapter = _coerce_positive_int(entry.get("chapter"))
        if chapter is not None:
            normalized = deepcopy(entry)
            normalized["chapter"] = chapter
            for i, existing in enumerate(timeline):
                if _coerce_positive_int(existing.get("chapter")) == chapter:
                    timeline[i] = normalized
                    return
            timeline.append(normalized)
            return
        dedupe_key = _timeline_entry_key(entry)
        if dedupe_key is not None:
            for i, existing in enumerate(timeline):
                if _timeline_entry_key(existing) == dedupe_key:
                    timeline[i] = deepcopy(entry)
                    return
        timeline.append(deepcopy(entry))

    def get_world_rules(self) -> list[dict[str, Any]]:
        return deepcopy(self._memory.get("world_rules", []))

    def add_world_rule(self, rule: dict[str, Any]) -> None:
        rules = self._memory.setdefault("world_rules", [])
        rule_id = rule.get("id")
        if rule_id:
            for existing in rules:
                if existing.get("id") == rule_id:
                    existing.update(deepcopy(rule))
                    return
        rules.append(deepcopy(rule))

    def record_rule_violation(self, rule_id: str, violation: str) -> None:
        for rule in self._memory.get("world_rules", []):
            if rule.get("id") == rule_id:
                rule.setdefault("violations", []).append(violation)
                return
        raise KeyError(f"World rule not found: {rule_id}")

    def get_chapter_summaries(self, since_chapter: int = 0) -> list[dict[str, Any]]:
        return [
            deepcopy(summary)
            for summary in self._memory.get("chapter_summaries", [])
            if int(summary.get("chapter") or 0) >= since_chapter
        ]

    def append_chapter_summary(self, summary: dict[str, Any]) -> None:
        summaries = self._memory.setdefault("chapter_summaries", [])
        chapter = summary.get("chapter")
        if chapter is not None:
            for index, existing in enumerate(summaries):
                if int(existing.get("chapter") or 0) == int(chapter):
                    merged = deepcopy(existing)
                    merged.update(deepcopy(summary))
                    summaries[index] = merged
                    return
        summaries.append(deepcopy(summary))

    def apply_chapter_delta(self, delta: dict[str, Any]) -> None:
        timeline_entry = delta.get("timeline_entry") or {}
        chapter = _coerce_positive_int(delta.get("chapter")) or _coerce_positive_int(
            timeline_entry.get("chapter")
        ) or 0
        for char in delta.get("entities_new", []) or []:
            self.upsert_character(char)
            self._mark_character_appearance(
                str(char.get("id") or char.get("suggested_id") or char.get("name") or ""),
                chapter,
            )
        for item in delta.get("entities_appeared", []) or []:
            identifier = _entity_identifier(item)
            if identifier:
                self._mark_character_appearance(identifier, chapter)
        for change in delta.get("state_changes", []) or []:
            self._apply_state_change(change)
        for item in delta.get("new_foreshadowing", []) or []:
            self.upsert_foreshadowing(item)
        for item in delta.get("resolved_foreshadowing", []) or []:
            self._resolve_foreshadowing(item, chapter)
        for rule in delta.get("new_world_rules", []) or []:
            self.add_world_rule(rule)
        if delta.get("timeline_entry"):
            self.append_timeline_entry(delta["timeline_entry"])
        if delta.get("chapter_summary"):
            self.append_chapter_summary(delta["chapter_summary"])

        if chapter:
            self._memory["last_updated_chapter"] = chapter
        self._memory["last_updated"] = now_utc_iso()

    def apply_events(
        self,
        events: list[dict[str, Any]],
        *,
        chapter: int = 0,
        timeline_entry: dict[str, Any] | None = None,
        chapter_summary: dict[str, Any] | None = None,
    ) -> None:
        """Project accepted commit events directly into memory.json."""
        effective_chapter = _coerce_positive_int(chapter) or _events_chapter(events) or 0
        projected_timeline = deepcopy(timeline_entry or {})
        projected_summary = deepcopy(chapter_summary or {})

        for event in events or []:
            if not isinstance(event, dict):
                continue
            event_type = event.get("event_type")
            payload = deepcopy(event.get("payload") or {})

            if event_type == "entity_introduced":
                if event.get("entity_id") and "id" not in payload:
                    payload["id"] = event["entity_id"]
                self.upsert_character(payload)
                identifier = _entity_identifier(payload)
                if identifier:
                    self._mark_character_appearance(identifier, effective_chapter)
            elif event_type == "entity_appeared":
                identifier = str(event.get("entity_id") or "") or _entity_identifier(payload)
                if identifier:
                    self._mark_character_appearance(identifier, effective_chapter)
            elif event_type == "state_changed":
                self._apply_state_change(
                    {
                        "entity_id": event.get("entity_id", ""),
                        "entity_type": event.get("entity_type", ""),
                        "field": event.get("field", ""),
                        "old": event.get("old"),
                        "new": event.get("new"),
                        "chapter": event.get("chapter"),
                    }
                )
            elif event_type == "relationship_changed":
                payload.setdefault("entity_id", event.get("entity_id", ""))
                payload.setdefault("target_id", event.get("target_id", ""))
                payload.setdefault("field", event.get("field", "relationship"))
                payload.setdefault("new", event.get("new"))
                payload.setdefault("chapter", event.get("chapter"))
                self._apply_state_change(payload)
            elif event_type == "open_loop_created":
                self.upsert_foreshadowing(payload)
            elif event_type == "open_loop_closed":
                self._resolve_foreshadowing(payload, effective_chapter)
            elif event_type == "rule_revealed":
                self.add_world_rule(payload)
            elif event_type == "timeline_advanced":
                projected_timeline = payload
            elif event_type == "summary_recorded":
                projected_summary = payload

        if projected_timeline:
            self.append_timeline_entry(projected_timeline)
        if projected_summary:
            self.append_chapter_summary(projected_summary)

        if effective_chapter:
            self._memory["last_updated_chapter"] = effective_chapter
        self._memory["last_updated"] = now_utc_iso()

    def flush(self) -> None:
        self._memory = self._ensure_memory_schema(self._memory)
        atomic_write_json(self.config.memory_file, self._memory, use_lock=True, backup=True)
        logger.debug("memory flushed, chapter=%d", self._memory.get("last_updated_chapter", 0))

    @property
    def use_sqlite(self) -> bool:
        return self.config.memory_db.exists()

    def rebuild_sqlite(self) -> None:
        from core.memory_index import MemoryIndexService

        MemoryIndexService(self.config).rebuild()

    def _mark_character_appearance(self, char_id: str, chapter: int) -> None:
        if not chapter:
            return
        for char in self._memory.get("characters", []):
            if char.get("id") == char_id or char.get("name") == char_id:
                char["last_appearance_chapter"] = max(
                    int(char.get("last_appearance_chapter") or 0),
                    chapter,
                )
                char.setdefault("first_appearance_chapter", chapter)
                if int(char.get("first_appearance_chapter") or 0) == 0:
                    char["first_appearance_chapter"] = chapter
                return

    def _apply_state_change(self, change: dict[str, Any]) -> None:
        entity_id = change.get("entity_id")
        field = change.get("field")
        if not entity_id or not field:
            return
        for char in self._memory.get("characters", []):
            if char.get("id") == entity_id or char.get("name") == entity_id:
                char[str(field)] = change.get("new")
                return

    def _resolve_foreshadowing(self, item: Any, chapter: int) -> None:
        item_id = item.get("id") if isinstance(item, dict) else item
        if not item_id:
            return
        for existing in self._memory.setdefault("foreshadowing", []):
            if existing.get("id") == item_id:
                if isinstance(item, dict):
                    existing.update(deepcopy(item))
                existing["status"] = "resolved"
                if chapter and not existing.get("resolved_chapter"):
                    existing["resolved_chapter"] = chapter
                return
        if isinstance(item, dict):
            new_item = deepcopy(item)
            new_item["status"] = "resolved"
            if chapter:
                new_item.setdefault("resolved_chapter", chapter)
            self.upsert_foreshadowing(new_item)

    def _ensure_memory_schema(self, memory: dict[str, Any]) -> dict[str, Any]:
        base = default_memory()
        merged = deepcopy(base)
        if isinstance(memory, dict):
            merged.update(memory)
        for key in ("characters", "foreshadowing", "timeline", "world_rules", "chapter_summaries"):
            if not isinstance(merged.get(key), list):
                merged[key] = []
        merged.setdefault("last_updated", now_utc_iso())
        merged.setdefault("last_updated_chapter", 0)
        return merged
