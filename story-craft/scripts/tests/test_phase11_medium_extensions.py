from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from core.chapter_commit import ChapterCommitService
from core.config import StoryCraftConfig
from core.memory_index import MemoryIndexService
from core.memory_manager import MemoryManager
from tools.backup_manager import BackupManager
from tools.context_ranker import rank_context_items
from tools.entity_linker import build_entity_graph
from tools.init_project import init_project
from tools.outline_reviser import OutlineReviser
from tools.quality_trend_report import QualityTrendReporter
from tools.status_reporter import StatusReporter
from tools.story_runtime_health import StoryRuntimeHealth


SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def seed_medium_project(project: Path) -> StoryCraftConfig:
    init_project(
        project,
        "长夜档案",
        "悬疑",
        word_count_target=90000,
        protagonist_name="林墨",
    )
    config = StoryCraftConfig.from_project_root(project)
    memory = MemoryManager(config)
    memory.apply_chapter_delta(
        {
            "chapter": 1,
            "entities_new": [
                {
                    "id": "char_su",
                    "name": "苏晚",
                    "role": "ally",
                    "tier": "核心",
                    "relationships": [
                        {
                            "target_id": "char_protagonist",
                            "type": "互相试探",
                            "description": "共享线索但互不完全信任",
                        }
                    ],
                }
            ],
            "entities_appeared": ["char_protagonist", "char_su"],
            "new_foreshadowing": [
                {
                    "id": "fh_001",
                    "content": "天台纸条写着周三",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                },
                {
                    "id": "fh_002",
                    "content": "尸检报告缺失一页",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                },
                {
                    "id": "fh_003",
                    "content": "苏晚隐瞒电话来源",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 2,
                },
            ],
            "new_world_rules": [{"id": "wr_001", "rule": "证据必须可回溯"}],
            "timeline_entry": {
                "chapter": 1,
                "time_marker": "周三傍晚",
                "location": "天台",
                "events": ["发现纸条"],
            },
            "chapter_summary": {
                "chapter": 1,
                "title": "天台纸条",
                "summary": "林墨发现第一条反常证据",
                "word_count": 2600,
            },
        }
    )
    memory.flush()
    service = ChapterCommitService(config)
    service.commit(
        1,
        "天台纸条",
        2600,
        {"passed": True, "warnings": [{"category": "pacing", "description": "开头稍慢"}]},
        {"chapter_summary": {"chapter": 1, "title": "天台纸条", "summary": "林墨发现纸条"}},
    )
    service.commit(
        2,
        "缺页报告",
        2400,
        {"passed": True, "warnings": [{"category": "continuity", "description": "报告来源需明确"}]},
        {
            "entities_appeared": ["char_protagonist", "char_su"],
            "chapter_summary": {"chapter": 2, "title": "缺页报告", "summary": "尸检报告缺页"},
            "timeline_entry": {"chapter": 2, "time_marker": "周四", "events": ["追查报告"]},
        },
    )
    return config


class Phase11MediumExtensionTests(unittest.TestCase):
    def test_memory_index_backup_status_and_health_services(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "medium"
            config = seed_medium_project(project)

            index = MemoryIndexService(config).rebuild()
            self.assertTrue(Path(index["db_file"]).is_file())
            self.assertGreaterEqual(index["entry_count"], 7)
            self.assertTrue(MemoryManager(config).use_sqlite)

            matches = MemoryIndexService(config).query(text="纸条", limit=5)
            self.assertTrue(any(item["kind"] == "foreshadowing" for item in matches))

            backup = BackupManager(config).create_backup("阶段备份")
            backup_file = Path(str(backup["backup_file"]))
            self.assertTrue(backup_file.is_file())
            with zipfile.ZipFile(backup_file) as archive:
                self.assertIn(".story/state.json", archive.namelist())

            status = StatusReporter(config).build()
            self.assertTrue(status["medium_mode"]["enabled"])
            self.assertGreater(status["progress"]["total_words"], 0)
            self.assertGreaterEqual(status["memory_counts"]["open_foreshadowing"], 3)

            health = StoryRuntimeHealth(config).check()
            self.assertTrue(health["ok"])
            self.assertTrue(any("伏笔债" in item for item in health["warnings"]))
            self.assertIn("runtime", health)
            self.assertIn("filelock_available", health["runtime"])

    def test_quality_ranker_entity_graph_and_outline_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "medium"
            config = seed_medium_project(project)
            memory = MemoryManager(config).load()

            quality = QualityTrendReporter(config).build()
            self.assertEqual(quality["chapter_count"], 2)
            self.assertEqual(quality["warning_categories"]["pacing"], 1)
            self.assertEqual(quality["warning_categories"]["continuity"], 1)

            ranked = rank_context_items(memory, chapter=3, budget=3)
            self.assertEqual(len(ranked["selected"]), 3)
            self.assertEqual(ranked["selected"][0]["kind"], "foreshadowing")
            self.assertGreater(ranked["omitted_count"], 0)

            graph = build_entity_graph(memory)
            self.assertGreaterEqual(graph["node_count"], 2)
            self.assertEqual(graph["orphan_edges"], [])

            revision = OutlineReviser(config).suggest(2, "中点前核对主线")
            revision_file = Path(str(revision["revision_file"]))
            self.assertTrue(revision_file.is_file())
            self.assertIn("中点前核对主线", revision_file.read_text(encoding="utf-8"))

    def test_phase11_cli_commands(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "medium"
            seed_medium_project(project)

            index = run_cli("--project-root", str(project), "maintain", "index")
            self.assertEqual(index.returncode, 0, index.stderr)
            self.assertGreater(json.loads(index.stdout)["entry_count"], 0)

            status = run_cli("--project-root", str(project), "query", "status")
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertTrue(json.loads(status.stdout)["medium_mode"]["enabled"])

            ranked = run_cli(
                "--project-root",
                str(project),
                "query",
                "ranked-context",
                "--chapter",
                "3",
                "--budget",
                "2",
            )
            self.assertEqual(ranked.returncode, 0, ranked.stderr)
            self.assertEqual(len(json.loads(ranked.stdout)["selected"]), 2)

            backup = run_cli(
                "--project-root",
                str(project),
                "maintain",
                "backup",
                "--label",
                "cli",
            )
            self.assertEqual(backup.returncode, 0, backup.stderr)
            self.assertTrue(Path(json.loads(backup.stdout)["backup_file"]).is_file())

            health = run_cli("--project-root", str(project), "maintain", "health")
            self.assertEqual(health.returncode, 0, health.stderr)
            health_payload = json.loads(health.stdout)
            self.assertTrue(health_payload["ok"])
            self.assertIn("runtime", health_payload)

            revision = run_cli(
                "--project-root",
                str(project),
                "maintain",
                "outline-revision",
                "--chapter",
                "2",
                "--note",
                "CLI 核对",
            )
            self.assertEqual(revision.returncode, 0, revision.stderr)
            self.assertTrue(Path(json.loads(revision.stdout)["revision_file"]).is_file())


if __name__ == "__main__":
    unittest.main()
