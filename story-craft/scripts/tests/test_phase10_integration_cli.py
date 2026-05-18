from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class Phase10IntegrationCliTests(unittest.TestCase):
    def test_cli_init_preflight_query_learn_and_review_chain(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "集成故事"

            init = run_cli(
                "init",
                str(project),
                "集成故事",
                "悬疑",
                "--word-count-target",
                "30000",
                "--synopsis",
                "法医收到亡友来信",
                "--protagonist-name",
                "林墨",
                "--protagonist-desire",
                "查清真相",
                "--protagonist-flaw",
                "过度依赖证据",
                "--unique-advantage-type",
                "特殊知识",
                "--unique-advantage-desc",
                "法医病理学",
                "--unique-advantage-style",
                "克制",
                "--unique-advantage-visibility",
                "少数同事知道",
                "--unique-advantage-cost",
                "容易忽视情绪证词",
                "--antagonist-mirror",
                "反派同样追求完整真相",
                "--world-setting",
                "近现代城市",
            )
            self.assertEqual(init.returncode, 0, init.stderr)
            init_payload = json.loads(init.stdout)
            self.assertTrue(Path(init_payload["state_file"]).is_file())

            preflight = run_cli("--project-root", str(project), "preflight", "--format", "json")
            self.assertEqual(preflight.returncode, 0, preflight.stderr)
            preflight_payload = json.loads(preflight.stdout)
            self.assertTrue(preflight_payload["ok"])
            self.assertTrue(preflight_payload["project_exists"])

            memory = run_cli("--project-root", str(project), "query", "memory")
            self.assertEqual(memory.returncode, 0, memory.stderr)
            memory_payload = json.loads(memory.stdout)
            self.assertEqual(memory_payload["characters"][0]["name"], "林墨")

            genres = run_cli("--project-root", str(project), "query", "genres")
            self.assertEqual(genres.returncode, 0, genres.stderr)
            self.assertIn("悬疑灵异", json.loads(genres.stdout)["genres"])

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
            self.assertEqual(learn.returncode, 0, learn.stderr)
            self.assertEqual(json.loads(learn.stdout)["id"], "pat_001")

            learning = run_cli(
                "--project-root",
                str(project),
                "query",
                "learning",
                "--pattern-type",
                "hook",
            )
            self.assertEqual(learning.returncode, 0, learning.stderr)
            self.assertEqual(json.loads(learning.stdout)["patterns"][0]["pattern_type"], "hook")

            review_results = Path(temp) / "review.json"
            chapter_file = Path(temp) / "chapter.md"
            report_file = project / "审查报告" / "第01章审查报告.md"
            review_results.write_text(
                json.dumps(
                    {
                        "passed": False,
                        "blockers": [
                            {
                                "severity": "critical",
                                "category": "continuity",
                                "description": "主角动机断裂",
                            }
                        ],
                        "warnings": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            chapter_file.write_text("林墨站在雨里。", encoding="utf-8")
            review = run_cli(
                "--project-root",
                str(project),
                "review",
                "--chapter",
                "1",
                "--review-results",
                str(review_results),
                "--chapter-file",
                str(chapter_file),
                "--report-file",
                str(report_file),
            )
            self.assertEqual(review.returncode, 0, review.stderr)
            self.assertIn("主角动机断裂", report_file.read_text(encoding="utf-8"))

    def test_cli_write_requires_chapter_argument(self) -> None:
        write = run_cli("write")

        self.assertEqual(write.returncode, 2)
        self.assertIn("--chapter", write.stderr)


if __name__ == "__main__":
    unittest.main()
