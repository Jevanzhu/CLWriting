from __future__ import annotations

import json
from pathlib import Path

from conftest import reviewer_issue, run_cli
from core.config import StoryCraftConfig
from core.context_manager import ContextManager
from core.chapter_record import ChapterRecordService
from core.memory_manager import MemoryManager
from tools.genre_profile_builder import build_genre_hints
from tools.init_project import init_project
from tools.agent_workflow import normalize_reviewer_output
from tools.placeholder_scanner import scan_placeholders
from tools.project_memory import append_learning_pattern, get_learning_patterns
from tools.prewrite_validator import validate_prewrite
from tools.review_pipeline import build_review_report
from tools.style_sampler import detect_style_drift, extract_style_sample
from tools.writing_guidance_builder import build_anti_ai_checklist, build_writing_checklist


def test_context_manager_builds_four_sections(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
    )
    outline = project / "大纲" / "总纲.md"
    outline.write_text(
        "# 暗室\n\n## 第01章 葬礼后的信\n必须埋下天台纸条线索。\n\n## 第02章 档案室\n必须发现尸检报告异常。\n",
        encoding="utf-8",
    )
    memory = MemoryManager.from_project(project)
    memory.apply_chapter_delta(
        {
            "chapter": 1,
            "entities_appeared": ["char_protagonist"],
            "new_foreshadowing": [
                {
                    "id": "fh_001",
                    "content": "天台纸条",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                }
            ],
            "timeline_entry": {
                "chapter": 1,
                "time_marker": "周三傍晚",
                "events": ["收到信件"],
                "time_delta": "0",
            },
            "chapter_summary": {
                "chapter": 1,
                "title": "葬礼后的信",
                "summary": "林墨收到亡友来信",
                "hook_type": "悬念钩",
            },
        }
    )
    memory.flush()
    append_learning_pattern(
        project,
        "pacing",
        "铺垫过长",
        "第1章开头",
        "每章前300字内出现行动或异常",
        1,
    )
    ChapterRecordService(StoryCraftConfig.from_project_root(project)).record(
        1,
        "葬礼后的信",
        1800,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        category="pacing",
                        description="节奏略慢",
                        evidence="开头铺垫偏长",
                        fix_hint="压缩背景说明",
                    )
                ],
                "summary": "可提交。",
            }
        ),
        {"chapter_summary": {"chapter": 1, "title": "葬礼后的信", "summary": "林墨收到亡友来信"}},
    )

    context = ContextManager.from_project(project).build_context(2)

    assert {"core", "scene", "continuity", "guidance"}.issubset(context)
    assert "必须发现尸检报告异常" in context["core"]["chapter_outline"]
    assert context["scene"]["recent_summaries"][0]["chapter"] == 1
    assert context["continuity"]["unresolved_foreshadowing"][0]["id"] == "fh_001"
    assert context["guidance"]["genre_profile"]["genre"] == "悬疑灵异"
    assert context["guidance"]["learning_patterns"][0]["pattern_type"] == "pacing"
    assert context["guidance"]["anti_ai_checklist"]


def test_context_tools_return_expected_shapes():
    placeholders = scan_placeholders("这里有[TODO:补线索]，还有{待定结尾}。")
    assert len(placeholders) == 2
    assert "第1行" in placeholders[0]["location"]

    hints = build_genre_hints("悬疑")
    assert hints["genre"] == "悬疑灵异"
    assert "pacing" in hints
    for genre in ("都市日常", "历史脑洞", "电竞", "黑暗题材"):
        layered = build_genre_hints(genre)
        assert layered["genre"] == genre
        assert layered["pacing"] != "保持场景目标清晰，每章至少完成一次信息推进或关系变化。"
        assert len(layered["pitfalls"]) >= 2

    sample = extract_style_sample("“你来了。”他转身。冷光落在门上。", 1)
    baseline = dict(sample)
    baseline["avg_sentence_length"] = sample["avg_sentence_length"] + 20
    assert detect_style_drift(sample, baseline)

    checklist = build_writing_checklist(
        3,
        [{"review": {"warnings": [{"category": "dialogue", "description": "对白解释过多"}]}}],
        [{"id": "pat_001", "pattern_type": "hook", "instruction": "开篇先给异常"}],
    )
    assert len(checklist) >= 4
    assert build_anti_ai_checklist()

    report = build_review_report(
        2,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        severity="critical",
                        category="continuity",
                        location="第2段",
                        description="规则冲突",
                        evidence="正文规则与世界观冲突",
                        fix_hint="按世界观修正规则表达",
                        blocking=True,
                    )
                ],
                "summary": "存在规则冲突。",
            }
        ),
        "正文内容",
    )
    assert "未通过" in report
    assert "规则冲突" in report


