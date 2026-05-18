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

from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from tools.agent_workflow import (
    build_extraction_delta,
    build_polish_plan,
    build_repair_plan,
    build_workflow_workspace,
    build_writing_brief,
)
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


def create_planned_project(root: Path) -> Path:
    project = root / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
        protagonist_desire="查清亡友死因",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市，证据必须可回溯",
    )
    plan_story(project, chapter_count=8)
    return project


class Phase13AgentWorkflowTests(unittest.TestCase):
    def test_build_writing_brief_matches_context_agent_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_planned_project(Path(temp))

            brief = build_writing_brief(project, 1)

            self.assertTrue(brief["ok"])
            self.assertEqual(brief["meta"]["chapter"], 1)
            self.assertEqual(brief["meta"]["title"], "开篇异常")
            self.assertIn("core_mission", brief)
            self.assertTrue(brief["core_mission"]["must_accomplish"])
            self.assertIn("scene_and_characters", brief)
            self.assertIn("continuity", brief)
            self.assertIn("writing_guidance", brief)

            output_file = Path(temp) / "brief.json"
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
            self.assertEqual(cli.returncode, 0, cli.stderr)
            self.assertTrue(output_file.is_file())
            self.assertEqual(json.loads(output_file.read_text(encoding="utf-8"))["meta"]["title"], "开篇异常")

    def test_workflow_manifest_commands_quote_paths_with_spaces(self) -> None:
        with tempfile.TemporaryDirectory(prefix="story craft ") as temp:
            project = create_planned_project(Path(temp) / "demo project")

            manifest = build_workflow_workspace(project, 1)
            command = manifest["cli_commands"]["prepare_brief_fallback"]

            self.assertIn("'", command)
            self.assertIn("demo project", command)
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            brief_file = Path(manifest["files"]["brief"])
            self.assertTrue(brief_file.is_file())
            self.assertEqual(json.loads(brief_file.read_text(encoding="utf-8"))["meta"]["chapter"], 1)

    def test_workflow_manifest_write_command_persists_write_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="story craft ") as temp:
            project = create_planned_project(Path(temp) / "demo project")
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
                json.dumps({"passed": True, "warnings": []}, ensure_ascii=False),
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
            self.assertIn("--result-file", command)
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result_file.is_file())
            payload = json.loads(result_file.read_text(encoding="utf-8"))
            stdout_payload = json.loads(result.stdout)
            self.assertEqual(payload["stage"], "commit")
            self.assertEqual(payload["status"], "accepted")
            self.assertIn("word_count_check", payload)
            self.assertEqual(stdout_payload["commit_file"], payload["commit_file"])

    def test_repair_and_polish_plans_handle_reviewer_issues(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_planned_project(Path(temp))
            draft = Path(temp) / "draft.md"
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
            self.assertTrue(repair["ok"])
            self.assertFalse(repair["can_commit"])
            self.assertTrue(repair["retry_required"])
            self.assertEqual(repair["blocker_actions"][0]["instruction"], "删掉未获得的信息来源")

            polish = build_polish_plan(project, 1, draft, review_result=review_result)
            self.assertTrue(polish["ok"])
            self.assertTrue(any(item["category"] == "ai_flavor" for item in polish["actions"]))
            self.assertIn("不改变已发生事实", polish["red_lines"])

    def test_raw_reviewer_issues_block_commit_and_keep_state_memory_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_planned_project(Path(temp))
            draft = Path(temp) / "draft.md"
            draft.write_text(
                long_chapter(
                    "第01章 葬礼后的信",
                    "林墨站在雨里复查亡友留下的信封，信件来源、旧楼档案和监控黑屏共同指向更深的隐瞒。",
                ),
                encoding="utf-8",
            )
            review = Path(temp) / "review.json"
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

            result = commit_chapter_workflow(
                project,
                chapter=1,
                draft_file=draft,
                review_results=review,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "rejected")
            self.assertFalse(result["memory_updated"])
            self.assertFalse(result["state_updated"])
            self.assertIsNone(result["chapter_file"])
            self.assertTrue(Path(result["report_file"]).is_file())
            self.assertTrue(Path(result["commit_file"]).is_file())
            self.assertFalse(any((project / "正文").glob("第01章*.md")))
            self.assertEqual(StateManager.from_project(project).get_progress()["current_chapter"], 0)
            self.assertEqual(MemoryManager.from_project(project).load()["last_updated_chapter"], 0)

    def test_extraction_delta_matches_known_character_and_cli_extract(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_planned_project(Path(temp))
            chapter = Path(temp) / "chapter.md"
            chapter.write_text(
                "# 第01章 葬礼后的信\n\n林墨站在雨里。亡友的信没有邮戳。他决定回到解剖室。",
                encoding="utf-8",
            )

            delta = build_extraction_delta(project, 1, chapter)

            self.assertIn("char_protagonist", delta["entities_appeared"])
            self.assertEqual(delta["chapter_summary"]["title"], "葬礼后的信")
            self.assertGreater(delta["chapter_summary"]["word_count"], 0)

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
            self.assertEqual(cli.returncode, 0, cli.stderr)
            payload = json.loads(cli.stdout)
            self.assertEqual(payload["timeline_entry"]["chapter"], 1)
            self.assertIn("char_protagonist", payload["entities_appeared"])

    def test_extraction_delta_scans_past_non_heading_first_line(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_planned_project(Path(temp))
            chapter = Path(temp) / "chapter.md"
            chapter.write_text(
                "雨声先落在铁门上。\n# 第01章 葬礼后的信\n\n林墨站在雨里。亡友的信没有邮戳。",
                encoding="utf-8",
            )

            delta = build_extraction_delta(project, 1, chapter)

            self.assertEqual(delta["title"], "葬礼后的信")
            self.assertEqual(delta["chapter_summary"]["title"], "葬礼后的信")


if __name__ == "__main__":
    unittest.main()
