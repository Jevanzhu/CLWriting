from __future__ import annotations

from inspect import signature

from core.config import StoryCraftConfig
from core.projection import (
    ProjectionResult,
    ProjectionWriter,
    StateProjectionWriter,
    SummaryProjectionWriter,
)
from core.projection.base import ProjectionResult as BaseProjectionResult
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
