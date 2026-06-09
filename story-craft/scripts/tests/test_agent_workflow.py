from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import create_planned_project, long_chapter, reviewer_issue, run_cli
from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from tools.agent_workflow import (
    build_extraction_delta,
    build_polish_plan,
    build_repair_plan,
    build_workflow_workspace,
    build_writing_brief,
    normalize_reviewer_output,
)
from tools.chapter_workflow import record_chapter_workflow


def test_build_writing_brief_matches_context_agent_shape(tmp_path):
    project = create_planned_project(tmp_path)

    brief = build_writing_brief(project, 1)

    assert brief["ok"]
    assert brief["meta"]["chapter"] == 1
    assert brief["meta"]["title"] == "开篇异常"
    assert "core_mission" in brief
    assert brief["core_mission"]["must_accomplish"]
    assert "scene_and_characters" in brief
    assert "continuity" in brief
    assert "writing_guidance" in brief

    output_file = tmp_path / "brief.json"
    cli = run_cli(
        "--project-root",
        str(project),
        "agent",
        "brief",
        "--chapter",
        "1",
        "--output-file",
        str(output_file),
    )
    assert cli.returncode == 0, cli.stderr
    assert output_file.is_file()
    assert json.loads(output_file.read_text(encoding="utf-8"))["meta"]["title"] == "开篇异常"


def test_cli_agent_rejects_non_positive_chapter(tmp_path):
    project = create_planned_project(tmp_path)

    cli = run_cli(
        "--project-root",
        str(project),
        "agent",
        "brief",
        "--chapter",
        "0",
    )

    assert cli.returncode == 1
    assert "章节号必须从 1 开始" in cli.stderr


def test_workflow_manifest_commands_quote_paths_with_spaces(tmp_path):
    project = create_planned_project(tmp_path / "demo project")

    manifest = build_workflow_workspace(project, 1)
    command = manifest["cli_commands"]["prepare_brief_fallback"]

    assert "'" in command
    assert "demo project" in command
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    brief_file = Path(manifest["files"]["brief"])
    assert brief_file.is_file()
    assert json.loads(brief_file.read_text(encoding="utf-8"))["meta"]["chapter"] == 1


