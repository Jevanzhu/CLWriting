from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from conftest import long_chapter, run_cli
from core.commit_store import CommitStore
from core.context_manager import ContextManager
from core.contract_store import ContractStore
from core.memory_manager import MemoryManager
from core.security_utils import AtomicWriteError
from core.state_manager import StateManager
import tools.chapter_workflow as chapter_workflow_module
from tools.chapter_workflow import record_chapter_workflow
from tools.init_project import init_project
from tools.outline_planner import plan_story


REQUIRED_FAILURE_KEYS = {
    "ok",
    "stage",
    "blockers",
    "warnings",
    "chapter_file",
    "report_file",
    "record_file",
    "draft_file",
}


def assert_failure_shape(result, draft_file, *, word_count_check=False):
    assert REQUIRED_FAILURE_KEYS <= set(result)
    assert result["ok"] is False
    assert isinstance(result["blockers"], list)
    assert isinstance(result["warnings"], list)
    assert result["draft_file"] == str(Path(draft_file).resolve())
    if word_count_check:
        assert "word_count_check" in result


class FakeEmbeddingClient:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[float(index + 1), float(len(text))] for index, text in enumerate(texts)]


def _sqlite_count(path: Path, table: str) -> int:
    with sqlite3.connect(path) as conn:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


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

    store = ContractStore.from_project(project)
    chapter_one = store.read_chapter(1)
    assert chapter_one is not None
    assert chapter_one["contract_version"] == "story-craft/contract-v1"
    assert chapter_one["chapter"] == 1
    assert chapter_one["title"] == "开篇异常"
    assert chapter_one["planned_word_count"] == 3000
    assert chapter_one["chapter_directive"].startswith("让林墨遇到")
    assert chapter_one["must_cover"] == [
        "日常秩序与异常证据正面冲突。",
        "埋设核心谜面或情绪债。",
    ]
    assert chapter_one["open_loops_to_plant"] == ["埋设核心谜面或情绪债。"]
    assert chapter_one["open_loops_to_close"] == []
    assert chapter_one["expected_strand"] == "quest"
    assert chapter_one["volume"] == 0
    assert chapter_one["forbidden_zones"] == []
    assert chapter_one["created_at"]
    assert chapter_one["updated_at"] == chapter_one["created_at"]
    assert store.read_chapter(10)["planned_word_count"] == 3000

    memory = MemoryManager.from_project(project).load()
    planned = [item for item in memory["timeline"] if item.get("planned")]
    assert len(planned) == 10
    context = ContextManager.from_project(project).build_context(1)
    assert context["scene"]["recent_timeline"] == []
    assert any(rule.get("id") == "wr_story_baseline" for rule in memory["world_rules"])
    progress = StateManager.from_project(project).get_progress()
    assert progress["phase"] == "plan"


def test_plan_story_dry_run_does_not_write_chapter_contracts(tmp_path):
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
    outline_file = project / "大纲" / "总纲.md"
    outline_before = outline_file.read_text(encoding="utf-8")

    result = plan_story(project, chapter_count=8, dry_run=True)

    assert result["ok"]
    assert result["dry_run"] is True
    assert outline_file.read_text(encoding="utf-8") == outline_before
    assert ContractStore.from_project(project).read_chapter(1) is None
    assert not list((project / ".story" / "contracts" / "chapters").glob("*.json"))


def test_record_chapter_workflow_updates_project_files_state_and_memory(tmp_path):
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

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
        extraction_delta=delta,
    )

    assert result["ok"], result
    assert result["status"] == "accepted"
    assert result["review_status"] == "provided"
    assert Path(result["chapter_file"]).is_file()
    assert Path(result["report_file"]).is_file()
    assert Path(result["record_file"]).is_file()
    assert Path(result["commit_file"]).is_file()
    assert result["memory_updated"]
    assert result["state_updated"]
    assert result["projections"]["state"]["ok"]
    assert result["projections"]["memory"]["ok"]
    assert result["projections"]["summary"]["ok"]
    assert result["projections"]["markdown_view"]["ok"]

    progress = StateManager.from_project(project).get_progress()
    assert progress["current_chapter"] == 1
    assert progress["phase"] == "writing"
    assert progress["total_words"] > 0

    memory = MemoryManager.from_project(project)
    assert memory.get_open_foreshadowing()[0]["id"] == "fh_001"
    assert memory.get_chapter_summaries(1)[0]["title"] == "葬礼后的信"
    commit = CommitStore.from_project(project).read(1)
    assert commit["status"] == "accepted"
    assert commit["review_meta"]["source"] == "agent"


