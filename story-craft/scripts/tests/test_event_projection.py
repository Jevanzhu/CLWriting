from __future__ import annotations

import sqlite3
from inspect import signature

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.event_projection_router import EventProjectionRouter
from core.projection import (
    IndexProjectionWriter,
    MarkdownViewProjectionWriter,
    MemoryProjectionWriter,
    ProjectionResult,
    ProjectionWriter,
    StateProjectionWriter,
    SummaryProjectionWriter,
    VectorProjectionWriter,
)
from core.projection.base import ProjectionResult as BaseProjectionResult
from core.memory_manager import MemoryManager
from core.security_utils import atomic_write_json
from core.state_manager import StateManager


class FakeWriter(ProjectionWriter):
    name = "fake"

    def write(self, commit):
        return ProjectionResult(
            name=self.name,
            ok=self.should_run(commit),
            skipped=not self.should_run(commit),
            detail="written" if self.should_run(commit) else "skipped",
        )


def accepted_commit(chapter: int, *, title: str, words: int, summary: str) -> dict:
    return {
        "chapter": chapter,
        "title": title,
        "status": "accepted",
        "word_count": words,
        "summary_text": summary,
        "chapter_summary": {
            "chapter": chapter,
            "title": title,
            "summary": summary,
            "key_events": [summary],
            "characters_appeared": ["char_su"],
        },
        "accepted_events": [
            {
                "event_type": "entity_introduced",
                "entity_id": "char_su",
                "entity_type": "角色",
                "payload": {"id": "char_su", "name": "苏晚", "role": "ally"},
                "chapter": chapter,
            },
            {
                "event_type": "state_changed",
                "entity_id": "char_su",
                "entity_type": "角色",
                "field": "current_status",
                "old": "等待",
                "new": summary,
                "chapter": chapter,
            },
            {
                "event_type": "timeline_advanced",
                "payload": {"chapter": chapter, "events": [summary]},
                "chapter": chapter,
            },
            {
                "event_type": "summary_recorded",
                "payload": {"chapter": chapter, "title": title, "summary": summary},
                "chapter": chapter,
            },
        ],
        "entity_deltas": [
            {
                "entity_id": "char_su",
                "name": "苏晚",
                "entity_type": "角色",
                "role": "ally",
                "tier": "核心",
                "operation": "introduced",
                "chapter": chapter,
            }
        ],
        "state_deltas": [
            {
                "entity_id": "char_su",
                "entity_type": "角色",
                "field": "current_status",
                "old": "等待",
                "new": summary,
                "chapter": chapter,
            }
        ],
        "scenes": [
            {
                "chunk_id": f"ch{chapter:03d}:scene:001",
                "summary": summary,
                "embedding_text": summary,
                "strand": "quest",
            }
        ],
        "dominant_strand": "quest",
        "timeline_entry": {"chapter": chapter, "events": [summary]},
    }


def test_projection_result_is_exported_from_base():
    assert ProjectionResult is BaseProjectionResult
    assert IndexProjectionWriter.name == "index"
    assert VectorProjectionWriter.name == "vector"
    result = ProjectionResult(name="state", ok=True, skipped=False, detail="ok")

    assert result.name == "state"
    assert result.ok
    assert not result.skipped
    assert result.detail == "ok"


def test_projection_writer_defaults_skip_rejected_and_are_not_lazy(tmp_path):
    writer = FakeWriter(StoryCraftConfig.from_project_root(tmp_path))

    assert writer.should_run({"status": "accepted"})
    assert writer.should_run({})
    assert not writer.should_run({"status": "rejected"})
    assert not writer.is_lazy()
    assert list(signature(writer.is_lazy).parameters) == []

    accepted = writer.write({"status": "accepted"})
    rejected = writer.write({"status": "rejected"})

    assert accepted == ProjectionResult(
        name="fake",
        ok=True,
        skipped=False,
        detail="written",
    )
    assert rejected == ProjectionResult(
        name="fake",
        ok=False,
        skipped=True,
        detail="skipped",
    )


