from __future__ import annotations

import json
from pathlib import Path

from conftest import reviewer_issue, run_cli
from tools.deslop_metrics import analyze_deslop_metrics
from tools.repair_strength import (
    REPAIR_PARTIAL,
    REPAIR_POLISH,
    classify_repair_strength,
    repair_mode_from_counts,
)


EXPECTED_GATES = {
    "banned_word_density",
    "parallel_paragraph_run",
    "psychological_word_ratio",
    "dialogue_tag_density",
    "average_paragraph_sentences",
    "repetitive_description_density",
    "markdown_residue",
}


def test_deslop_metrics_returns_exact_gate_set():
    result = analyze_deslop_metrics("缓缓" * 2 + "林墨" * 100)

    assert set(result["gates"]) == EXPECTED_GATES
    assert result["overall_level"] in {"none", "light", "medium", "heavy"}


def test_deslop_cli_reads_project_whitelist_and_writes_output(tmp_path):
    project = tmp_path / "故事项目"
    (project / ".story").mkdir(parents=True)
    (project / ".story" / "state.json").write_text("{}", encoding="utf-8")
    (project / ".deslop-whitelist").write_text("# 项目豁免\n缓缓\n\n缓缓\n", encoding="utf-8")
    draft = project / "draft.md"
    draft.write_text("缓缓" * 2 + "林墨" * 100, encoding="utf-8")
    output = tmp_path / "deslop.json"

    result = run_cli("deslop", "--draft-file", str(draft), "--output-file", str(output))

    assert result.returncode == 0, result.stderr
    stdout_payload = json.loads(result.stdout)
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert stdout_payload == {"output_file": str(output.resolve()), "ok": True}
    assert payload["command"] == "deslop"
    assert payload["whitelist_applied"] == ["缓缓"]
    assert payload["gates"]["banned_word_density"]["level"] == "none"


def test_repair_strength_boundary_counts_are_deterministic():
    assert repair_mode_from_counts(critical=1, major=0) == REPAIR_PARTIAL
    assert repair_mode_from_counts(critical=0, major=3) == REPAIR_PARTIAL
    assert repair_mode_from_counts(critical=0, major=0, minor=0) == REPAIR_POLISH

    result = classify_repair_strength(
        {
            "issues": [
                reviewer_issue(severity="S4", blocking=False),
                reviewer_issue(severity="low", blocking=False),
            ],
            "summary": "无阻断。",
        }
    )
    assert result["repair_mode"] == REPAIR_POLISH


def test_import_cli_splits_directory_sources_and_writes_output(tmp_path):
    source_dir = tmp_path / "导入源"
    source_dir.mkdir()
    (source_dir / "a.txt").write_text("无标题段落\n继续推进。", encoding="utf-8")
    (source_dir / "b.md").write_text(
        "# 第一章 旧信\n信纸没有署名。\n\n# 第二章 雨夜\n雨声盖住脚步。",
        encoding="utf-8",
    )
    output = tmp_path / "import.json"

    result = run_cli("import", "--source", str(source_dir), "--output-file", str(output))

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"output_file": str(output.resolve()), "ok": True}
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["command"] == "import"
    assert payload["file_count"] == 2
    assert payload["chapter_count"] == 3
    assert [chapter["chapter"] for chapter in payload["chapters"]] == [1, 2, 3]
    assert payload["rebuild_command"] == "rebuild-views"


def test_placeholder_scan_missing_file_reports_file_error(tmp_path):
    missing = tmp_path / "missing.md"

    result = run_cli("placeholder-scan", str(missing))

    assert result.returncode == 1
    assert "扫描占位符失败" in result.stderr
    assert str(missing) in result.stderr