def test_record_chapter_workflow_blocks_underlength_draft(tmp_path):
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
        "林墨收到亡友寄来的信。",
        encoding="utf-8",
    )

    result = record_chapter_workflow(project, chapter=1, draft_file=draft)

    assert not result["ok"]
    assert result["stage"] == "word_count"
    assert_failure_shape(result, draft, word_count_check=True)
    assert "正文字数过低" in result["blockers"][0]
    assert result["word_count_check"]["planned_words"] > 0
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0


def test_record_chapter_workflow_blocks_markdown_residue(tmp_path):
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
        "# 第01章 葬礼后的信\n\n"
        + "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。"
        * 100,
        encoding="utf-8",
    )

    result = record_chapter_workflow(project, chapter=1, draft_file=draft)

    assert not result["ok"]
    assert result["stage"] == "markdown"
    assert_failure_shape(result, draft)
    assert "Markdown 残留" in result["blockers"][0]
    assert result["markdown_residue"]["value"] > 0
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["record_file"] is None
    assert not any((project / "正文").glob("第01章*.md"))


def test_record_chapter_workflow_placeholder_failure_has_common_shape(tmp_path):
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
        "这里有[TODO:补线索]，不允许提交。",
        encoding="utf-8",
    )

    result = record_chapter_workflow(project, chapter=1, draft_file=draft)

    assert result["stage"] == "placeholder"
    assert_failure_shape(result, draft)
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["record_file"] is None
    assert result["placeholders"]
    assert not any((project / "正文").glob("第01章*.md"))


def test_record_chapter_workflow_strict_warning_leaves_no_formal_outputs(tmp_path):
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

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        allow_warnings=False,
    )

    assert not result["ok"]
    assert result["stage"] == "warnings"
    assert_failure_shape(result, draft, word_count_check=True)
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["record_file"] is None
    assert not any((project / "正文").glob("第01章*.md"))
    assert not (project / "审查报告" / "第01章审查报告.md").exists()
    assert not (project / ".story" / "chapters" / "ch_01_record.json").exists()
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0


def test_record_chapter_workflow_uses_contract_title_for_clean_prose(tmp_path):
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
        + "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。"
        * 100,
        encoding="utf-8",
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps({"issues": [], "summary": "第1章可提交。"}, ensure_ascii=False),
        encoding="utf-8",
    )

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )

    assert result["ok"], result
    assert result["title"] == "开篇异常"
    assert "开篇异常" in Path(result["chapter_file"]).name
    assert Path(result["commit_file"]).is_file()
    record_payload = json.loads(Path(result["record_file"]).read_text(encoding="utf-8"))
    assert record_payload["title"] == "开篇异常"


def test_record_chapter_workflow_blocks_completed_chapter(tmp_path):
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

    first = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )
    progress_after_first = StateManager.from_project(project).get_progress()
    second = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )
    progress_after_second = StateManager.from_project(project).get_progress()

    assert first["ok"], first
    assert not second["ok"]
    assert second["stage"] == "prewrite"
    assert_failure_shape(second, draft)
    assert any("目标章节不大于当前进度" in item for item in second["blockers"])
    assert progress_after_second["total_words"] == progress_after_first["total_words"]
    assert progress_after_second["current_chapter"] == 1


def test_record_chapter_workflow_rejects_mismatched_delta_chapter(tmp_path):
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
                "chapter": 2,
                "timeline_entry": {"chapter": 2, "events": ["错位事件"]},
                "chapter_summary": {
                    "chapter": 2,
                    "title": "错位章节",
                    "summary": "不应写入",
                },
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
        extraction_delta=delta,
    )
    progress = StateManager.from_project(project).get_progress()
    memory = MemoryManager.from_project(project).load()

    assert not result["ok"]
    assert result["stage"] == "delta_validation"
    assert_failure_shape(result, draft, word_count_check=True)
    assert any("与目标章节 1 不一致" in item for item in result["blockers"])
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["record_file"] is None
    assert progress["current_chapter"] == 0
    assert progress["total_words"] == 0
    assert memory["last_updated_chapter"] == 0
    assert not [item for item in memory["timeline"] if not item.get("planned")]
    assert memory["chapter_summaries"] == []
    assert not any((project / "正文").glob("第01章*.md"))
    assert not (project / ".story" / "chapters" / "ch_01_record.json").exists()


