from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import run_cli
from core.chapter_commit import ChapterCommitService
from core.chapter_paths import chapter_commit_file_name, chapter_file_name, find_chapter_file
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import atomic_write_json
from core.state_manager import SCHEMA_VERSION, StateManager
from core.text_utils import compact_line, count_chinese_chars, first_int, outline_value
from tools.agent_workflow import normalize_reviewer_output
from tools.init_project import init_project


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_text_utils_cover_shared_low_level_parsing():
    assert count_chinese_chars("ABC林墨12雨") == 3
    assert compact_line("  第一行\n\n第二行  ", max_length=20) == "第一行 第二行"
    assert compact_line("", fallback="未补充") == "未补充"
    assert first_int("预计 3200 字") == 3200
    assert outline_value("- 预计字数：3200", "预计字数") == "3200"


def test_init_project_creates_storage_files(tmp_path):
    project = tmp_path / "demo"
    result = init_project(
        project,
        "暗室",
        "悬疑",
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
        protagonist_flaw="过度依赖证据",
        unique_advantage_type="特殊知识",
        unique_advantage_desc="法医病理学",
        antagonist_mirror="反派同样追求完整真相",
    )

    assert Path(result["state_file"]).is_file()
    assert Path(result["memory_file"]).is_file()
    assert Path(result["learning_file"]).is_file()
    assert (project / "大纲" / "总纲.md").is_file()
    assert (project / "设定集" / "世界观.md").is_file()
    assert (project / "设定集" / "主角卡.md").is_file()
    assert (project / "设定集" / "独特优势.md").is_file()
    assert (project / "设定集" / "反派设计.md").is_file()

    state = read_json(project / ".story" / "state.json")
    memory = read_json(project / ".story" / "memory.json")

    assert state["schema_version"] == SCHEMA_VERSION
    assert state["project"]["title"] == "暗室"
    assert state["creative_constraints"]["one_liner"] == "法医收到亡友来信"
    assert state["creative_constraints"]["score"]["total"] == 0.0
    assert state["generated_files"]["outline"]
    assert state["generated_files"]["unique_advantage"]
    assert memory["characters"][0]["id"] == "char_protagonist"
    assert memory["characters"][0]["unique_advantage"]["description"] == "法医病理学"


