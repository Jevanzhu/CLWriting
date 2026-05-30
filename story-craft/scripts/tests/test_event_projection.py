from __future__ import annotations

from inspect import signature

from core.config import StoryCraftConfig
from core.projection import ProjectionResult, ProjectionWriter
from core.projection.base import ProjectionResult as BaseProjectionResult


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
