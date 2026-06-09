#!/usr/bin/env python3
"""SQLite vector and BM25 fallback store."""

from __future__ import annotations

import json
import math
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from typing import Any

from core.config import StoryCraftConfig


@dataclass(frozen=True)
class VectorChunk:
    chunk_id: str
    kind: str
    chapter: int
    embedding_text: str
    vector: list[float]
    payload: dict[str, Any]


class VectorStore:
    """Persist vector chunks and provide pure-Python BM25 fallback search."""

    def __init__(self, config: StoryCraftConfig):
        self.config = config

    def ensure_schema(self) -> None:
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.vector_db)) as conn:
            _ensure_schema(conn)
            conn.commit()

    def upsert_chunks(self, chunks: list[VectorChunk]) -> int:
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.vector_db)) as conn:
            _ensure_schema(conn)
            _upsert_chunks(conn, chunks)
            conn.commit()
        return len(chunks)

    def replace_chunks(self, chunks: list[VectorChunk]) -> int:
        self.config.story_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.config.vector_db)) as conn:
            _ensure_schema(conn)
            conn.execute("BEGIN")
            try:
                conn.execute("DELETE FROM chunks")
                _upsert_chunks(conn, chunks)
            except BaseException:
                conn.rollback()
                raise
            conn.commit()
        return len(chunks)

    def query_vector(
        self,
        vector: list[float],
        *,
        kind: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        rows = self._load_rows(kind=kind)
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            candidate = row.get("vector") or []
            if not candidate:
                continue
            scored.append((_cosine_similarity(vector, candidate), row))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [
            {**row, "score": score, "score_type": "vector"}
            for score, row in scored[: max(1, int(limit))]
        ]

    def query_bm25(
        self,
        text: str,
        *,
        kind: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        query_terms = _tokenize(text)
        if not query_terms:
            return []
        rows = self._load_rows(kind=kind)
        documents = [_tokenize(str(row.get("embedding_text") or "")) for row in rows]
        if not documents:
            return []

        doc_count = len(documents)
        avg_len = sum(len(doc) for doc in documents) / max(doc_count, 1)
        doc_freq: dict[str, int] = {}
        for doc in documents:
            for term in set(doc):
                doc_freq[term] = doc_freq.get(term, 0) + 1

        scored: list[tuple[float, dict[str, Any]]] = []
        for row, doc in zip(rows, documents):
            score = _bm25_score(query_terms, doc, doc_freq, doc_count, avg_len)
            if score > 0:
                scored.append((score, row))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [
            {**row, "score": score, "score_type": "bm25"}
            for score, row in scored[: max(1, int(limit))]
        ]

    def count_chunks(self) -> int:
        if not self.config.vector_db.exists():
            return 0
        try:
            with closing(sqlite3.connect(self.config.vector_db)) as conn:
                table = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'"
                ).fetchone()
                if not table:
                    return 0
                return int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
        except sqlite3.DatabaseError:
            return 0

    def _load_rows(self, *, kind: str | None = None) -> list[dict[str, Any]]:
        if not self.config.vector_db.exists():
            return []
        sql = "SELECT chunk_id, kind, chapter, embedding_text, vector, payload FROM chunks"
        params: list[Any] = []
        if kind:
            sql += " WHERE kind = ?"
            params.append(kind)
        sql += " ORDER BY chapter ASC, chunk_id ASC"
        with closing(sqlite3.connect(self.config.vector_db)) as conn:
            _ensure_schema(conn)
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_dict(row) for row in rows]


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            chapter INTEGER NOT NULL DEFAULT 0,
            embedding_text TEXT NOT NULL DEFAULT '',
            vector TEXT NOT NULL DEFAULT '[]',
            payload TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_kind ON chunks(kind)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON chunks(chapter)")


def _upsert_chunks(conn: sqlite3.Connection, chunks: list[VectorChunk]) -> None:
    conn.executemany(
        """
        INSERT INTO chunks(chunk_id, kind, chapter, embedding_text, vector, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id)
        DO UPDATE SET
            kind = excluded.kind,
            chapter = excluded.chapter,
            embedding_text = excluded.embedding_text,
            vector = excluded.vector,
            payload = excluded.payload
        """,
        [
            (
                chunk.chunk_id,
                chunk.kind,
                int(chunk.chapter),
                chunk.embedding_text,
                json.dumps(chunk.vector),
                json.dumps(chunk.payload, ensure_ascii=False),
            )
            for chunk in chunks
        ],
    )


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    vector: list[float] = []
    payload: dict[str, Any] = {}
    try:
        vector = [float(value) for value in json.loads(row[4] or "[]")]
    except (TypeError, ValueError, json.JSONDecodeError):
        vector = []
    try:
        loaded = json.loads(row[5] or "{}")
        payload = loaded if isinstance(loaded, dict) else {}
    except json.JSONDecodeError:
        payload = {}
    return {
        "chunk_id": row[0],
        "kind": row[1],
        "chapter": int(row[2] or 0),
        "embedding_text": row[3],
        "vector": vector,
        "payload": payload,
    }


def _tokenize(text: str) -> list[str]:
    normalized = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    terms = [part for part in normalized.split() if part]
    compact = "".join(part for part in terms)
    if len(compact) >= 2:
        terms.extend(compact[index : index + 2] for index in range(len(compact) - 1))
    elif compact:
        terms.append(compact)
    return terms


def _bm25_score(
    query_terms: list[str],
    document: list[str],
    doc_freq: dict[str, int],
    doc_count: int,
    avg_len: float,
) -> float:
    if not document:
        return 0.0
    k1 = 1.5
    b = 0.75
    score = 0.0
    doc_len = len(document)
    for term in query_terms:
        freq = document.count(term)
        if not freq:
            continue
        idf = math.log(1 + (doc_count - doc_freq.get(term, 0) + 0.5) / (doc_freq.get(term, 0) + 0.5))
        numerator = freq * (k1 + 1)
        denominator = freq + k1 * (1 - b + b * doc_len / max(avg_len, 1.0))
        score += idf * numerator / denominator
    return score


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)