def test_workflow_manifest_write_command_persists_write_result(tmp_path):
    project = create_planned_project(tmp_path / "demo project")
    manifest = build_workflow_workspace(project, 1)
    draft = Path(manifest["files"]["draft"])
    review = Path(manifest["files"]["review"])
    delta = Path(manifest["files"]["delta"])
    result_file = Path(manifest["files"]["write_result"])
    draft.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨站在雨里复查亡友留下的信封，信件来源、旧楼档案和监控黑屏共同指向更深的隐瞒。",
        ),
        encoding="utf-8",
    )
    review.write_text(
        json.dumps({"issues": [], "summary": "第1章可提交。"}, ensure_ascii=False),
        encoding="utf-8",
    )
    delta.write_text(
        json.dumps(
            {
                "entities_appeared": ["char_protagonist"],
                "timeline_entry": {
                    "chapter": 1,
                    "events": ["林墨收到亡友来信"],
                },
                "chapter_summary": {
                    "chapter": 1,
                    "title": "葬礼后的信",
                    "summary": "林墨收到亡友来信",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    command = manifest["cli_commands"]["write"]
    assert "--result-file" in command
    assert "--review-results" in command
    assert "--require-review" in command
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result_file.is_file()
    payload = json.loads(result_file.read_text(encoding="utf-8"))
    stdout_payload = json.loads(result.stdout)
    assert payload["stage"] == "record"
    assert payload["status"] == "accepted"
    assert payload["review_status"] == "provided"
    assert "word_count_check" in payload
    assert stdout_payload["record_file"] == payload["record_file"]


def test_repair_and_polish_plans_handle_reviewer_issues(tmp_path):
    project = create_planned_project(tmp_path)
    draft = tmp_path / "draft.md"
    draft.write_text(
        "# 第01章 葬礼后的信\n\n林墨站在雨里，亡友的信让他停住脚步。",
        encoding="utf-8",
    )
    review_result = {
        "issues": [
            {
                "severity": "critical",
                "category": "continuity",
                "location": "第2段",
                "description": "主角提前知道未揭示线索",
                "evidence": "亡友的信",
                "fix_hint": "删掉未获得的信息来源",
                "blocking": True,
            },
            {
                "severity": "low",
                "category": "ai_flavor",
                "location": "全文",
                "description": "抽象情绪偏多",
                "evidence": "停住脚步",
                "fix_hint": "改成动作细节",
                "blocking": False,
            },
        ],
        "summary": "存在阻断问题",
    }

    repair = build_repair_plan(project, 1, review_result, draft_file=draft)
    assert repair["ok"]
    assert not repair["can_record"]
    assert repair["retry_required"]
    assert repair["blocker_actions"][0]["instruction"] == "删掉未获得的信息来源"

    polish = build_polish_plan(project, 1, draft, review_result=review_result)
    assert polish["ok"]
    assert any(item["category"] == "ai_flavor" for item in polish["actions"])
    assert "不改变已发生事实" in polish["red_lines"]


def test_normalize_reviewer_output_derives_status_from_issues():
    review_result = {
        "issues": [
            {
                "severity": "critical",
                "category": "logic",
                "location": "第1段",
                "description": "关键因果断裂",
                "evidence": "主角没有获得线索却直接推断真相",
                "fix_hint": "补足线索来源",
                "blocking": True,
            },
            {
                "severity": "low",
                "category": "pacing",
                "location": "第3段",
                "description": "局部节奏偏慢",
                "evidence": "连续三段解释背景",
                "fix_hint": "压缩背景说明",
                "blocking": False,
            },
        ],
        "suggestions": [
            reviewer_issue(
                severity="low",
                category="ai_flavor",
                description="可选润色建议",
                evidence="局部表达偏模板",
                fix_hint="改成具体动作",
                blocking=False,
            )
        ],
        "summary": "存在阻断和警告。",
    }

    normalized = normalize_reviewer_output(review_result)

    assert not normalized["passed"]
    assert len(normalized["blockers"]) == 1
    assert len(normalized["warnings"]) == 1
    assert "suggestions" not in normalized


def test_normalize_reviewer_output_supports_stage3_findings_schema():
    review_result = {
        "issues": [
            {
                "severity": "S2",
                "category": "reader_pull",
                "location": "结尾",
                "issue": "章尾没有形成下一步期待",
                "evidence": "结尾直接总结主题",
                "fix": "用未解决选择或新信息收束",
                "blocking": False,
            },
            {
                "severity": "S3",
                "category": "ai_flavor",
                "location": "第4段",
                "issue": "心理标签偏密",
                "evidence": "连续使用感觉、意识到",
                "fix": "改为动作和物件细节",
                "blocking": False,
            },
        ],
        "summary": "阶段三 findings schema。",
        "meta": {
            "requested_mode": "full",
            "effective_mode": "solo",
            "fallback_reason": "agent_frontmatter_missing",
            "rubric_source": "fallback",
        },
    }

    normalized = normalize_reviewer_output(review_result)

    assert not normalized["passed"]
    assert len(normalized["blockers"]) == 1
    assert normalized["blockers"][0]["severity"] == "S2"
    assert normalized["blockers"][0]["blocking"] is True
    assert normalized["blockers"][0]["description"] == "章尾没有形成下一步期待"
    assert normalized["blockers"][0]["fix_hint"] == "用未解决选择或新信息收束"
    assert len(normalized["warnings"]) == 1
    assert normalized["warnings"][0]["severity"] == "S3"
    assert normalized["meta"]["rubric_source"] == "fallback"


def test_s1_and_s2_are_blocking_even_when_raw_flag_is_false():
    for severity in ("S1", "s2"):
        normalized = normalize_reviewer_output(
            {
                "issues": [
                    {
                        "severity": severity,
                        "category": "contract",
                        "location": "全文",
                        "issue": "未完成章节合同核心目标",
                        "evidence": "must_cover 未出现",
                        "fix": "补足章节核心行动",
                        "blocking": False,
                    }
                ],
                "summary": "阻断。",
            }
        )

        assert not normalized["passed"]
        assert normalized["blockers"][0]["blocking"] is True
        assert normalized["blockers"][0]["severity"] == severity.upper()


def test_normalize_reviewer_output_rejects_missing_required_fields():
    with pytest.raises(ValueError, match="issues"):
        normalize_reviewer_output({})

    with pytest.raises(ValueError, match="summary"):
        normalize_reviewer_output({"issues": []})

    with pytest.raises(ValueError, match="issues 必须是数组"):
        normalize_reviewer_output({"issues": {}, "summary": "格式错误"})  # type: ignore[arg-type]

    with pytest.raises(ValueError, match=r"issues\[0\] 缺少必需字段"):
        normalize_reviewer_output({"issues": [{"category": "logic"}], "summary": "格式错误"})  # type: ignore[arg-type]

    invalid_severity = reviewer_issue(severity="blocker")
    with pytest.raises(ValueError, match=r"issues\[0\]\.severity 非法"):
        normalize_reviewer_output({"issues": [invalid_severity], "summary": "格式错误"})

    invalid_category = reviewer_issue(category="length")
    with pytest.raises(ValueError, match=r"issues\[0\]\.category 非法"):
        normalize_reviewer_output({"issues": [invalid_category], "summary": "格式错误"})

    invalid_blocking = reviewer_issue(blocking="true")
    with pytest.raises(ValueError, match=r"issues\[0\]\.blocking 必须是布尔值"):
        normalize_reviewer_output({"issues": [invalid_blocking], "summary": "格式错误"})  # type: ignore[list-item]


def test_raw_reviewer_issues_block_record_and_keep_state_memory_unchanged(tmp_path):
    project = create_planned_project(tmp_path)
    draft = tmp_path / "draft.md"
    draft.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨站在雨里复查亡友留下的信封，信件来源、旧楼档案和监控黑屏共同指向更深的隐瞒。",
        ),
        encoding="utf-8",
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps(
            {
                "issues": [
                    {
                        "severity": "critical",
                        "category": "logic",
                        "location": "第1段",
                        "description": "因果链断裂",
                        "evidence": "寄来的信",
                        "fix_hint": "补足信件来源",
                        "blocking": True,
                    }
                ],
                "summary": "不通过",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )

    assert not result["ok"]
    assert result["status"] == "rejected"
    assert not result["memory_updated"]
    assert not result["state_updated"]
    assert result["chapter_file"] is None
    assert Path(result["report_file"]).is_file()
    assert Path(result["record_file"]).is_file()
    assert not any((project / "正文").glob("第01章*.md"))
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0
    assert MemoryManager.from_project(project).load()["last_updated_chapter"] == 0


def test_extraction_delta_matches_known_character_and_cli_extract(tmp_path):
    project = create_planned_project(tmp_path)
    chapter = tmp_path / "chapter.md"
    chapter.write_text(
        "# 第01章 葬礼后的信\n\n林墨站在雨里。亡友的信没有邮戳。他决定回到解剖室。",
        encoding="utf-8",
    )

    delta = build_extraction_delta(project, 1, chapter)

    assert "char_protagonist" in delta["entities_appeared"]
    assert delta["chapter_summary"]["title"] == "葬礼后的信"
    assert delta["chapter_summary"]["word_count"] > 0

    cli = run_cli(
        "--project-root",
        str(project),
        "agent",
        "extract",
        "--chapter",
        "1",
        "--chapter-file",
        str(chapter),
    )
    assert cli.returncode == 0, cli.stderr
    payload = json.loads(cli.stdout)
    assert payload["timeline_entry"]["chapter"] == 1
    assert "char_protagonist" in payload["entities_appeared"]


def test_extraction_delta_scans_past_non_heading_first_line(tmp_path):
    project = create_planned_project(tmp_path)
    chapter = tmp_path / "chapter.md"
    chapter.write_text(
        "雨声先落在铁门上。\n# 第01章 葬礼后的信\n\n林墨站在雨里。亡友的信没有邮戳。",
        encoding="utf-8",
    )

    delta = build_extraction_delta(project, 1, chapter)

    assert delta["title"] == "葬礼后的信"
    assert delta["chapter_summary"]["title"] == "葬礼后的信"
