#!/usr/bin/env python3
"""Build chapter-commit truth-source payloads from review and extraction data."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from core.time_utils import now_utc_iso
from core.types import (
    AcceptedEvent,
    ChapterCommit,
    EntityDelta,
    ExtractionDelta,
    NormalizedReviewerResult,
    SceneSlice,
    StateDelta,
    StrandLiteral,
)

COMMIT_VERSION = "story-craft/commit-v1"
DEFAULT_STRAND: StrandLiteral = "quest"


def build_chapter_commit(
    *,
    chapter: int,
    title: str,
    word_count: int,
    review_result: NormalizedReviewerResult,
    extraction_delta: ExtractionDelta,
) -> ChapterCommit:
    """Build a write-after truth-source commit from normalized chapter outputs."""
    events = delta_to_events(extraction_delta)
    scenes = _scene_slices(extraction_delta.get("scenes") or [], chapter=chapter)
    status = "accepted" if not review_result.get("blockers") else "rejected"
    chapter_summary = deepcopy(extraction_delta.get("chapter_summary") or {})
    if chapter_summary:
        chapter_summary.setdefault("chapter", int(chapter))
        chapter_summary.setdefault("title", title)
        chapter_summary.setdefault("word_count", int(word_count))
    timeline_entry = deepcopy(extraction_delta.get("timeline_entry") or {})
    if timeline_entry:
        timeline_entry.setdefault("chapter", int(chapter))

    return {
        "chapter": int(chapter),
        "title": title,
        "status": status,
        "word_count": int(word_count),
        "written_at": now_utc_iso(),
        "commit_version": COMMIT_VERSION,
        "review_meta": deepcopy(review_result.get("meta") or {}),
        "accepted_events": events,
        "state_deltas": derive_state_deltas(events),
        "entity_deltas": derive_entity_deltas(events),
        "entities_appeared": _entities_appeared(events, extraction_delta),
        "summary_text": str(chapter_summary.get("summary") or ""),
        "chapter_summary": chapter_summary,
        "scenes": scenes,
        "dominant_strand": compute_dominant_strand(events, scenes),
        "strand_distribution": compute_strand_distribution(events, scenes),
        "timeline_entry": timeline_entry,
        "world_rules": deepcopy(extraction_delta.get("new_world_rules") or []),
        "agent_calls": deepcopy(extraction_delta.get("agent_calls") or {}),
    }


def delta_to_events(delta: ExtractionDelta) -> list[AcceptedEvent]:
    """Convert legacy ExtractionDelta fields into accepted event stream."""
    events = [deepcopy(event) for event in delta.get("accepted_events", []) or []]
    if events:
        return events

    chapter = _event_chapter(delta)
    source = "agent"

    for entity in delta.get("entities_new", []) or []:
        if not isinstance(entity, dict):
            continue
        entity_id = _entity_id(entity)
        events.append(
            {
                "event_type": "entity_introduced",
                "entity_id": entity_id,
                "entity_type": str(entity.get("entity_type") or entity.get("type") or "角色"),
                "payload": deepcopy(entity),
                "chapter": chapter,
                "source": source,
            }
        )

    for entity in delta.get("entities_appeared", []) or []:
        entity_id = _entity_id(entity)
        if not entity_id:
            continue
        payload = deepcopy(entity) if isinstance(entity, dict) else {"id": entity_id}
        events.append(
            {
                "event_type": "entity_appeared",
                "entity_id": entity_id,
                "entity_type": str(payload.get("entity_type") or payload.get("type") or "角色"),
                "payload": payload,
                "chapter": chapter,
                "source": source,
            }
        )

    for change in delta.get("state_changes", []) or []:
        if not isinstance(change, dict):
            continue
        event: AcceptedEvent = {
            "event_type": "state_changed",
            "entity_id": str(change.get("entity_id") or ""),
            "entity_type": str(change.get("entity_type") or change.get("type") or "角色"),
            "field": str(change.get("field") or ""),
            "old": change.get("old"),
            "new": change.get("new"),
            "payload": deepcopy(change),
            "chapter": chapter,
            "source": source,
        }
        events.append(event)

    for item in delta.get("new_foreshadowing", []) or []:
        payload = deepcopy(item) if isinstance(item, dict) else {"id": str(item)}
        events.append(_payload_event("open_loop_created", payload, chapter, source))

    for item in delta.get("resolved_foreshadowing", []) or []:
        payload = deepcopy(item) if isinstance(item, dict) else {"id": str(item)}
        events.append(_payload_event("open_loop_closed", payload, chapter, source))

    for rule in delta.get("new_world_rules", []) or []:
        payload = deepcopy(rule) if isinstance(rule, dict) else {"rule": str(rule)}
        events.append(_payload_event("rule_revealed", payload, chapter, source))

    if delta.get("timeline_entry"):
        events.append(
            _payload_event(
                "timeline_advanced",
                deepcopy(delta["timeline_entry"]),
                chapter,
                source,
            )
        )

    if delta.get("chapter_summary"):
        events.append(
            _payload_event(
                "summary_recorded",
                deepcopy(delta["chapter_summary"]),
                chapter,
                source,
            )
        )

    return events


def derive_state_deltas(events: list[AcceptedEvent]) -> list[StateDelta]:
    deltas: list[StateDelta] = []
    for event in events:
        if event.get("event_type") not in {"state_changed", "relationship_changed"}:
            continue
        deltas.append(
            {
                "entity_id": str(event.get("entity_id") or ""),
                "entity_type": str(event.get("entity_type") or ""),
                "field": str(event.get("field") or ""),
                "old": event.get("old"),
                "new": event.get("new"),
                "chapter": int(event.get("chapter") or 0),
            }
        )
    return deltas


def derive_entity_deltas(events: list[AcceptedEvent]) -> list[EntityDelta]:
    deltas: list[EntityDelta] = []
    for event in events:
        event_type = event.get("event_type")
        if event_type not in {"entity_introduced", "entity_appeared", "state_changed"}:
            continue
        payload = event.get("payload") or {}
        operation = "updated"
        if event_type == "entity_introduced":
            operation = "introduced"
        elif event_type == "entity_appeared":
            operation = "appeared"
        deltas.append(
            {
                "entity_id": str(event.get("entity_id") or payload.get("id") or ""),
                "name": str(payload.get("name") or ""),
                "entity_type": str(event.get("entity_type") or payload.get("entity_type") or ""),
                "role": str(payload.get("role") or ""),
                "tier": str(payload.get("tier") or ""),
                "operation": operation,
                "relationships": deepcopy(payload.get("relationships") or []),
                "fields": deepcopy(payload.get("fields") or {}),
                "chapter": int(event.get("chapter") or 0),
            }
        )
    return deltas


def compute_dominant_strand(
    events: list[AcceptedEvent],
    scenes: list[SceneSlice],
) -> StrandLiteral:
    distribution = compute_strand_distribution(events, scenes)
    if not distribution:
        return DEFAULT_STRAND
    return max(distribution, key=distribution.get)  # type: ignore[return-value]


def compute_strand_distribution(
    events: list[AcceptedEvent],
    scenes: list[SceneSlice],
) -> dict[str, int]:
    distribution: dict[str, int] = {}
    for item in [*events, *scenes]:
        strand = item.get("strand")
        if strand:
            distribution[str(strand)] = distribution.get(str(strand), 0) + 1
    return distribution


def _payload_event(
    event_type: str,
    payload: dict[str, Any],
    chapter: int,
    source: str,
) -> AcceptedEvent:
    return {
        "event_type": event_type,  # type: ignore[typeddict-item]
        "entity_id": str(payload.get("id") or payload.get("entity_id") or ""),
        "payload": payload,
        "chapter": chapter,
        "source": source,
    }


def _event_chapter(delta: ExtractionDelta) -> int:
    timeline_entry = delta.get("timeline_entry") or {}
    chapter = delta.get("chapter") or timeline_entry.get("chapter")
    try:
        return int(chapter or 0)
    except (TypeError, ValueError):
        return 0


def _entity_id(entity: Any) -> str:
    if isinstance(entity, dict):
        return str(entity.get("id") or entity.get("suggested_id") or entity.get("name") or "")
    if entity is None:
        return ""
    return str(entity)


def _scene_slices(scenes: list[SceneSlice], *, chapter: int) -> list[SceneSlice]:
    normalized: list[SceneSlice] = []
    for index, scene in enumerate(scenes, start=1):
        item: SceneSlice = deepcopy(scene)
        item.setdefault("index", index)
        if item.get("summary") and not item.get("embedding_text"):
            item["embedding_text"] = str(item["summary"])
        if not item.get("chunk_id"):
            item["chunk_id"] = f"ch{int(chapter):03d}:scene:{int(item.get('index') or index):03d}"
        normalized.append(item)
    return normalized


def _entities_appeared(
    events: list[AcceptedEvent],
    delta: ExtractionDelta,
) -> list[str]:
    appeared: list[str] = []
    for item in delta.get("entities_appeared", []) or []:
        entity_id = _entity_id(item)
        if entity_id and entity_id not in appeared:
            appeared.append(entity_id)
    for event in events:
        if event.get("event_type") != "entity_appeared":
            continue
        entity_id = str(event.get("entity_id") or "")
        if entity_id and entity_id not in appeared:
            appeared.append(entity_id)
    return appeared
