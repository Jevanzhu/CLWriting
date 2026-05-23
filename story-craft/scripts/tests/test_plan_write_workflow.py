from __future__ import annotations

import json
from pathlib import Path

from conftest import long_chapter, run_cli
from core.context_manager import ContextManager
from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from tools.chapter_workflow import commit_chapter_workflow
from tools.init_project import init_project
from tools.outline_planner import plan_story


def test_plan_story_writes_outline_memory_and_state(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市，证据必须可回溯",
    )

    result = plan_story(project, chapter_count=10)

    assert result["ok"]
    assert result["chapter_count"] == 10
    outline_text = (project / "大纲" / "总纲.md").read_text(encoding="utf-8")
    assert "## 分段结构" in outline_text
    assert "### 第01章" in outline_text
    assert "本章目标" in outline_text

    memory = MemoryManager.from_project(project).load()
    planned = [item for item in memory["timeline"] if item.get("planned")]
    assert len(planned) == 10
    context = ContextManager.from_project(project).build_context(1)
    assert context["scene"]["recent_timeline"] == []
    assert any(rule.get("id") == "wr_story_baseline" for rule in memory["world_rules"])
    progress = StateManager.from_project(project).get_progress()
    assert progress["phase"] == "plan"


def test_commit_chapter_workflow_updates_project_files_state_and_memory(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
    )
    plan_story(project, chapter_count=8)
    draft = tmp_path / "draft.md"
    draft.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。",
        ),
        encoding="utf-8",
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps({"issues": [], "summary": "第1章可提交。"}, ensure_ascii=False),
        encoding="utf-8",
    )
    delta = tmp_path / "delta.json"
    delta.write_text(
        json.dumps(
            {
                "entities_appeared": ["char_protagonist"],
                "new_foreshadowing": [
                    {
                        "id": "fh_001",
                        "content": "不要相信周三",
                        "status": "open",
                        "urgency": "high",
                        "planted_chapter": 1,
                    }
                ],
                "timeline_entry": {
                    "chapter": 1,
                    "time_marker": "葬礼当天",
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

    result = commit_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
        extraction_delta=delta,
    )

    assert result["ok"], result
    assert result["status"] == "accepted"
    assert Path(result["chapter_file"]).is_file()
    assert Path(result["report_file"]).is_file()
    assert Path(result["commit_file"]).is_file()
    assert result["memory_updated"]
    assert result["state_updated"]

    progress = StateManager.from_project(project).get_progress()
    assert progress["current_chapter"] == 1
    assert progress["phase"] == "writing"
    assert progress["total_words"] > 0

    memory = MemoryManager.from_project(project)
    assert memory.get_open_foreshadowing()[0]["id"] == "fh_001"
    assert memory.get_chapter_summaries(1)[0]["title"] == "葬礼后的信"


def test_commit_chapter_workflow_blocks_underlength_draft(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
    )
    plan_story(project, chapter_count=8)
    draft = tmp_path / "draft.md"
    draft.write_text(
        "# 第01章 葬礼后的信\n\n林墨收到亡友寄来的信。",
        encoding="utf-8",
    )

    result = commit_chapter_workflow(project, chapter=1, draft_file=draft)

    assert not result["ok"]
    assert result["stage"] == "word_count"
    assert "正文字数过低" in result["blockers"][0]
    assert result["word_count_check"]["planned_words"] > 0
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0


def test_commit_chapter_workflow_strict_warning_leaves_no_formal_outputs(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
    )
    plan_story(project, chapter_count=8)
    draft = tmp_path / "draft.md"
    draft.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨追查亡友留下的信封，邮戳、门卫证词和旧楼档案互相印证。",
            repeat=90,
        ),
        encoding="utf-8",
    )

    result = commit_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        allow_warnings=False,
    )

    assert not result["ok"]
    assert result["stage"] == "warnings"
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["commit_file"] is None
    assert not any((project / "正文").glob("第01章*.md"))
    assert not (project / "审查报告" / "第01章审查报告.md").exists()
    assert not (project / ".story" / "chapters" / "ch_01_commit.json").exists()
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0


def test_commit_chapter_workflow_infers_title_after_non_heading_line(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
    )
    plan_story(project, chapter_count=8)
    draft = tmp_path / "draft.md"
    draft.write_text(
        "雨先落在解剖楼的铁门上。\n"
        "# 第01章 葬礼后的信\n\n"
        + "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。"
        * 100,
        encoding="utf-8",
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps({"issues": [], "summary": "第1章可提交。"}, ensure_ascii=False),
        encoding="utf-8",
    )

    result = commit_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )

    assert result["ok"], result
    assert result["title"] == "葬礼后的信"
    assert "葬礼后的信" in Path(result["chapter_file"]).name
    commit_payload = json.loads(Path(result["commit_file"]).read_text(encoding="utf-8"))
    assert commit_payload["title"] == "葬礼后的信"


def test_cli_plan_and_write(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
    )

    plan = run_cli(
        "--project-root",
        str(project),
        "plan",
        "--chapter-count",
        "8",
    )
    assert plan.returncode == 0, plan.stderr
    assert json.loads(plan.stdout)["chapter_count"] == 8

    draft = tmp_path / "draft.md"
    draft.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。",
        ),
        encoding="utf-8",
    )
    write = run_cli(
        "--project-root",
        str(project),
        "write",
        "1",
        "--draft-file",
        str(draft),
    )
    assert write.returncode == 0, write.stderr
    payload = json.loads(write.stdout)
    assert payload["status"] == "accepted"
    assert Path(payload["chapter_file"]).is_file()
