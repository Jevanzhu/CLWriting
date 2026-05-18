from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from core.chapter_commit import ChapterCommitService
from core.chapter_paths import chapter_commit_file_name, chapter_file_name, find_chapter_file
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import atomic_write_json
from core.state_manager import SCHEMA_VERSION, StateManager
from core.text_utils import compact_line, count_chinese_chars, first_int, outline_value
from tools.init_project import init_project


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class Phase2StorageTests(unittest.TestCase):
    def test_text_utils_cover_shared_low_level_parsing(self) -> None:
        self.assertEqual(count_chinese_chars("ABC林墨12雨"), 3)
        self.assertEqual(compact_line("  第一行\n\n第二行  ", max_length=20), "第一行 第二行")
        self.assertEqual(compact_line("", fallback="未补充"), "未补充")
        self.assertEqual(first_int("预计 3200 字"), 3200)
        self.assertEqual(outline_value("- 预计字数：3200", "预计字数"), "3200")

    def test_init_project_creates_phase2_storage_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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

            self.assertTrue(Path(result["state_file"]).is_file())
            self.assertTrue(Path(result["memory_file"]).is_file())
            self.assertTrue(Path(result["learning_file"]).is_file())
            self.assertTrue((project / "大纲" / "总纲.md").is_file())
            self.assertTrue((project / "设定集" / "世界观.md").is_file())
            self.assertTrue((project / "设定集" / "主角卡.md").is_file())
            self.assertTrue((project / "设定集" / "独特优势.md").is_file())
            self.assertTrue((project / "设定集" / "反派设计.md").is_file())

            state = read_json(project / ".story" / "state.json")
            memory = read_json(project / ".story" / "memory.json")

            self.assertEqual(state["schema_version"], SCHEMA_VERSION)
            self.assertEqual(state["project"]["title"], "暗室")
            self.assertEqual(state["creative_constraints"]["one_liner"], "法医收到亡友来信")
            self.assertEqual(state["creative_constraints"]["score"]["total"], 0.0)
            self.assertTrue(state["generated_files"]["outline"])
            self.assertTrue(state["generated_files"]["unique_advantage"])
            self.assertEqual(memory["characters"][0]["id"], "char_protagonist")
            self.assertEqual(
                memory["characters"][0]["unique_advantage"]["description"],
                "法医病理学",
            )

    def test_state_manager_completes_nested_schema_and_merges_word_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑")
            state_file = project / ".story" / "state.json"
            state = read_json(state_file)
            state["creative_constraints"]["score"] = {"novelty": 88.0}
            atomic_write_json(state_file, state, use_lock=False, backup=False)

            manager = StateManager.from_project(project)
            constraints = manager.get_creative_constraints()
            self.assertEqual(constraints["score"]["novelty"], 88.0)
            self.assertEqual(constraints["score"]["writability"], 0.0)
            self.assertEqual(constraints["score"]["ending_power"], 0.0)
            self.assertEqual(constraints["score"]["total"], 0.0)

            first = StateManager.from_project(project)
            second = StateManager.from_project(project)
            first.update_progress(chapter=1, words_delta=1000, phase="writing")
            second.update_progress(chapter=2, words_delta=1200, phase="writing")
            first.flush()
            second.flush()

            progress = StateManager.from_project(project).get_progress()
            self.assertEqual(progress["current_chapter"], 2)
            self.assertEqual(progress["total_words"], 2200)
            self.assertEqual(progress["phase"], "writing")

    def test_state_manager_flush_merges_pending_with_latest_disk_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑")

            first = StateManager.from_project(project)
            second = StateManager.from_project(project)
            first.update_project(title="雨夜档案")
            second.mark_file_generated("outline")
            first.flush()
            second.flush()

            state = StateManager.from_project(project).get_full_state()
            self.assertEqual(state["project"]["title"], "雨夜档案")
            self.assertTrue(state["generated_files"]["outline"])

    def test_memory_manager_applies_chapter_delta(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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

            self.assertIsNotNone(protagonist)
            self.assertEqual(protagonist["current_status"], "发现被跟踪")
            self.assertEqual(protagonist["last_appearance_chapter"], 2)
            self.assertIsNotNone(old_zhou)
            self.assertEqual(old_zhou["id"], "char_zhou")
            self.assertEqual(old_zhou["last_appearance_chapter"], 2)
            self.assertEqual(reloaded.get_open_foreshadowing(), [])
            self.assertEqual(reloaded.load()["foreshadowing"][0]["resolved_chapter"], 2)
            self.assertEqual(reloaded.get_world_rules()[0]["id"], "wr_001")
            self.assertEqual(reloaded.get_recent_timeline()[0]["chapter"], 2)
            self.assertEqual(reloaded.get_chapter_summaries(2)[0]["title"], "档案室")
            self.assertFalse(reloaded.use_sqlite)

    def test_chapter_commit_service_updates_state_and_memory_only_when_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑", protagonist_name="林墨")
            service = ChapterCommitService(StoryCraftConfig.from_project_root(project))

            rejected = service.commit(
                1,
                "退稿章",
                900,
                {"passed": False, "blockers": [{"category": "continuity"}]},
                {"chapter_summary": {"chapter": 1, "title": "退稿章", "summary": "不应入库"}},
            )
            self.assertEqual(rejected["status"], "rejected")
            self.assertFalse(rejected["memory_updated"])
            self.assertFalse(rejected["state_updated"])
            self.assertEqual(StateManager.from_project(project).get_progress()["total_words"], 0)
            self.assertEqual(MemoryManager.from_project(project).get_chapter_summaries(), [])

            accepted = service.commit(
                1,
                "葬礼后的信",
                1800,
                {"passed": True, "warnings": [{"category": "pacing"}], "issue_count": 1},
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

            self.assertEqual(accepted["status"], "accepted")
            self.assertTrue(accepted["memory_updated"])
            self.assertTrue(accepted["state_updated"])
            self.assertTrue(Path(accepted["commit_file"]).is_file())

            commit_payload = read_json(Path(accepted["commit_file"]))
            self.assertEqual(commit_payload["status"], "accepted")
            self.assertEqual(commit_payload["review"]["warnings"][0]["category"], "pacing")
            self.assertEqual(commit_payload["scenes"][0]["summary"], "葬礼")
            self.assertEqual(StateManager.from_project(project).get_progress()["total_words"], 1800)
            self.assertEqual(
                MemoryManager.from_project(project).get_chapter_summaries(1)[0]["summary"],
                "林墨收到亡友来信",
            )

    def test_chapter_path_helpers_find_numbered_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑")
            config = StoryCraftConfig.from_project_root(project)
            chapter_path = config.project_chapters_dir / chapter_file_name(2, "档案室/凌晨")
            chapter_path.write_text("# 第02章\n", encoding="utf-8")

            self.assertEqual(chapter_file_name(2, "档案室/凌晨"), "第02章-凌晨.md")
            self.assertEqual(chapter_commit_file_name(2), "ch_02_commit.json")
            self.assertEqual(find_chapter_file(2, config=config), chapter_path)


if __name__ == "__main__":
    unittest.main()
