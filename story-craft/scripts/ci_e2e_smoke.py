#!/usr/bin/env python3
"""CI end-to-end smoke for the deterministic story-craft CLI chain."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).resolve().parent / "story_craft.py"
PROJECTION_NAMES = {
    "state",
    "memory",
    "summary",
    "index",
    "vector",
    "markdown_view",
}


def main() -> int:
    os.environ.setdefault("STORYCRAFT_ENABLE_EMBEDDING", "0")
    with tempfile.TemporaryDirectory(prefix="story-craft-ci-") as tmp:
        workspace = Path(tmp)
        project = workspace / "ci-story"
        run_cli(
            "init",
            str(project),
            "CI冒烟故事",
            "悬疑",
            "--project-type",
            "long",
            "--word-count-target",
            "10000",
            "--synopsis",
            "法医收到亡友留下的空白来信，追查旧楼暗室真相。",
            "--protagonist-name",
            "林墨",
            "--protagonist-desire",
            "查清亡友死因",
            "--protagonist-flaw",
            "过度依赖证据",
            "--unique-advantage-type",
            "职业能力",
            "--unique-advantage-desc",
            "法医病理学和现场痕迹阅读",
            "--world-setting",
            "近现代城市，线索必须能由物证、证词或行动记录回溯。",
        )
        plan = run_cli("--project-root", str(project), "plan", "--chapter-count", "2")
        assert_payload(plan, ok=True, chapter_count=2)

        workflow = run_cli("--project-root", str(project), "agent", "workflow", "--chapter", "1")
        assert_payload(workflow, ok=True, chapter=1)
        brief = run_cli(
            "--project-root",
            str(project),
            "agent",
            "brief",
            "--chapter",
            "1",
            "--output-file",
            str(workspace / "brief-1.json"),
        )
        assert_payload(brief, ok=True)

        chapter1 = workspace / "chapter-01.md"
        review1 = workspace / "review-01.json"
        delta1 = workspace / "delta-01.json"
        write1_result = workspace / "write-01.json"
        write_chapter_fixture(
            chapter1,
            "第01章 信封上的刮痕",
            "林墨在解剖室收到亡友秦澈留下的信封，邮戳、封蜡刮痕、门卫证词和监控黑屏共同指向旧楼。",
        )
        write_review_fixture(review1, "第1章可提交。")
        extract1 = run_cli(
            "--project-root",
            str(project),
            "agent",
            "extract",
            "--chapter",
            "1",
            "--chapter-file",
            str(chapter1),
            "--output-file",
            str(delta1),
        )
        assert_payload(extract1, ok=True)
        write1 = run_cli(
            "--project-root",
            str(project),
            "write",
            "1",
            "--draft-file",
            str(chapter1),
            "--review-results",
            str(review1),
            "--delta-file",
            str(delta1),
            "--result-file",
            str(write1_result),
        )
        assert_payload(write1, ok=True, stage="record", status="accepted")

        review_report = workspace / "review-report-01.md"
        review = run_cli(
            "--project-root",
            str(project),
            "review",
            "--chapter",
            "1",
            "--review-results",
            str(review1),
            "--chapter-file",
            str(chapter1),
            "--report-file",
            str(review_report),
        )
        assert_payload(review, report_file=str(review_report.resolve()))
        require(review_report.is_file(), "review report was not written")

        chapter2 = workspace / "chapter-02.md"
        review2 = workspace / "review-02.json"
        delta2 = workspace / "delta-02.json"
        write2_result = workspace / "write-02.json"
        write_chapter_fixture(
            chapter2,
            "第02章 旧楼门禁",
            "林墨复查旧楼门禁、排水沟封条和许照证词，确认有人改写现场并隐藏地下室入口。",
        )
        write_review_fixture(review2, "第2章可提交。")
        extract2 = run_cli(
            "--project-root",
            str(project),
            "agent",
            "extract",
            "--chapter",
            "2",
            "--chapter-file",
            str(chapter2),
            "--output-file",
            str(delta2),
        )
        assert_payload(extract2, ok=True)
        commit2 = run_cli(
            "--project-root",
            str(project),
            "chapter-commit",
            "2",
            "--draft-file",
            str(chapter2),
            "--review-results",
            str(review2),
            "--delta-file",
            str(delta2),
            "--result-file",
            str(write2_result),
        )
        assert_payload(commit2, ok=True, stage="record", status="accepted")

        rebuild = run_cli("--project-root", str(project), "rebuild-views")
        rebuild_payload = assert_payload(rebuild, ok=True)
        assert_projection_results(rebuild_payload)
        assert_project_artifacts(project)

    print("story-craft CI smoke passed")
    return 0


def run_cli(*args: str) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"CLI failed: {' '.join(args)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"CLI did not return JSON: {' '.join(args)}\n{result.stdout}") from exc


def assert_payload(payload: dict[str, Any], **expected: Any) -> dict[str, Any]:
    for key, value in expected.items():
        require(payload.get(key) == value, f"{key} expected {value!r}, got {payload.get(key)!r}")
    return payload


def assert_projection_results(payload: dict[str, Any]) -> None:
    results = payload.get("results")
    require(isinstance(results, dict), "rebuild results missing")
    require(set(results) == PROJECTION_NAMES, f"projection set mismatch: {set(results)}")
    for name, result in results.items():
        require(result.get("ok") is True, f"projection {name} failed: {result}")
    require(results["state"]["skipped"] is False, "state projection should rebuild")
    require(results["memory"]["skipped"] is False, "memory projection should rebuild")
    require(results["summary"]["skipped"] is False, "summary projection should rebuild")
    require(results["markdown_view"]["skipped"] is False, "markdown view should rebuild")
    require(results["index"]["skipped"] is False, "long project index projection should rebuild")
    require(results["vector"]["skipped"] is True, "vector should degrade when embedding is disabled")
    require("embedding unavailable" in results["vector"]["detail"], "vector fallback detail missing")


def assert_project_artifacts(project: Path) -> None:
    state = read_json(project / ".story" / "state.json")
    memory = read_json(project / ".story" / "memory.json")
    require(state["progress"]["current_chapter"] == 2, "current chapter should be 2")
    require(memory["last_updated_chapter"] == 2, "memory should be updated to chapter 2")
    for chapter in (1, 2):
        require(
            (project / ".story" / "commits" / f"chapter_{chapter:03d}.commit.json").is_file(),
            f"chapter {chapter} commit missing",
        )
    for projection_path in (
        project / ".story" / "summaries" / "ch0001.md",
        project / ".story" / "summaries" / "ch0002.md",
        project / "追踪" / "上下文.md",
        project / "追踪" / "时间线.md",
        project / ".story" / "index.db",
    ):
        require(projection_path.is_file(), f"projection artifact missing: {projection_path}")


def write_chapter_fixture(path: Path, title: str, sentence: str) -> None:
    del title
    path.write_text(sentence * 160, encoding="utf-8")


def write_review_fixture(path: Path, summary: str) -> None:
    path.write_text(
        json.dumps({"issues": [], "summary": summary}, ensure_ascii=False),
        encoding="utf-8",
    )


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


if __name__ == "__main__":
    raise SystemExit(main())
