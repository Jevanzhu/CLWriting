from __future__ import annotations

import sqlite3

from core.config import StoryCraftConfig
from core.projection.index_writer import IndexProjectionWriter
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
        "chapter_summary": {"chapter": chapter, "title": "旧楼", "summary": summary},
        "entity_deltas": [
            {
                "entity_id": "char_su",
                "name": "苏晚",
                "entity_type": "角色",
                "role": "ally",
                "tier": "核心",
                "operation": "introduced",
            }
        ],
        "state_deltas": [
            {
                "entity_id": "char_su",
                "field": "current_status",
                "old": "等待",
                "new": summary,
            }
        ],
        "accepted_events": [
            {
                "event_type": "summary_recorded",
                "payload": {"chapter": chapter, "title": "旧楼", "summary": summary},
                "chapter": chapter,
            }
        ],
        "scenes": [
            {
                "chunk_id": f"ch{chapter:03d}:scene:001",
                "summary": summary,
                "embedding_text": summary,
            }
        ],
    }


def _entry_count(config: StoryCraftConfig) -> int:
    with sqlite3.connect(config.index_db) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0])


def test_index_writer_is_lazy_for_short_projects(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)

    assert IndexProjectionWriter(config).is_lazy()
    assert not config.index_db.exists()


def test_index_writer_upserts_and_rebuilds_idempotently_for_long_projects(tmp_path):
    config = _long_config(tmp_path)
    writer = IndexProjectionWriter(config)
    commit = _commit(1, "苏晚发现监控黑屏。")

    first = writer.write(commit)
    duplicate = writer.write(commit)
    rebuilt = writer.rebuild_all([commit, {"chapter": 2, "status": "rejected"}])
    rebuilt_again = writer.rebuild_all([commit])

    assert not writer.is_lazy()
    assert first.detail == "indexed 5 entries"
    assert duplicate.detail == "indexed 5 entries"
    assert rebuilt.detail == "rebuilt 5 index entries from 1 commits"
    assert rebuilt_again.detail == rebuilt.detail
    assert _entry_count(config) == 5

    with sqlite3.connect(config.index_db) as conn:
        rows = conn.execute(
            "SELECT kind, entity_id, title FROM entries ORDER BY kind, source_key"
        ).fetchall()
    assert ("entity", "char_su", "苏晚") in rows
    assert ("chapter_summary", "", "旧楼") in rows
