from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "story_craft.py"


def long_chapter(title: str, sentence: str, repeat: int = 100) -> str:
    return f"# {title}\n\n" + sentence * repeat


def run_cli(*args: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


class Phase14RealProjectSmokeTests(unittest.TestCase):
    def test_two_chapter_smoke_keeps_context_clean(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "demo"

            init = run_cli(
                "init",
                str(project),
                "暗室来信",
                "悬疑",
                "--word-count-target",
                "30000",
                "--synopsis",
                "法医收到亡友留下的空白来信，追查旧楼暗室真相。",
                "--protagonist-name",
                "林墨",
                "--protagonist-desire",
                "查清亡友死因",
                "--unique-advantage-desc",
                "法医病理学和现场痕迹阅读",
                "--world-setting",
                "近现代城市，线索必须能由物证、证词或行动记录回溯。",
            )
            self.assertEqual(init.returncode, 0, init.stderr)

            plan = run_cli("--project-root", str(project), "plan", "--chapter-count", "8")
            self.assertEqual(plan.returncode, 0, plan.stderr)

            brief1 = root / "brief-ch1.json"
            first_brief = run_cli(
                "--project-root",
                str(project),
                "agent",
                "brief",
                "--chapter",
                "1",
                "--output-file",
                str(brief1),
            )
            self.assertEqual(first_brief.returncode, 0, first_brief.stderr)
            self.assertTrue(read_json(brief1)["ok"])

            brief2_before = root / "brief-ch2-before.json"
            blocked_brief = run_cli(
                "--project-root",
                str(project),
                "agent",
                "brief",
                "--chapter",
                "2",
                "--output-file",
                str(brief2_before),
            )
            self.assertEqual(blocked_brief.returncode, 1, blocked_brief.stderr)
            self.assertIn("缺少上一章提交记录", " ".join(read_json(brief2_before)["prewrite"]["blockers"]))

            draft1 = root / "chapter-01.md"
            draft1.write_text(
                long_chapter(
                    "第01章 信封上的刮痕",
                    "林墨在解剖室收到亡友秦澈留下的信封，邮戳、封蜡刮痕、门卫证词和监控黑屏共同指向旧楼。",
                ),
                encoding="utf-8",
            )
            review1 = root / "review-ch1.json"
            write_json(review1, {"passed": True, "issues": [], "summary": "第1章可提交。"})
            delta1 = root / "delta-ch1.json"
            extract1 = run_cli(
                "--project-root",
                str(project),
                "agent",
                "extract",
                "--chapter",
                "1",
                "--chapter-file",
                str(draft1),
                "--output-file",
                str(delta1),
            )
            self.assertEqual(extract1.returncode, 0, extract1.stderr)
            write1 = run_cli(
                "--project-root",
                str(project),
                "write",
                "1",
                "--draft-file",
                str(draft1),
                "--review-results",
                str(review1),
                "--delta-file",
                str(delta1),
            )
            self.assertEqual(write1.returncode, 0, write1.stderr)

            brief2 = root / "brief-ch2.json"
            second_brief = run_cli(
                "--project-root",
                str(project),
                "agent",
                "brief",
                "--chapter",
                "2",
                "--output-file",
                str(brief2),
            )
            self.assertEqual(second_brief.returncode, 0, second_brief.stderr)
            self.assertTrue(read_json(brief2)["ok"])

            context2 = json.loads(
                run_cli("--project-root", str(project), "query", "context", "--chapter", "2").stdout
            )
            recent_chapters = {item["chapter"] for item in context2["scene"]["recent_timeline"]}
            self.assertEqual(recent_chapters, {1})
            self.assertTrue(all(not item.get("planned") for item in context2["scene"]["recent_timeline"]))

            draft2 = root / "chapter-02.md"
            draft2.write_text(
                long_chapter(
                    "第02章 旧楼门禁",
                    "林墨在旧楼外复查门禁、照片、排水沟封条和许照证词，确认有人改写过现场并隐藏地下室入口。",
                ),
                encoding="utf-8",
            )
            review2 = root / "review-ch2.json"
            write_json(review2, {"passed": True, "issues": [], "summary": "第2章可提交。"})
            delta2 = root / "delta-ch2.json"
            extract2 = run_cli(
                "--project-root",
                str(project),
                "agent",
                "extract",
                "--chapter",
                "2",
                "--chapter-file",
                str(draft2),
                "--output-file",
                str(delta2),
            )
            self.assertEqual(extract2.returncode, 0, extract2.stderr)
            write2 = run_cli(
                "--project-root",
                str(project),
                "write",
                "2",
                "--draft-file",
                str(draft2),
                "--review-results",
                str(review2),
                "--delta-file",
                str(delta2),
            )
            self.assertEqual(write2.returncode, 0, write2.stderr)

            status = json.loads(run_cli("--project-root", str(project), "query", "status").stdout)
            memory = json.loads(run_cli("--project-root", str(project), "query", "memory").stdout)
            entity_graph = json.loads(run_cli("--project-root", str(project), "query", "entity-graph").stdout)
            ranked = json.loads(
                run_cli("--project-root", str(project), "query", "ranked-context", "--chapter", "3").stdout
            )

            planned = [item for item in memory["timeline"] if item.get("planned")]
            actual = [item for item in memory["timeline"] if not item.get("planned")]
            self.assertEqual(status["progress"]["current_chapter"], 2)
            self.assertEqual(memory["last_updated_chapter"], 2)
            self.assertEqual(len(planned), 8)
            self.assertEqual(len(actual), 2)
            self.assertEqual(status["memory_counts"]["open_foreshadowing"], 0)
            self.assertTrue(any(node["name"] == "林墨" for node in entity_graph["nodes"]))
            self.assertTrue(
                all(not item["payload"].get("planned") for item in ranked["selected"])
            )
            ranked_timeline_chapters = {
                item["chapter"] for item in ranked["selected"] if item["kind"] == "timeline"
            }
            self.assertEqual(ranked_timeline_chapters, {1, 2})


if __name__ == "__main__":
    unittest.main()
