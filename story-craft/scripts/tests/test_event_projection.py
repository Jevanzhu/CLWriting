from __future__ import annotations

from inspect import signature

from core.config import StoryCraftConfig
from core.projection import (
    MemoryProjectionWriter,
    ProjectionResult,
    ProjectionWriter,
    StateProjectionWriter,
    SummaryProjectionWriter,
)
from core.projection.base import ProjectionResult as BaseProjectionResult
from core.memory_manager import MemoryManager
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


def test_projection_result_is_exported_from_base():
    assert ProjectionResult is BaseProjectionResult
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


def test_memory_projection_writer_uses_event_bridge_and_is_idempotent(tmp_path):
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