def test_state_projection_writer_updates_progress_idempotently(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = StateProjectionWriter(config)

    first = writer.write(
        {
            "chapter": 1,
            "title": "开局",
            "status": "accepted",
            "word_count": 1800,
        }
    )
    duplicate = writer.write(
        {
            "chapter": 1,
            "title": "开局",
            "status": "accepted",
            "word_count": 1800,
        }
    )
    second = writer.write(
        {
            "chapter": 2,
            "title": "旧楼",
            "status": "accepted",
            "word_count": 2200,
        }
    )

    progress = StateManager(config).get_progress()
    assert first == ProjectionResult(
        name="state",
        ok=True,
        skipped=False,
        detail="progress updated",
    )
    assert duplicate == ProjectionResult(
        name="state",
        ok=True,
        skipped=True,
        detail="chapter already projected",
    )
    assert second.ok
    assert progress["current_chapter"] == 2
    assert progress["total_words"] == 4000
    assert progress["phase"] == "writing"
    assert progress["projected_commit_words"] == {"1": 1800, "2": 2200}


def test_state_projection_writer_skips_rejected_commit(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    result = StateProjectionWriter(config).write(
        {
            "chapter": 1,
            "title": "退稿",
            "status": "rejected",
            "word_count": 1800,
        }
    )

    progress = StateManager(config).get_progress()
    assert result == ProjectionResult(
        name="state",
        ok=True,
        skipped=True,
        detail="rejected commit skipped",
    )
    assert progress["current_chapter"] == 0
    assert progress["total_words"] == 0


def test_summary_projection_writer_renders_and_overwrites_summary(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = SummaryProjectionWriter(config)

    result = writer.write(
        {
            "chapter": 5,
            "title": "旧楼",
            "status": "accepted",
            "summary_text": "林墨进入旧楼，发现监控黑屏。",
            "chapter_summary": {
                "title": "旧楼",
                "key_events": ["进入旧楼", "发现监控黑屏"],
                "characters_appeared": ["char_lin", "char_su"],
                "hook_type": "悬念",
                "hook_strength": "strong",
            },
        }
    )
    path = config.summaries_dir / "ch0005.md"

    assert result.name == "summary"
    assert result.ok
    assert not result.skipped
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert "# 第0005章 旧楼" in text
    assert "林墨进入旧楼，发现监控黑屏。" in text
    assert "- 类型：悬念" in text
    assert "- 进入旧楼" in text
    assert "- char_su" in text

    writer.write(
        {
            "chapter": 5,
            "title": "旧楼",
            "status": "accepted",
            "summary_text": "修订后的摘要。",
            "chapter_summary": {"title": "旧楼"},
        }
    )
    overwritten = path.read_text(encoding="utf-8")
    assert "修订后的摘要。" in overwritten
    assert "林墨进入旧楼，发现监控黑屏。" not in overwritten


def test_summary_projection_writer_skips_rejected_commit(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    result = SummaryProjectionWriter(config).write(
        {
            "chapter": 5,
            "title": "退稿",
            "status": "rejected",
            "summary_text": "不应写出",
        }
    )

    assert result == ProjectionResult(
        name="summary",
        ok=True,
        skipped=True,
        detail="rejected commit skipped",
    )
    assert not (config.summaries_dir / "ch0005.md").exists()


def test_memory_projection_writer_consumes_events_directly_and_is_idempotent(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = MemoryProjectionWriter(config)
    commit = {
        "chapter": 2,
        "title": "旧楼",
        "status": "accepted",
        "accepted_events": [
            {
                "event_type": "entity_introduced",
                "entity_id": "char_su",
                "entity_type": "角色",
                "payload": {
                    "id": "char_su",
                    "name": "苏晚",
                    "role": "ally",
                    "tier": "核心",
                },
                "chapter": 2,
            },
            {
                "event_type": "entity_appeared",
                "entity_id": "char_su",
                "entity_type": "角色",
                "payload": {"id": "char_su"},
                "chapter": 2,
            },
            {
                "event_type": "state_changed",
                "entity_id": "char_su",
                "entity_type": "角色",
                "field": "current_status",
                "old": "等待",
                "new": "发现旧楼灯光",
                "chapter": 2,
            },
            {
                "event_type": "open_loop_created",
                "payload": {"id": "fh_2", "content": "旧楼灯光", "status": "open"},
                "chapter": 2,
            },
            {
                "event_type": "open_loop_closed",
                "payload": {"id": "fh_1", "resolution": "找到信源"},
                "chapter": 2,
            },
            {
                "event_type": "rule_revealed",
                "payload": {"id": "wr_1", "rule": "证据必须可回溯"},
                "chapter": 2,
            },
            {
                "event_type": "timeline_advanced",
                "payload": {"chapter": 2, "events": ["进入旧楼"]},
                "chapter": 2,
            },
            {
                "event_type": "summary_recorded",
                "payload": {
                    "chapter": 2,
                    "title": "旧楼",
                    "summary": "林墨进入旧楼",
                    "word_count": 2200,
                },
                "chapter": 2,
            },
        ],
    }

    first = writer.write(commit)
    duplicate = writer.write(commit)
    memory = MemoryManager(config).load()

    assert first == ProjectionResult(
        name="memory",
        ok=True,
        skipped=False,
        detail="memory updated",
    )
    assert duplicate.ok
    assert not duplicate.skipped
    assert memory["last_updated_chapter"] == 2
    assert len(memory["characters"]) == 1
    assert memory["characters"][0]["current_status"] == "发现旧楼灯光"
    assert memory["characters"][0]["last_appearance_chapter"] == 2
    assert memory["foreshadowing"][0]["id"] == "fh_2"
    assert len(memory["timeline"]) == 1
    assert memory["timeline"][0]["events"] == ["进入旧楼"]
    assert len(memory["chapter_summaries"]) == 1
    assert memory["chapter_summaries"][0]["summary"] == "林墨进入旧楼"
    assert memory["world_rules"][0]["id"] == "wr_1"


def test_memory_projection_writer_skips_rejected_and_empty_commits(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = MemoryProjectionWriter(config)

    rejected = writer.write(
        {
            "chapter": 1,
            "title": "退稿",
            "status": "rejected",
            "accepted_events": [
                {
                    "event_type": "summary_recorded",
                    "payload": {"chapter": 1, "summary": "不应写出"},
                    "chapter": 1,
                }
            ],
        }
    )
    empty = writer.write(
        {
            "chapter": 1,
            "title": "空事件",
            "status": "accepted",
            "accepted_events": [],
        }
    )
    memory = MemoryManager(config).load()

    assert rejected == ProjectionResult(
        name="memory",
        ok=True,
        skipped=True,
        detail="rejected commit skipped",
    )
    assert empty == ProjectionResult(
        name="memory",
        ok=True,
        skipped=True,
        detail="no accepted events",
    )
    assert memory["last_updated_chapter"] == 0
    assert memory["chapter_summaries"] == []


def test_markdown_view_projection_writer_renders_project_views(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = MarkdownViewProjectionWriter(config)
    commit = {
        "chapter": 2,
        "title": "旧楼",
        "status": "accepted",
        "summary_text": "林墨进入旧楼，苏晚发现监控黑屏。",
        "dominant_strand": "quest",
        "entity_deltas": [
            {
                "entity_id": "char_su",
                "name": "苏晚",
                "entity_type": "角色",
                "role": "ally",
                "tier": "核心",
                "operation": "introduced",
            },
            {
                "entity_id": "faction_watch",
                "name": "观测局",
                "entity_type": "势力",
                "role": "opponent",
                "tier": "核心",
                "operation": "introduced",
            },
        ],
        "state_deltas": [
            {
                "entity_id": "char_su",
                "entity_type": "角色",
                "field": "current_status",
                "old": "等待",
                "new": "发现旧楼灯光",
                "chapter": 2,
            }
        ],
        "world_rules": [{"id": "wr_1", "rule": "证据必须可回溯"}],
        "accepted_events": [
            {
                "event_type": "open_loop_created",
                "payload": {"id": "fh_2", "content": "旧楼灯光"},
                "chapter": 2,
            },
            {
                "event_type": "open_loop_closed",
                "payload": {"id": "fh_1", "content": "亡友信源"},
                "chapter": 2,
            },
            {
                "event_type": "timeline_advanced",
                "payload": {"summary": "进入旧楼"},
                "chapter": 2,
            },
        ],
    }

    result = writer.write(commit)

    assert result == ProjectionResult(
        name="markdown_view",
        ok=True,
        skipped=False,
        detail="markdown views updated",
    )

    character = config.settings_view_dir / "角色" / "苏晚.md"
    faction = config.settings_view_dir / "势力" / "观测局.md"
    world = config.settings_view_dir / "世界观" / "wr_1.md"
    context = config.tracking_dir / "上下文.md"
    loops = config.tracking_dir / "伏笔.md"
    timeline = config.tracking_dir / "时间线.md"
    state = config.tracking_dir / "角色状态.md"

    assert character.is_file()
    assert faction.is_file()
    assert world.is_file()
    assert context.is_file()
    assert loops.is_file()
    assert timeline.is_file()
    assert state.is_file()
    assert "发现旧楼灯光" in character.read_text(encoding="utf-8")
    assert "# 观测局" in faction.read_text(encoding="utf-8")
    assert "证据必须可回溯" in world.read_text(encoding="utf-8")
    assert "林墨进入旧楼" in context.read_text(encoding="utf-8")
    assert "旧楼灯光" in loops.read_text(encoding="utf-8")
    assert "亡友信源" in loops.read_text(encoding="utf-8")
    assert "进入旧楼" in timeline.read_text(encoding="utf-8")
    assert "current_status" in state.read_text(encoding="utf-8")


def test_markdown_view_projection_writer_rebuilds_and_skips_rejected(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    writer = MarkdownViewProjectionWriter(config)

    rejected = writer.write(
        {
            "chapter": 1,
            "title": "退稿",
            "status": "rejected",
            "summary_text": "不应写出",
        }
    )
    rebuilt = writer.rebuild_all(
        [
            {
                "chapter": 1,
                "title": "退稿",
                "status": "rejected",
                "summary_text": "不应写出",
            },
            {
                "chapter": 2,
                "title": "旧楼",
                "status": "accepted",
                "summary_text": "只从 accepted commit 重建。",
                "dominant_strand": "fire",
            },
        ]
    )

    context = config.tracking_dir / "上下文.md"
    assert rejected == ProjectionResult(
        name="markdown_view",
        ok=True,
        skipped=True,
        detail="rejected commit skipped",
    )
    assert rebuilt == ProjectionResult(
        name="markdown_view",
        ok=True,
        skipped=False,
        detail="markdown views rebuilt from 1 commits",
    )
    assert "只从 accepted commit 重建。" in context.read_text(encoding="utf-8")
    assert "不应写出" not in context.read_text(encoding="utf-8")


def test_event_projection_router_dispatches_available_writers_and_skips_lazy(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    router = EventProjectionRouter(config)
    commit = {
        "chapter": 1,
        "title": "开局",
        "status": "accepted",
        "word_count": 1800,
        "summary_text": "林墨收到亡友来信。",
        "chapter_summary": {"chapter": 1, "title": "开局", "summary": "林墨收到亡友来信。"},
        "accepted_events": [
            {
                "event_type": "summary_recorded",
                "payload": {"chapter": 1, "title": "开局", "summary": "林墨收到亡友来信。"},
                "chapter": 1,
            }
        ],
        "dominant_strand": "quest",
    }

    results = router.dispatch(commit)

    assert set(results) == {
        "state",
        "memory",
        "summary",
        "index",
        "vector",
        "markdown_view",
    }
    assert results["state"].ok
    assert results["memory"].ok
    assert results["summary"].ok
    assert results["markdown_view"].ok
    assert results["index"] == ProjectionResult(
        name="index",
        ok=True,
        skipped=True,
        detail="lazy projection skipped",
    )
    assert results["vector"] == ProjectionResult(
        name="vector",
        ok=True,
        skipped=True,
        detail="lazy projection skipped",
    )
    assert StateManager(config).get_progress()["total_words"] == 1800
    assert MemoryManager(config).get_chapter_summaries(1)[0]["summary"] == "林墨收到亡友来信。"
    assert (config.summaries_dir / "ch0001.md").is_file()
    assert "林墨收到亡友来信" in (config.tracking_dir / "上下文.md").read_text(encoding="utf-8")


def test_event_projection_router_only_runs_selected_writer(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    router = EventProjectionRouter(config)

    results = router.dispatch(
        {
            "chapter": 2,
            "title": "旧楼",
            "status": "accepted",
            "word_count": 2200,
            "summary_text": "只写 summary。",
            "chapter_summary": {"chapter": 2, "title": "旧楼", "summary": "只写 summary。"},
        },
        only=["summary"],
    )

    assert list(results) == ["summary"]
    assert results["summary"].ok
    assert (config.summaries_dir / "ch0002.md").is_file()
    assert StateManager(config).get_progress()["total_words"] == 0
    assert not config.tracking_dir.exists()


def test_event_projection_router_catches_writer_failure(monkeypatch, tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    router = EventProjectionRouter(config)

    class OkWriter(ProjectionWriter):
        name = "state"

        def write(self, commit):
            return ProjectionResult(name=self.name, ok=True, skipped=False, detail="ok")

    class FailWriter(ProjectionWriter):
        name = "memory"

        def write(self, commit):
            raise RuntimeError("memory boom")

    def fake_load_writer(spec):
        if spec.name == "state":
            return OkWriter(config)
        if spec.name == "memory":
            return FailWriter(config)
        return None

    monkeypatch.setattr(router, "_load_writer", fake_load_writer)

    results = router.dispatch({"chapter": 1, "status": "accepted"})

    assert results["state"] == ProjectionResult(
        name="state",
        ok=True,
        skipped=False,
        detail="ok",
    )
    assert results["memory"].name == "memory"
    assert not results["memory"].ok
    assert "memory boom" in results["memory"].detail
    assert results["summary"].skipped


def test_event_projection_router_rebuild_replays_commit_store(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    store = CommitStore(config)
    store.write(
        {
            "chapter": 1,
            "title": "开局",
            "status": "accepted",
            "word_count": 1800,
            "summary_text": "重建摘要。",
            "chapter_summary": {"chapter": 1, "title": "开局", "summary": "重建摘要。"},
            "accepted_events": [
                {
                    "event_type": "summary_recorded",
                    "payload": {"chapter": 1, "summary": "重建摘要。"},
                    "chapter": 1,
                }
            ],
            "dominant_strand": "quest",
        }
    )

    results = EventProjectionRouter(config).rebuild(only=["summary", "markdown_view"])

    assert results["summary"] == ProjectionResult(
        name="summary",
        ok=True,
        skipped=False,
        detail="replayed 1 accepted commits",
    )
    assert results["markdown_view"] == ProjectionResult(
        name="markdown_view",
        ok=True,
        skipped=False,
        detail="markdown views rebuilt from 1 commits",
    )
    assert "重建摘要。" in (config.summaries_dir / "ch0001.md").read_text(encoding="utf-8")
    assert "重建摘要。" in (config.tracking_dir / "上下文.md").read_text(encoding="utf-8")


def test_event_projection_router_rebuild_is_idempotent_and_selective(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    store = CommitStore(config)
    store.write(accepted_commit(1, title="开局", words=1800, summary="林墨收到亡友来信。"))
    store.write(accepted_commit(2, title="旧楼", words=2200, summary="苏晚发现监控黑屏。"))
    store.write(
        {
            "chapter": 3,
            "title": "退稿",
            "status": "rejected",
            "word_count": 2600,
            "summary_text": "不应进入投影。",
        }
    )

    StateManager(config).update_progress(chapter=9, words_delta=9999, phase="broken")
    StateManager(config).flush()
    MemoryManager(config).save(
        {
            "characters": [
                {
                    "id": "char_protagonist",
                    "name": "林墨",
                    "role": "protagonist",
                    "first_appearance_chapter": 0,
                    "last_appearance_chapter": 0,
                },
                {
                    "id": "char_stale",
                    "name": "旧残留",
                    "role": "minor",
                    "last_appearance_chapter": 8,
                },
            ],
            "timeline": [
                {"chapter": 9, "events": ["规划第9章"], "planned": True},
                {"chapter": 8, "events": ["旧残留"]},
            ],
            "world_rules": [{"id": "wr_story_baseline", "rule": "基线", "source": "story-plan"}],
            "chapter_summaries": [{"chapter": 8, "summary": "旧摘要"}],
        }
    )
    stale_summary = config.summaries_dir / "ch0099.md"
    stale_summary.parent.mkdir(parents=True, exist_ok=True)
    stale_summary.write_text("旧摘要残留", encoding="utf-8")
    stale_view = config.tracking_dir / "旧残留.md"
    stale_view.parent.mkdir(parents=True, exist_ok=True)
    stale_view.write_text("旧视图残留", encoding="utf-8")

    first = EventProjectionRouter(config).rebuild()
    second = EventProjectionRouter(config).rebuild()
    progress = StateManager(config).get_progress()
    memory = MemoryManager(config).load()

    assert set(first) == {"state", "memory", "summary", "index", "vector", "markdown_view"}
    assert all(result.ok for result in first.values())
    assert first["index"] == ProjectionResult(
        name="index",
        ok=True,
        skipped=True,
        detail="lazy projection skipped",
    )
    assert first["vector"] == ProjectionResult(
        name="vector",
        ok=True,
        skipped=True,
        detail="lazy projection skipped",
    )
    assert second["state"].detail == "replayed 2 accepted commits"
    assert progress["current_chapter"] == 2
    assert progress["total_words"] == 4000
    assert progress["projected_commit_words"] == {"1": 1800, "2": 2200}
    assert [item["id"] for item in memory["characters"]] == [
        "char_protagonist",
        "char_su",
    ]
    assert any(item.get("planned") for item in memory["timeline"])
    assert not any(item.get("events") == ["旧残留"] for item in memory["timeline"])
    assert len(memory["chapter_summaries"]) == 2
    assert not stale_summary.exists()
    assert not stale_view.exists()
    assert "不应进入投影" not in (config.tracking_dir / "上下文.md").read_text(encoding="utf-8")

    only = EventProjectionRouter(config).rebuild(only=["summary"])
    assert list(only) == ["summary"]
    assert StateManager(config).get_progress()["total_words"] == 4000


def test_long_project_index_rebuilds_from_commits_and_vector_skips_without_rag(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    atomic_write_json(
        config.contracts_dir / "master.json",
        {"project_type": "long"},
        use_lock=False,
        backup=False,
    )
    CommitStore(config).write(
        accepted_commit(1, title="开局", words=1800, summary="林墨收到亡友来信。")
    )

    first = EventProjectionRouter(config).rebuild(only=["index", "vector"])
    second = EventProjectionRouter(config).rebuild(only=["index", "vector"])

    assert first["index"].ok
    assert not first["index"].skipped
    assert first["vector"] == ProjectionResult(
        name="vector",
        ok=True,
        skipped=True,
        detail="embedding unavailable",
    )
    assert second["index"].detail == first["index"].detail
    with sqlite3.connect(config.index_db) as conn:
        count = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        entities = conn.execute(
            "SELECT title FROM entries WHERE kind = 'entity' ORDER BY title"
        ).fetchall()
    assert count > 0
    assert ("苏晚",) in entities