def test_state_manager_completes_nested_schema_and_merges_word_deltas(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    state_file = project / ".story" / "state.json"
    state = read_json(state_file)
    state["creative_constraints"]["score"] = {"novelty": 88.0}
    atomic_write_json(state_file, state, use_lock=False, backup=False)

    manager = StateManager.from_project(project)
    constraints = manager.get_creative_constraints()
    assert constraints["score"]["novelty"] == 88.0
    assert constraints["score"]["writability"] == 0.0
    assert constraints["score"]["ending_power"] == 0.0
    assert constraints["score"]["total"] == 0.0

    first = StateManager.from_project(project)
    second = StateManager.from_project(project)
    first.update_progress(chapter=1, words_delta=1000, phase="writing")
    second.update_progress(chapter=2, words_delta=1200, phase="writing")
    first.flush()
    second.flush()

    progress = StateManager.from_project(project).get_progress()
    assert progress["current_chapter"] == 2
    assert progress["total_words"] == 2200
    assert progress["phase"] == "writing"


def test_state_manager_flush_merges_pending_with_latest_disk_state(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    first = StateManager.from_project(project)
    second = StateManager.from_project(project)
    first.update_project(title="雨夜档案")
    second.mark_file_generated("outline")
    first.flush()
    second.flush()

    state = StateManager.from_project(project).get_full_state()
    assert state["project"]["title"] == "雨夜档案"
    assert state["generated_files"]["outline"]


def test_memory_manager_applies_chapter_delta(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑", protagonist_name="林墨")
    memory = MemoryManager.from_project(project)
    memory.upsert_foreshadowing(
        {
            "id": "fh_001",
            "content": "天台纸条",
            "status": "open",
            "urgency": "high",
            "planted_chapter": 1,
        }
    )

    memory.apply_chapter_delta(
        {
            "chapter": 2,
            "entities_new": [
                {
                    "suggested_id": "char_zhou",
                    "name": "老周",
                    "role": "minor",
                    "tier": "装饰",
                }
            ],
            "entities_appeared": ["char_protagonist", "char_zhou"],
            "state_changes": [
                {
                    "entity_id": "char_protagonist",
                    "field": "current_status",
                    "new": "发现被跟踪",
                }
            ],
            "resolved_foreshadowing": ["fh_001"],
            "new_world_rules": [{"id": "wr_001", "rule": "记忆不可逆"}],
            "timeline_entry": {"chapter": 2, "events": ["潜入档案室"]},
            "chapter_summary": {
                "chapter": 2,
                "title": "档案室",
                "summary": "林墨找到异常报告",
                "word_count": 3000,
            },
        }
    )
    memory.flush()

    reloaded = MemoryManager.from_project(project)
    protagonist = reloaded.get_character("char_protagonist")
    old_zhou = reloaded.get_character("char_zhou")

    assert protagonist is not None
    assert protagonist["current_status"] == "发现被跟踪"
    assert protagonist["last_appearance_chapter"] == 2
    assert old_zhou is not None
    assert old_zhou["id"] == "char_zhou"
    assert old_zhou["last_appearance_chapter"] == 2
    assert reloaded.get_open_foreshadowing() == []
    assert reloaded.load()["foreshadowing"][0]["resolved_chapter"] == 2
    assert reloaded.get_world_rules()[0]["id"] == "wr_001"
    assert reloaded.get_recent_timeline()[0]["chapter"] == 2
    assert reloaded.get_chapter_summaries(2)[0]["title"] == "档案室"
    assert not reloaded.use_sqlite


def test_chapter_commit_service_updates_state_and_memory_only_when_accepted(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑", protagonist_name="林墨")
    service = ChapterCommitService(StoryCraftConfig.from_project_root(project))

    rejected = service.commit(
        1,
        "退稿章",
        900,
        normalize_reviewer_output(
            {"issues": [{"category": "continuity", "blocking": True}], "summary": "不通过。"}
        ),
        {"chapter_summary": {"chapter": 1, "title": "退稿章", "summary": "不应入库"}},
    )
    assert rejected["status"] == "rejected"
    assert not rejected["memory_updated"]
    assert not rejected["state_updated"]
    assert StateManager.from_project(project).get_progress()["total_words"] == 0
    assert MemoryManager.from_project(project).get_chapter_summaries() == []

    accepted = service.commit(
        1,
        "葬礼后的信",
        1800,
        normalize_reviewer_output({"issues": [{"category": "pacing"}], "summary": "可提交。"}),
        {
            "entities_appeared": ["char_protagonist"],
            "chapter_summary": {
                "chapter": 1,
                "title": "葬礼后的信",
                "summary": "林墨收到亡友来信",
                "word_count": 1800,
            },
            "timeline_entry": {"chapter": 1, "events": ["收到信件"]},
            "scenes": [{"index": 1, "summary": "葬礼"}],
        },
    )

    assert accepted["status"] == "accepted"
    assert accepted["memory_updated"]
    assert accepted["state_updated"]
    assert Path(accepted["commit_file"]).is_file()

    commit_payload = read_json(Path(accepted["commit_file"]))
    assert commit_payload["status"] == "accepted"
    assert commit_payload["review"]["warnings"][0]["category"] == "pacing"
    assert commit_payload["review"]["issue_count"] == 1
    assert commit_payload["review"]["blocker_count"] == 0
    assert commit_payload["scenes"][0]["summary"] == "葬礼"
    assert StateManager.from_project(project).get_progress()["total_words"] == 1800
    assert (
        MemoryManager.from_project(project).get_chapter_summaries(1)[0]["summary"]
        == "林墨收到亡友来信"
    )


def test_chapter_commit_service_requires_normalized_review_result(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑", protagonist_name="林墨")
    service = ChapterCommitService(StoryCraftConfig.from_project_root(project))

    with pytest.raises(ValueError, match="normalize_reviewer_output"):
        service.commit(
            1,
            "未归一化",
            900,
            {"issues": [{"category": "logic", "blocking": True}]},  # type: ignore[arg-type]
            {"chapter_summary": {"chapter": 1, "title": "未归一化", "summary": "不应入库"}},
        )

    assert StateManager.from_project(project).get_progress()["total_words"] == 0
    assert MemoryManager.from_project(project).get_chapter_summaries() == []


def test_chapter_path_helpers_find_numbered_markdown(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    config = StoryCraftConfig.from_project_root(project)
    chapter_path = config.project_chapters_dir / chapter_file_name(2, "档案室/凌晨")
    chapter_path.write_text("# 第02章\n", encoding="utf-8")

    assert chapter_file_name(2, "档案室/凌晨") == "第02章-凌晨.md"
    assert chapter_commit_file_name(2) == "ch_02_commit.json"
    assert find_chapter_file(2, config=config) == chapter_path
