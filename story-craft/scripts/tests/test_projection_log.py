from __future__ import annotations

from core.config import StoryCraftConfig
from core.projection.base import ProjectionResult
from core.projection_log import (
    append_projection_run,
    build_projection_run,
    failed_writers,
    latest_projection_run,
    projection_log_path,
    read_projection_runs,
)


def _results(**spec: tuple[bool, bool]) -> dict[str, ProjectionResult]:
    """spec: name -> (ok, skipped)。"""
    return {
        name: ProjectionResult(name=name, ok=ok, skipped=skipped, detail="")
        for name, (ok, skipped) in spec.items()
    }


def test_build_projection_run_status_failed_when_any_writer_fails():
    run = build_projection_run(
        chapter=1,
        commit_status="accepted",
        results=_results(state=(True, False), memory=(False, False)),
        source="chapter-commit",
    )
    assert run["status"] == "failed"
    assert run["writers"]["memory"]["ok"] is False
    assert run["chapter"] == 1
    assert run["source"] == "chapter-commit"
    assert run["commit_status"] == "accepted"


def test_build_projection_run_status_done_and_skipped():
    done = build_projection_run(
        chapter=1, commit_status="accepted",
        results=_results(state=(True, False)), source="rebuild-views",
    )
    assert done["status"] == "done"
    skipped = build_projection_run(
        chapter=1, commit_status="accepted",
        results=_results(vector=(True, True)), source="rebuild-views",
    )
    assert skipped["status"] == "skipped"


def test_append_read_and_latest_projection_run(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    append_projection_run(
        config, chapter=1, commit_status="accepted",
        results=_results(state=(True, False), memory=(True, False)), source="chapter-commit",
    )
    append_projection_run(
        config, chapter=2, commit_status="accepted",
        results=_results(state=(True, False), memory=(False, False)), source="chapter-commit",
    )

    assert projection_log_path(config).is_file()
    runs = read_projection_runs(config)
    assert len(runs) == 2
    latest = latest_projection_run(config)
    assert latest["chapter"] == 2
    assert failed_writers(latest) == ["memory"]
    assert latest_projection_run(config, chapter=1)["chapter"] == 1


def test_failed_writers_handles_none_and_clean_run():
    assert failed_writers(None) == []
    clean = build_projection_run(
        chapter=1, commit_status="accepted",
        results=_results(state=(True, False)), source="x",
    )
    assert failed_writers(clean) == []


def test_latest_projection_run_absent_returns_none(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    assert latest_projection_run(config) is None