def test_project_memory_and_prewrite_validator(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    pattern = append_learning_pattern(
        project,
        "dialogue",
        "对白解释",
        "某段对白",
        "对白必须带冲突",
        1,
    )
    assert pattern["id"] == "pat_001"
    assert get_learning_patterns(project, "dialogue")[0]["instruction"] == "对白必须带冲突"

    validation = validate_prewrite(project, 1)
    assert validation["ready"]
    assert any("总纲未显式覆盖" in item for item in validation["warnings"])

    validation = validate_prewrite(project, 2)
    assert not validation["ready"]
    assert any("缺少上一章验收记录" in item for item in validation["blockers"])


def test_cli_query_learn_review_paths(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    learn = run_cli(
        "--project-root",
        str(project),
        "learn",
        "--chapter",
        "1",
        "--pattern-type",
        "hook",
        "--description",
        "开篇慢",
        "--instruction",
        "前300字给异常",
    )
    assert learn.returncode == 0, learn.stderr
    assert json.loads(learn.stdout)["pattern_type"] == "hook"

    query = run_cli(
        "--project-root",
        str(project),
        "query",
        "context",
        "--chapter",
        "1",
    )
    assert query.returncode == 0, query.stderr
    assert "core" in json.loads(query.stdout)

    review_json = tmp_path / "review.json"
    chapter_file = tmp_path / "chapter.md"
    report_file = tmp_path / "report.md"
    review_json.write_text(json.dumps({"issues": [], "summary": "可提交。"}), encoding="utf-8")
    chapter_file.write_text("正文内容", encoding="utf-8")
    review = run_cli(
        "--project-root",
        str(project),
        "review",
        "--chapter",
        "1",
        "--review-results",
        str(review_json),
        "--chapter-file",
        str(chapter_file),
        "--report-file",
        str(report_file),
    )
    assert review.returncode == 0, review.stderr
    assert report_file.is_file()


def test_cli_reviewer_schema_errors_are_actionable(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    chapter_file = tmp_path / "chapter.md"
    chapter_file.write_text("正文内容", encoding="utf-8")

    missing_summary = tmp_path / "missing-summary.json"
    missing_summary.write_text(json.dumps({"issues": []}), encoding="utf-8")
    review = run_cli(
        "--project-root",
        str(project),
        "review",
        "--chapter",
        "1",
        "--review-results",
        str(missing_summary),
        "--chapter-file",
        str(chapter_file),
        "--report-file",
        str(tmp_path / "report.md"),
    )
    assert review.returncode == 1
    assert "内部错误" not in review.stderr
    assert "reviewer JSON 缺少必需字段：summary" in review.stderr

    missing_issues = tmp_path / "missing-issues.json"
    missing_issues.write_text(json.dumps({"summary": "格式错误"}), encoding="utf-8")
    repair = run_cli(
        "--project-root",
        str(project),
        "agent",
        "repair",
        "--chapter",
        "1",
        "--review-results",
        str(missing_issues),
        "--draft-file",
        str(chapter_file),
    )
    assert repair.returncode == 1
    assert "内部错误" not in repair.stderr
    assert "reviewer JSON 缺少必需字段：issues" in repair.stderr
