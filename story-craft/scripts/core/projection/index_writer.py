#!/usr/bin/env python3
"""SQLite index projection writer."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from contextlib import closing
from typing import Any

from core.projection.base import ProjectionResult, ProjectionWriter
from core.time_utils import now_utc_iso
from core.types import ChapterCommit


class IndexProjectionWriter(ProjectionWriter):
    """Project accepted commits into a deterministic SQLite read index."""

    name = "index"

    def is_lazy(self) -> bool:
        return self.config.project_type() == "short"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )

        entries = _entries_from_commit(commit)
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.index_db)) as conn:
            _ensure_schema(conn)
            _upsert_entries(conn, entries)
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                ("updated_at", now_utc_iso()),
            )
            conn.commit()

        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=not entries,
            detail=f"indexed {len(entries)} entries",
        )

    def rebuild_all(self, commits: Iterable[ChapterCommit]) -> ProjectionResult:
        accepted = [commit for commit in commits if self.should_run(commit)]
        entries = [
            entry
            for commit in accepted
            for entry in _entries_from_commit(commit)
        ]
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.index_db)) as conn:
            _ensure_schema(conn)
            conn.execute("BEGIN")
            try:
                conn.execute("DELETE FROM entries")
                conn.execute("DELETE FROM meta")
                _upsert_entries(conn, entries)
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                    ("rebuilt_at", now_utc_iso()),
                )
            except BaseException:
                conn.rollback()
                raise
            conn.commit()

        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=not accepted,
            detail=f"rebuilt {len(entries)} index entries from {len(accepted)} commits",
        )


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS entries (
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL DEFAULT '',
            chapter INTEGER NOT NULL DEFAULT 0,
            source_key TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (kind, entity_id, chapter, source_key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projection_entries_kind ON entries(kind)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projection_entries_chapter ON entries(chapter)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projection_entries_entity ON entries(entity_id)"
    )


def _upsert_entries(conn: sqlite3.Connection, entries: list[dict[str, Any]]) -> None:
    conn.executemany(
        """
        INSERT INTO entries(kind, entity_id, chapter, source_key, title, content, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, entity_id, chapter, source_key)
        DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            payload = excluded.payload
        """,
        [
            (
                entry["kind"],
                entry["entity_id"],
                entry["chapter"],
                entry["source_key"],
                entry["title"],
                entry["content"],
                json.dumps(entry["payload"], ensure_ascii=False),
            )
            for entry in entries
        ],
    )


def _entries_from_commit(commit: ChapterCommit) -> list[dict[str, Any]]:
    chapter = int(commit.get("chapter") or 0)
    entries: list[dict[str, Any]] = []

    for entity in commit.get("entity_deltas", []) or []:
        entity_id = str(entity.get("entity_id") or entity.get("name") or "")
        entries.append(
            _entry(
                kind="entity",
                entity_id=entity_id,
                chapter=chapter,
                source_key=str(entity.get("operation") or "entity"),
                title=str(entity.get("name") or entity_id),
                content=" ".join(
                    str(part)
                    for part in (
                        entity.get("entity_type"),
                        entity.get("role"),
                        entity.get("tier"),
                    )
                    if part
                ),
                payload=dict(entity),
            )
        )

    for state in commit.get("state_deltas", []) or []:
        entity_id = str(state.get("entity_id") or "")
        field = str(state.get("field") or "state")
        entries.append(
            _entry(
                kind="state",
                entity_id=entity_id,
                chapter=chapter,
                source_key=field,
                title=field,
                content=f"{state.get('old') or ''} -> {state.get('new') or ''}",
                payload=dict(state),
            )
        )

    for index, event in enumerate(commit.get("accepted_events", []) or [], start=1):
        event_type = str(event.get("event_type") or "event")
        payload = event.get("payload") or {}
        entity_id = str(event.get("entity_id") or payload.get("id") or "")
        entries.append(
            _entry(
                kind=event_type,
                entity_id=entity_id,
                chapter=chapter,
                source_key=f"{event_type}:{index:03d}",
                title=_event_title(event),
                content=_event_content(event),
                payload=dict(event),
            )
        )

    summary = commit.get("chapter_summary") or {}
    if commit.get("summary_text") or summary:
        entries.append(
            _entry(
                kind="chapter_summary",
                entity_id="",
                chapter=chapter,
                source_key="summary",
                title=str(summary.get("title") or commit.get("title") or ""),
                content=str(commit.get("summary_text") or summary.get("summary") or ""),
                payload=dict(summary),
            )
        )

    for index, scene in enumerate(commit.get("scenes", []) or [], start=1):
        entries.append(
            _entry(
                kind="scene",
                entity_id="",
                chapter=chapter,
                source_key=str(scene.get("chunk_id") or f"scene:{index:03d}"),
                title=str(scene.get("location") or f"scene {index}"),
                content=str(scene.get("summary") or scene.get("embedding_text") or ""),
                payload=dict(scene),
            )
        )

    return entries


def _entry(
    *,
    kind: str,
    entity_id: str,
    chapter: int,
    source_key: str,
    title: str,
    content: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "kind": kind,
        "entity_id": entity_id,
        "chapter": chapter,
        "source_key": source_key,
        "title": title,
        "content": content,
        "payload": payload,
    }


def _event_title(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    return str(
        payload.get("title")
        or payload.get("name")
        or payload.get("content")
        or payload.get("id")
        or event.get("event_type")
        or ""
    )


def _event_content(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    for key in ("summary", "rule", "resolution", "description", "content"):
        if payload.get(key):
            return str(payload[key])
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)
