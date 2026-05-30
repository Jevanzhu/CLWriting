from __future__ import annotations

import sqlite3

from core.config import StoryCraftConfig
from core.projection.vector_writer import VectorProjectionWriter
from core.rag import EmbeddingError, HybridRetriever, VectorChunk, VectorStore
from core.security_utils import atomic_write_json


def _long_config(tmp_path) -> StoryCraftConfig:
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    atomic_write_json(
        config.contracts_dir / "master.json",
        {"project_type": "long"},
        use_lock=False,
        backup=False,
    )
    return config


def _commit(chapter: int, summary: str) -> dict:
    return {
        "chapter": chapter,
        "title": "旧楼",
        "status": "accepted",
        "summary_text": summary,
        "dominant_strand": "quest",
        "scenes": [
            {
                "chunk_id": f"ch{chapter:03d}:scene:001",
                "summary": summary,
                "embedding_text": f"{summary} 监控黑屏",
                "strand": "fire",
            }
        ],
    }


class FakeEmbeddingClient:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[float(index + 1), float(len(text))] for index, text in enumerate(texts)]


class FailingEmbeddingClient:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        raise EmbeddingError("offline")


class NearEmbeddingClient:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0] for _ in texts]


def _chunk_count(config: StoryCraftConfig) -> int:
    with sqlite3.connect(config.vector_db) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])


def test_vector_writer_skips_when_embedding_unavailable(tmp_path):
    config = _long_config(tmp_path)
    result = VectorProjectionWriter(config).write(_commit(1, "苏晚发现旧楼灯光。"))

    assert result.ok
    assert result.skipped
    assert result.detail == "embedding unavailable"
    assert not config.vector_db.exists()


def test_vector_writer_writes_and_rebuilds_with_mock_embedding(monkeypatch, tmp_path):
    import core.projection.vector_writer as vector_writer

    config = _long_config(tmp_path)
    monkeypatch.setattr(vector_writer, "EmbeddingClient", lambda: FakeEmbeddingClient())

    writer = VectorProjectionWriter(config)
    first = writer.write(_commit(1, "苏晚发现旧楼灯光。"))
    duplicate = writer.write(_commit(1, "苏晚发现旧楼灯光。"))
    rebuilt = writer.rebuild_all([_commit(2, "林墨找到缺页报告。")])

    assert first.detail == "wrote 2 vector chunks"
    assert duplicate.detail == "wrote 2 vector chunks"
    assert rebuilt.detail == "wrote 2 vector chunks"
    assert _chunk_count(config) == 2

    with sqlite3.connect(config.vector_db) as conn:
        rows = conn.execute(
            "SELECT chunk_id, kind, chapter FROM chunks ORDER BY chunk_id"
        ).fetchall()
    assert rows == [
        ("ch002:scene:001", "scene", 2),
        ("ch002:summary", "summary", 2),
    ]


def test_vector_store_bm25_and_hybrid_retriever_fallback(tmp_path):
    config = _long_config(tmp_path)
    store = VectorStore(config)
    store.upsert_chunks(
        [
            VectorChunk(
                chunk_id="ch001:summary",
                kind="summary",
                chapter=1,
                embedding_text="苏晚发现监控黑屏",
                vector=[1.0, 0.0],
                payload={"chapter": 1},
            ),
            VectorChunk(
                chunk_id="ch002:summary",
                kind="summary",
                chapter=2,
                embedding_text="林墨追查缺页报告",
                vector=[0.0, 1.0],
                payload={"chapter": 2},
            ),
        ]
    )

    bm25 = store.query_bm25("监控", kind="summary")
    hybrid = HybridRetriever(
        config,
        embedding_client=FailingEmbeddingClient(),
        vector_store=store,
    ).search("监控", kind="summary")

    assert bm25[0]["chunk_id"] == "ch001:summary"
    assert bm25[0]["score_type"] == "bm25"
    assert hybrid[0]["chunk_id"] == "ch001:summary"


def test_hybrid_retriever_uses_vector_when_embedding_available(tmp_path):
    config = _long_config(tmp_path)
    store = VectorStore(config)
    store.upsert_chunks(
        [
            VectorChunk(
                chunk_id="near",
                kind="summary",
                chapter=1,
                embedding_text="近",
                vector=[1.0, 0.0],
                payload={},
            ),
            VectorChunk(
                chunk_id="far",
                kind="summary",
                chapter=2,
                embedding_text="远",
                vector=[0.0, 1.0],
                payload={},
            ),
        ]
    )

    result = HybridRetriever(
        config,
        embedding_client=NearEmbeddingClient(),
        vector_store=store,
    ).search("任意", kind="summary")

    assert result[0]["chunk_id"] == "near"
    assert result[0]["score_type"] == "vector"
