from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from core.context_manager import ContextManager
from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from tools.chapter_workflow import commit_chapter_workflow
from tools.init_project import init_project
from tools.outline_planner import plan_story


SCRIPT = SCRIPTS_DIR / "story_craft.py"


def long_chapter(title: str, sentence: str, repeat: int = 100) -> str:
    return f"# {title}\n\n" + sentence * repeat


def run_cli(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class Phase12PlanWriteWorkflowTests(unittest.TestCase):
    def test_plan_story_writes_outline_memory_and_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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

            self.assertTrue(result["ok"])
            self.assertEqual(result["chapter_count"], 10)
            outline_text = (project / "大纲" / "总纲.md").read_text(encoding="utf-8")
            self.assertIn("## 分段结构", outline_text)
            self.assertIn("### 第01章", outline_text)
            self.assertIn("本章目标", outline_text)

            memory = MemoryManager.from_project(project).load()
            planned = [item for item in memory["timeline"] if item.get("planned")]
            self.assertEqual(len(planned), 10)
            context = ContextManager.from_project(project).build_context(1)
            self.assertEqual(context["scene"]["recent_timeline"], [])
            self.assertTrue(
                any(rule.get("id") == "wr_story_baseline" for rule in memory["world_rules"])
            )
            progress = StateManager.from_project(project).get_progress()
            self.assertEqual(progress["phase"], "plan")

    def test_commit_chapter_workflow_updates_project_files_state_and_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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
            draft = Path(temp) / "draft.md"
            draft.write_text(
                long_chapter(
                    "第01章 葬礼后的信",
                    "林墨站在雨里复查亡友留下的信封，雨水、邮戳、门卫证词和旧楼档案不断互相印证。",
                ),
                encoding="utf-8",
            )
            review = Path(temp) / "review.json"
            review.write_text(
                json.dumps({"passed": True, "warnings": []}, ensure_ascii=False),
                encoding="utf-8",
            )
            delta = Path(temp) / "delta.json"
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

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["status"], "accepted")
            self.assertTrue(Path(result["chapter_file"]).is_file())
            self.assertTrue(Path(result["report_file"]).is_file())
            self.assertTrue(Path(result["commit_file"]).is_file())
            self.assertTrue(result["memory_updated"])
            self.assertTrue(result["state_updated"])

            progress = StateManager.from_project(project).get_progress()
            self.assertEqual(progress["current_chapter"], 1)
            self.assertEqual(progress["phase"], "writing")
            self.assertGreater(progress["total_words"], 0)

            memory = MemoryManager.from_project(project)
            self.assertEqual(memory.get_open_foreshadowing()[0]["id"], "fh_001")
            self.assertEqual(memory.get_chapter_summaries(1)[0]["title"], "葬礼后的信")

    def test_commit_chapter_workflow_blocks_underlength_draft(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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
            draft = Path(temp) / "draft.md"
            draft.write_text(
                "# 第01章 葬礼后的信\n\n林墨收到亡友寄来的信。",
                encoding="utf-8",
            )

            result = commit_chapter_workflow(project, chapter=1, draft_file=draft)

            self.assertFalse(result["ok"])
            self.assertEqual(result["stage"], "word_count")
            self.assertIn("正文字数过低", result["blockers"][0])
            self.assertGreater(result["word_count_check"]["planned_words"], 0)
            self.assertEqual(StateManager.from_project(project).get_progress()["current_chapter"], 0)

    def test_commit_chapter_workflow_strict_warning_leaves_no_formal_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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
            draft = Path(temp) / "draft.md"
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

            self.assertFalse(result["ok"])
            self.assertEqual(result["stage"], "warnings")
            self.assertIsNone(result["chapter_file"])
            self.assertIsNone(result["report_file"])
            self.assertIsNone(result["commit_file"])
            self.assertFalse(any((project / "正文").glob("第01章*.md")))
            self.assertFalse((project / "审查报告" / "第01章审查报告.md").exists())
            self.assertFalse((project / ".story" / "chapters" / "ch_01_commit.json").exists())
            self.assertEqual(StateManager.from_project(project).get_progress()["current_chapter"], 0)

    def test_phase12_cli_plan_and_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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
            self.assertEqual(plan.returncode, 0, plan.stderr)
            self.assertEqual(json.loads(plan.stdout)["chapter_count"], 8)

            draft = Path(temp) / "draft.md"
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
            self.assertEqual(write.returncode, 0, write.stderr)
            payload = json.loads(write.stdout)
            self.assertEqual(payload["status"], "accepted")
            self.assertTrue(Path(payload["chapter_file"]).is_file())


if __name__ == "__main__":
    unittest.main()
