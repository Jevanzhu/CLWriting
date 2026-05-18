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

from core.chapter_commit import ChapterCommitService
from core.context_manager import ContextManager
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from tools.genre_profile_builder import build_genre_hints
from tools.placeholder_scanner import scan_placeholders
from tools.prewrite_validator import validate_prewrite
from tools.project_memory import append_learning_pattern, get_learning_patterns
from tools.review_pipeline import build_review_report
from tools.style_sampler import detect_style_drift, extract_style_sample
from tools.writing_guidance_builder import build_anti_ai_checklist, build_writing_checklist
from tools.init_project import init_project


class Phase3ContextToolTests(unittest.TestCase):
    def test_context_manager_builds_four_sections(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
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
            ChapterCommitService(StoryCraftConfig.from_project_root(project)).commit(
                1,
                "葬礼后的信",
                1800,
                {"passed": True, "warnings": [{"category": "pacing", "description": "节奏略慢"}]},
                {"chapter_summary": {"chapter": 1, "title": "葬礼后的信", "summary": "林墨收到亡友来信"}},
            )

            context = ContextManager.from_project(project).build_context(2)

            self.assertEqual(set(["core", "scene", "continuity", "guidance"]).issubset(context), True)
            self.assertIn("必须发现尸检报告异常", context["core"]["chapter_outline"])
            self.assertEqual(context["scene"]["recent_summaries"][0]["chapter"], 1)
            self.assertEqual(context["continuity"]["unresolved_foreshadowing"][0]["id"], "fh_001")
            self.assertEqual(context["guidance"]["genre_profile"]["genre"], "悬疑灵异")
            self.assertEqual(context["guidance"]["learning_patterns"][0]["pattern_type"], "pacing")
            self.assertTrue(context["guidance"]["anti_ai_checklist"])

    def test_phase3_tools_return_expected_shapes(self) -> None:
        placeholders = scan_placeholders("这里有[TODO:补线索]，还有{待定结尾}。")
        self.assertEqual(len(placeholders), 2)
        self.assertIn("第1行", placeholders[0]["location"])

        hints = build_genre_hints("悬疑")
        self.assertEqual(hints["genre"], "悬疑灵异")
        self.assertIn("pacing", hints)
        for genre in ("都市日常", "历史脑洞", "电竞", "黑暗题材"):
            with self.subTest(genre=genre):
                layered = build_genre_hints(genre)
                self.assertEqual(layered["genre"], genre)
                self.assertNotEqual(layered["pacing"], "保持场景目标清晰，每章至少完成一次信息推进或关系变化。")
                self.assertGreaterEqual(len(layered["pitfalls"]), 2)

        sample = extract_style_sample("“你来了。”他转身。冷光落在门上。", 1)
        baseline = dict(sample)
        baseline["avg_sentence_length"] = sample["avg_sentence_length"] + 20
        self.assertTrue(detect_style_drift(sample, baseline))

        checklist = build_writing_checklist(
            3,
            [{"review": {"warnings": [{"category": "dialogue", "description": "对白解释过多"}]}}],
            [{"id": "pat_001", "pattern_type": "hook", "instruction": "开篇先给异常"}],
        )
        self.assertGreaterEqual(len(checklist), 4)
        self.assertTrue(build_anti_ai_checklist())

        report = build_review_report(
            2,
            {
                "passed": False,
                "blockers": [{"category": "continuity", "description": "规则冲突"}],
                "warnings": [],
            },
            "正文内容",
        )
        self.assertIn("未通过", report)
        self.assertIn("规则冲突", report)

    def test_project_memory_and_prewrite_validator(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑")
            pattern = append_learning_pattern(
                project,
                "dialogue",
                "对白解释",
                "某段对白",
                "对白必须带冲突",
                1,
            )
            self.assertEqual(pattern["id"], "pat_001")
            self.assertEqual(get_learning_patterns(project, "dialogue")[0]["instruction"], "对白必须带冲突")

            validation = validate_prewrite(project, 1)
            self.assertTrue(validation["ready"])
            self.assertTrue(any("总纲未显式覆盖" in item for item in validation["warnings"]))

            validation = validate_prewrite(project, 2)
            self.assertFalse(validation["ready"])
            self.assertTrue(any("缺少上一章提交记录" in item for item in validation["blockers"]))

    def test_cli_query_learn_review_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "暗室", "悬疑")
            script = SCRIPTS_DIR / "story_craft.py"

            learn = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    str(script),
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
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(learn.returncode, 0, learn.stderr)
            self.assertEqual(json.loads(learn.stdout)["pattern_type"], "hook")

            query = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    str(script),
                    "--project-root",
                    str(project),
                    "query",
                    "context",
                    "--chapter",
                    "1",
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(query.returncode, 0, query.stderr)
            self.assertIn("core", json.loads(query.stdout))

            review_json = Path(temp) / "review.json"
            chapter_file = Path(temp) / "chapter.md"
            report_file = Path(temp) / "report.md"
            review_json.write_text(json.dumps({"passed": True, "warnings": []}), encoding="utf-8")
            chapter_file.write_text("正文内容", encoding="utf-8")
            review = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    str(script),
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
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(review.returncode, 0, review.stderr)
            self.assertTrue(report_file.is_file())


if __name__ == "__main__":
    unittest.main()