def test_record_chapter_workflow_warns_when_delta_chapter_is_missing(tmp_path):
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
                "timeline_entry": {"events": ["林墨收到亡友来信"]},
                "chapter_summary": {
                    "title": "葬礼后的信",
                    "summary": "林墨收到亡友来信",
                },
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
        extraction_delta=delta,
    )

    assert result["ok"], result
    assert result["status"] == "accepted"
    assert any("delta.chapter 缺失，已补齐为 1" in item for item in result["warnings"])
    assert any(
        "delta.timeline_entry.chapter 缺失，已补齐为 1" in item
        for item in result["warnings"]
    )
    assert any(
        "delta.chapter_summary.chapter 缺失，已补齐为 1" in item
        for item in result["warnings"]
    )
    record_payload = json.loads(Path(result["record_file"]).read_text(encoding="utf-8"))
    assert record_payload["delta"]["chapter"] == 1
    assert record_payload["delta"]["timeline_entry"]["chapter"] == 1
    assert record_payload["delta"]["chapter_summary"]["chapter"] == 1


def test_record_chapter_workflow_does_not_record_when_chapter_write_fails(
    tmp_path,
    monkeypatch,
):
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

    original_atomic_write_text = chapter_workflow_module.atomic_write_text

    def fail_chapter_write(path, data, **kwargs):
        if Path(path).parent == project / "正文":
            raise AtomicWriteError("模拟正文写入失败")
        return original_atomic_write_text(path, data, **kwargs)

    monkeypatch.setattr(
        chapter_workflow_module,
        "atomic_write_text",
        fail_chapter_write,
    )

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )

    progress = StateManager.from_project(project).get_progress()
    memory = MemoryManager.from_project(project).load()
    assert not result["ok"]
    assert result["stage"] == "write_error"
    assert_failure_shape(result, draft, word_count_check=True)
    assert result["status"] == "failed"
    assert result["chapter_file"] is None
    assert result["report_file"] is None
    assert result["record_file"] is None
    assert any("正式写入失败" in item for item in result["blockers"])
    assert progress["current_chapter"] == 0
    assert progress["total_words"] == 0
    assert memory["last_updated_chapter"] == 0
    assert memory["chapter_summaries"] == []
    assert not any((project / "正文").glob("第01章*.md"))
    assert not (project / ".story" / "chapters" / "ch_01_record.json").exists()


def test_record_chapter_workflow_rolls_back_sqlite_projections_when_chapter_write_fails(
    tmp_path,
    monkeypatch,
):
    import core.projection.vector_writer as vector_writer

    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        protagonist_name="林墨",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市",
        project_type="long",
    )
    plan_story(project, chapter_count=8)
    monkeypatch.setattr(vector_writer, "EmbeddingClient", lambda config=None: FakeEmbeddingClient())

    draft_one = tmp_path / "draft-1.md"
    draft_one.write_text(
        long_chapter(
            "第01章 葬礼后的信",
            "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。",
        ),
        encoding="utf-8",
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps({"issues": [], "summary": "章节可提交。"}, ensure_ascii=False),
        encoding="utf-8",
    )

    first = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft_one,
        review_results=review,
    )

    config = StateManager.from_project(project).config
    assert first["ok"], first
    assert config.index_db.exists()
    assert config.vector_db.exists()
    assert _sqlite_count(config.index_db, "entries") > 0
    assert _sqlite_count(config.vector_db, "chunks") > 0
    index_before = config.index_db.read_bytes()
    vector_before = config.vector_db.read_bytes()

    draft_two = tmp_path / "draft-2.md"
    draft_two.write_text(
        long_chapter(
            "第02章 旧楼档案",
            "林墨沿着旧楼档案追查缺页报告，门禁记录、雨夜脚印和电话录音逐步拼出新的矛盾。",
        ),
        encoding="utf-8",
    )
    original_atomic_write_text = chapter_workflow_module.atomic_write_text

    def fail_chapter_write(path, data, **kwargs):
        if Path(path).parent == project / "正文":
            raise AtomicWriteError("模拟正文写入失败")
        return original_atomic_write_text(path, data, **kwargs)

    monkeypatch.setattr(
        chapter_workflow_module,
        "atomic_write_text",
        fail_chapter_write,
    )

    result = record_chapter_workflow(
        project,
        chapter=2,
        draft_file=draft_two,
        review_results=review,
    )

    progress = StateManager.from_project(project).get_progress()
    memory = MemoryManager.from_project(project).load()
    assert not result["ok"]
    assert result["stage"] == "write_error"
    assert_failure_shape(result, draft_two, word_count_check=True)
    assert result["status"] == "failed"
    assert any("正式写入失败" in item for item in result["blockers"])
    assert progress["current_chapter"] == 1
    assert memory["last_updated_chapter"] == 1
    assert CommitStore.from_project(project).read(2) is None
    assert not any((project / "正文").glob("第02章*.md"))
    assert config.index_db.read_bytes() == index_before
    assert config.vector_db.read_bytes() == vector_before


