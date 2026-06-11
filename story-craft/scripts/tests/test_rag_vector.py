from __future__ import annotations

import sqlite3

from core.config import StoryCraftConfig
from core.projection.vector_writer import VectorProjectionWriter
from core.rag import EmbeddingError, HybridRetriever, RagConfig, VectorChunk, VectorStore
from core.rag.api_url import build_openai_endpoint_url
from core.rag.embedding_client import _parse_embeddings
from core.rag.rerank_client import RerankError, _parse_rerank
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


class DisabledRerankClient:
    def is_available(self) -> bool:
        return False


class ReverseRerankClient:
    def is_available(self) -> bool:
        return True

    def rerank(
        self,
        text: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        return [(1, 0.9), (0, 0.1)]


class PartialRerankClient:
    def is_available(self) -> bool:
        return True

    def rerank(
        self,
        text: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        return [(1, 0.9), (1, 0.8)]


class FailingRerankClient:
    def is_available(self) -> bool:
        return True

    def rerank(
        self,
        text: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        raise RerankError("offline")


def _chunk_count(config: StoryCraftConfig) -> int:
    with sqlite3.connect(config.vector_db) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])


def _clear_rag_env(monkeypatch) -> None:
    import core.rag.env_loader as env_loader

    for key in (
        "EMBED_BASE_URL",
        "EMBED_MODEL",
        "EMBED_API_KEY",
        "RERANK_BASE_URL",
        "RERANK_MODEL",
        "RERANK_API_KEY",
        "STORYCRAFT_API_BASE_URL",
        "STORYCRAFT_API_KEY",
        "STORYCRAFT_EMBEDDING_MODEL",
        "STORYCRAFT_RERANK_BASE_URL",
        "STORYCRAFT_RERANK_API_KEY",
        "STORYCRAFT_RERANKER_MODEL",
        "STORYCRAFT_ENABLE_EMBEDDING",
        "STORYCRAFT_ENABLE_RERANK",
        "STORYCRAFT_VECTOR_DIM",
        "STORYCRAFT_API_MAX_RETRIES",
        "STORYCRAFT_RETRIEVAL_MODE",
    ):
        monkeypatch.delenv(key, raising=False)
    env_loader._LOADED_VALUES.clear()


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
    monkeypatch.setattr(vector_writer, "EmbeddingClient", lambda config=None: FakeEmbeddingClient())

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
        rerank_client=DisabledRerankClient(),
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
        rerank_client=DisabledRerankClient(),
    ).search("任意", kind="summary")

    assert result[0]["chunk_id"] == "near"
    assert result[0]["score_type"] == "vector"


def test_rag_config_loads_project_env_without_overriding_process_env(monkeypatch, tmp_path):
    _clear_rag_env(monkeypatch)
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "EMBED_BASE_URL=https://project.example",
                "EMBED_MODEL=project-embed",
                "EMBED_API_KEY=project-key",
                "RERANK_BASE_URL=https://rerank.example/v1",
                "RERANK_MODEL=project-rerank",
                "RERANK_API_KEY=rerank-key",
                "STORYCRAFT_API_MAX_RETRIES=2",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("EMBED_MODEL", "process-embed")

    config = RagConfig.from_env(tmp_path)

    assert config.api_base_url == "https://project.example"
    assert config.embedding_model == "process-embed"
    assert config.api_key == "project-key"
    assert config.rerank_base_url == "https://rerank.example/v1"
    assert config.reranker_model == "project-rerank"
    assert config.rerank_api_key == "rerank-key"
    assert config.api_max_retries == 2


def test_rag_config_keeps_rerank_independent_from_embedding(monkeypatch):
    _clear_rag_env(monkeypatch)
    monkeypatch.setenv("EMBED_BASE_URL", "https://embed.example")
    monkeypatch.setenv("EMBED_API_KEY", "embed-key")

    config = RagConfig.from_env()

    assert config.api_base_url == "https://embed.example"
    assert config.api_key == "embed-key"
    assert config.rerank_base_url == ""
    assert config.rerank_api_key == ""


