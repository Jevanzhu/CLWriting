#!/usr/bin/env python3
"""SQLite read index for medium story-craft projects."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.state_manager import StateManager


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class IndexEntry:
    kind: str
    entity_id: str
    chapter: int
    title: str
    content: str
    payload: dict[str, Any]


class MemoryIndexService:
    """Build and query a local SQLite cache from memory.json."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "MemoryIndexService":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def rebuild(self) -> dict[str, Any]:
        memory = MemoryManager(self.config).load()
        entries = self._build_entries(memory)
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.memory_db)) as conn:
            self._ensure_schema(conn)
            conn.execute("DELETE FROM entries")
            conn.executemany(
                """
                INSERT INTO entries(kind, entity_id, chapter, title, content, payload)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        entry.kind,
                        entry.entity_id,
                        entry.chapter,
                        entry.title,
                        entry.content,
                        json.dumps(entry.payload, ensure_ascii=False),
                    )
                    for entry in entries
                ],
            )
            conn.execute("DELETE FROM meta")
            conn.execute(
                "INSERT INTO meta(key, value) VALUES (?, ?)",
                ("rebuilt_at", now_utc()),
            )
            conn.commit()

        state = StateManager(self.config)
        state.update_maintenance(last_index_rebuild_at=now_utc())
        state.flush()

        by_kind: dict[str, int] = {}
        for entry in entries:
            by_kind[entry.kind] = by_kind.get(entry.kind, 0) + 1
        return {
            "db_file": str(self.config.memory_db),
            "entry_count": len(entries),
            "by_kind": by_kind,
        }

    def stats(self) -> dict[str, Any]:
        if not self.config.memory_db.exists():
            return {"db_file": str(self.config.memory_db), "exists": False, "entry_count": 0}
        with closing(sqlite3.connect(self.config.memory_db)) as conn:
            self._ensure_schema(conn)
            entry_count = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            rebuilt_at = self._read_meta(conn, "rebuilt_at")
            rows = conn.execute(
                "SELECT kind, COUNT(*) FROM entries GROUP BY kind ORDER BY kind"
            ).fetchall()
        return {
            "db_file": str(self.config.memory_db),
            "exists": True,
            "entry_count": int(entry_count),
            "rebuilt_at": rebuilt_at,
            "by_kind": {kind: int(count) for kind, count in rows},
        }

    def query(
        self,
        *,
        kind: Optional[str] = None,
        text: str = "",
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        if not self.config.memory_db.exists():
            self.rebuild()
        where = []
        params: list[Any] = []
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if text:
            where.append("(title LIKE ? OR content LIKE ? OR entity_id LIKE ?)")
            like = f"%{text}%"
            params.extend([like, like, like])
        sql = "SELECT kind, entity_id, chapter, title, content, payload FROM entries"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY chapter DESC, kind ASC, title ASC LIMIT ?"
        params.append(max(1, int(limit)))
        with closing(sqlite3.connect(self.config.memory_db)) as conn:
            self._ensure_schema(conn)
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                entity_id TEXT NOT NULL DEFAULT '',
                chapter INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL DEFAULT '{}'
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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_chapter ON entries(chapter)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_entity ON entries(entity_id)")

    def _read_meta(self, conn: sqlite3.Connection, key: str) -> str:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row else ""

    def _row_to_dict(self, row: tuple[Any, ...]) -> dict[str, Any]:
        payload = {}
        try:
            payload = json.loads(row[5] or "{}")
        except json.JSONDecodeError:
            payload = {}
        return {
            "kind": row[0],
            "entity_id": row[1],
            "chapter": int(row[2] or 0),
            "title": row[3],
            "content": row[4],
            "payload": payload,
        }

    def _build_entries(self, memory: dict[str, Any]) -> list[IndexEntry]:
        entries: list[IndexEntry] = []
        for char in memory.get("characters", []) or []:
            entries.append(
                IndexEntry(
                    kind="character",
                    entity_id=str(char.get("id") or char.get("name") or ""),
                    chapter=int(char.get("last_appearance_chapter") or 0),
                    title=str(char.get("name") or char.get("id") or ""),
                    content=" ".join(
                        str(part)
                        for part in (
                            char.get("role", ""),
                            char.get("current_status", ""),
                            char.get("description", ""),
                            char.get("emotional_state", ""),
                        )
                        if part
                    ),
                    payload=char,
                )
            )
            for relation in char.get("relationships", []) or []:
                if isinstance(relation, dict):
                    entries.append(
                        IndexEntry(
                            kind="relationship",
                            entity_id=str(char.get("id") or char.get("name") or ""),
                            chapter=int(char.get("last_appearance_chapter") or 0),
                            title=str(relation.get("target") or relation.get("target_id") or ""),
                            content=str(relation.get("type") or relation.get("description") or ""),
                            payload={"source": char, "relation": relation},
                        )
                    )
        for item in memory.get("foreshadowing", []) or []:
            entries.append(
                IndexEntry(
                    kind="foreshadowing",
                    entity_id=str(item.get("id") or ""),
                    chapter=int(item.get("planted_chapter") or 0),
                    title=str(item.get("content") or item.get("title") or item.get("id") or ""),
                    content=" ".join(
                        str(part)
                        for part in (
                            item.get("status", ""),
                            item.get("urgency", ""),
                            item.get("planned_resolution", ""),
                            item.get("resolution", ""),
                        )
                        if part
                    ),
                    payload=item,
                )
            )
        for item in memory.get("timeline", []) or []:
            events = item.get("events", [])
            content = "；".join(str(event) for event in events) if isinstance(events, list) else str(events)
            entries.append(
                IndexEntry(
                    kind="timeline",
                    entity_id="",
                    chapter=int(item.get("chapter") or 0),
                    title=str(item.get("time_marker") or item.get("location") or ""),
                    content=content,
                    payload=item,
                )
            )
        for item in memory.get("world_rules", []) or []:
            entries.append(
                IndexEntry(
                    kind="world_rule",
                    entity_id=str(item.get("id") or ""),
                    chapter=int(item.get("chapter") or 0),
                    title=str(item.get("rule") or item.get("title") or item.get("id") or ""),
                    content=str(item.get("description") or ""),
                    payload=item,
                )
            )
        for item in memory.get("chapter_summaries", []) or []:
            entries.append(
                IndexEntry(
                    kind="chapter_summary",
                    entity_id="",
                    chapter=int(item.get("chapter") or 0),
                    title=str(item.get("title") or ""),
                    content=str(item.get("summary") or item.get("hook") or item.get("hook_type") or ""),
                    payload=item,
                )
            )
        return entries