def test_record_chapter_workflow_does_not_write_chapter_when_record_rejects(
    tmp_path,
    monkeypatch,
):
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

    class RejectingRecordService:
        def __init__(self, config):
            self.config = config

        def record(self, *args, **kwargs):
            record_file = self.config.chapters_dir / "ch_01_record.json"
            record_file.parent.mkdir(parents=True, exist_ok=True)
            record_file.write_text(
                json.dumps({"chapter": 1, "status": "rejected"}, ensure_ascii=False),
                encoding="utf-8",
            )
            return {
                "record_file": str(record_file),
                "status": "rejected",
                "memory_updated": False,
                "state_updated": False,
            }

    monkeypatch.setattr(
        chapter_workflow_module,
        "ChapterRecordService",
        RejectingRecordService,
    )

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )

    assert not result["ok"]
    assert result["stage"] == "record"
    assert result["status"] == "rejected"
    assert result["chapter_file"] is None
    assert Path(result["record_file"]).is_file()
    assert Path(result["report_file"]).is_file()
    assert not any((project / "正文").glob("第01章*.md"))
    assert StateManager.from_project(project).get_progress()["current_chapter"] == 0
    assert MemoryManager.from_project(project).load()["last_updated_chapter"] == 0


def test_record_chapter_workflow_rolls_back_when_record_write_fails(
    tmp_path,
    monkeypatch,
):
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

    class FailingRecordService:
        def __init__(self, config):
            self.config = config

        def record(self, *args, **kwargs):
            raise AtomicWriteError("模拟 record 写入失败")

    monkeypatch.setattr(
        chapter_workflow_module,
        "ChapterRecordService",
        FailingRecordService,
    )

    result = record_chapter_workflow(
        project,
        chapter=1,
        draft_file=draft,
        review_results=review,
    )
    progress = StateManager.from_project(project).get_progress()
    memory = MemoryManager.from_project(project).load()

    assert not result["ok"]
    assert result["stage"] == "write_error"
    assert_failure_shape(result, draft, word_count_check=True)
    assert result["status"] == "failed"
    assert progress["current_chapter"] == 0
    assert progress["total_words"] == 0
    assert memory["last_updated_chapter"] == 0
    assert memory["chapter_summaries"] == []
    assert not any((project / "正文").glob("第01章*.md"))
    assert not (project / "审查报告" / "第01章审查报告.md").exists()
    assert not (project / ".story" / "chapters" / "ch_01_record.json").exists()


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
    assert payload["review_status"] == "skipped"
    assert Path(payload["chapter_file"]).is_file()
    commit = json.loads(Path(payload["commit_file"]).read_text(encoding="utf-8"))
    assert commit["review_meta"]["source"] == "fallback"

    draft_two = tmp_path / "draft-2.md"
    draft_two.write_text(
        long_chapter(
            "第02章 旧楼档案",
            "林墨沿着旧楼档案追查缺页报告，门禁记录、雨夜脚印和电话录音逐步拼出新的矛盾。",
        ),
        encoding="utf-8",
    )
    require_review = run_cli(
        "--project-root",
        str(project),
        "write",
        "2",
        "--draft-file",
        str(draft_two),
        "--require-review",
    )
    assert require_review.returncode == 1
    blocked = json.loads(require_review.stdout)
    assert blocked["stage"] == "prewrite"
    assert blocked["review_status"] == "skipped"
    assert "未提供 reviewer 结果" in blocked["blockers"][0]
    assert not (project / ".story" / "commits" / "chapter_002.commit.json").exists()