def test_openai_endpoint_url_builder():
    assert (
        build_openai_endpoint_url("https://api.example.com", "embeddings")
        == "https://api.example.com/v1/embeddings"
    )
    assert (
        build_openai_endpoint_url("https://api.example.com/v1", "embeddings")
        == "https://api.example.com/v1/embeddings"
    )
    assert (
        build_openai_endpoint_url("https://api.example.com/v1/embeddings", "embeddings")
        == "https://api.example.com/v1/embeddings"
    )
    assert (
        build_openai_endpoint_url("https://api.example.com", "rerank")
        == "https://api.example.com/v1/rerank"
    )


def test_parse_embeddings_sorts_by_index():
    payload = {
        "data": [
            {"index": 1, "embedding": [2, "3.5"]},
            {"index": 0, "embedding": [1, 1.5]},
        ]
    }

    assert _parse_embeddings(payload, expected=2) == [[1.0, 1.5], [2.0, 3.5]]


def test_parse_rerank_sorts_and_rejects_out_of_range():
    payload = {
        "results": [
            {"index": 0, "relevance_score": 0.2},
            {"index": 1, "score": 0.8},
        ]
    }

    assert _parse_rerank(payload, expected=2) == [(1, 0.8), (0, 0.2)]

    try:
        _parse_rerank({"results": [{"index": 2, "relevance_score": 1.0}]}, expected=2)
    except ValueError as exc:
        assert "out of range" in str(exc)
    else:
        raise AssertionError("expected out-of-range rerank result to fail")


def test_hybrid_retriever_reranks_vector_results(tmp_path):
    config = _long_config(tmp_path)
    store = VectorStore(config)
    store.upsert_chunks(
        [
            VectorChunk("first", "summary", 1, "第一候选", [1.0, 0.0], {}),
            VectorChunk("second", "summary", 2, "第二候选", [0.9, 0.1], {}),
        ]
    )

    result = HybridRetriever(
        config,
        embedding_client=NearEmbeddingClient(),
        vector_store=store,
        rerank_client=ReverseRerankClient(),
    ).search("任意", kind="summary")

    assert [row["chunk_id"] for row in result] == ["second", "first"]
    assert result[0]["score_type"] == "rerank"
    assert result[0]["rerank_score"] == 0.9


def test_hybrid_retriever_keeps_original_order_when_rerank_fails(tmp_path):
    config = _long_config(tmp_path)
    store = VectorStore(config)
    store.upsert_chunks(
        [
            VectorChunk("first", "summary", 1, "第一候选", [1.0, 0.0], {}),
            VectorChunk("second", "summary", 2, "第二候选", [0.9, 0.1], {}),
        ]
    )

    result = HybridRetriever(
        config,
        embedding_client=NearEmbeddingClient(),
        vector_store=store,
        rerank_client=FailingRerankClient(),
    ).search("任意", kind="summary")

    assert [row["chunk_id"] for row in result] == ["first", "second"]
    assert result[0]["score_type"] == "vector"


def test_hybrid_retriever_fills_missing_rerank_results(tmp_path):
    config = _long_config(tmp_path)
    store = VectorStore(config)
    store.upsert_chunks(
        [
            VectorChunk("first", "summary", 1, "第一候选", [1.0, 0.0], {}),
            VectorChunk("second", "summary", 2, "第二候选", [0.9, 0.1], {}),
            VectorChunk("third", "summary", 3, "第三候选", [0.8, 0.2], {}),
        ]
    )

    result = HybridRetriever(
        config,
        embedding_client=NearEmbeddingClient(),
        vector_store=store,
        rerank_client=PartialRerankClient(),
    ).search("任意", kind="summary", limit=3)

    assert [row["chunk_id"] for row in result] == ["second", "first", "third"]
    assert result[0]["score_type"] == "rerank"
    assert result[1]["score_type"] == "vector"
