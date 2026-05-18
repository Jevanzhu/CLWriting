from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from core.memory_index import MemoryIndexService
from core.memory_manager import MemoryManager
from tools.init_project import init_project


def seed_index_memory(project: Path) -> MemoryIndexService:
    init_project(project, "长夜档案", "悬疑", protagonist_name="林墨")
    memory = MemoryManager.from_project(project)
    payload = memory.load()
    payload.update(
        {
            "characters": [
                {
                    "id": "char_lin",
                    "name": "林墨",
                    "role": "protagonist",
                    "current_status": "追查天台纸条",
                    "last_appearance_chapter": 2,
                    "relationships": [
                        {
                            "target_id": "char_su",
                            "type": "互相试探",
                            "description": "共享纸条线索",
                        }
                    ],
                },
                {
                    "id": "char_su",
                    "name": "苏晚",
                    "role": "ally",
                    "current_status": "隐瞒电话来源",
                    "last_appearance_chapter": 1,
                },
            ],
            "foreshadowing": [
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
                    "urgency": "medium",
                    "planted_chapter": 2,
                },
            ],
            "timeline": [
                {
                    "chapter": 1,
                    "time_marker": "周三傍晚",
                    "location": "天台",
                    "events": ["发现纸条"],
                },
                {
                    "chapter": 2,
                    "time_marker": "周四清晨",
                    "location": "档案室",
                    "events": ["追查缺页报告"],
                },
            ],
            "world_rules": [
                {
                    "id": "wr_001",
                    "rule": "证据必须可回溯",
                    "chapter": 1,
                }
            ],
            "chapter_summaries": [
                {
                    "chapter": 1,
                    "title": "天台纸条",
                    "summary": "林墨发现第一条反常证据",
                },
                {
                    "chapter": 2,
                    "title": "缺页报告",
                    "summary": "尸检报告缺失一页",
                },
            ],
        }
    )
    memory.save(payload)
    return MemoryIndexService.from_project(project)


class MemoryIndexTests(unittest.TestCase):
    def test_rebuild_and_stats_report_kind_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            service = seed_index_memory(Path(temp) / "demo")

            result = service.rebuild()
            stats = service.stats()

            self.assertTrue(Path(result["db_file"]).is_file())
            self.assertEqual(result["entry_count"], 10)
            self.assertEqual(stats["entry_count"], 10)
            self.assertTrue(stats["exists"])
            self.assertTrue(stats["rebuilt_at"])
            self.assertEqual(result["by_kind"], stats["by_kind"])
            self.assertEqual(stats["by_kind"]["character"], 2)
            self.assertEqual(stats["by_kind"]["foreshadowing"], 2)
            self.assertEqual(stats["by_kind"]["relationship"], 1)

    def test_query_filters_by_kind_text_and_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            service = seed_index_memory(Path(temp) / "demo")
            service.rebuild()

            foreshadowing = service.query(kind="foreshadowing", text="纸条")
            self.assertEqual(len(foreshadowing), 1)
            self.assertEqual(foreshadowing[0]["entity_id"], "fh_001")
            self.assertEqual(foreshadowing[0]["payload"]["urgency"], "high")

            characters = service.query(kind="character", text="林墨")
            self.assertEqual(len(characters), 1)
            self.assertEqual(characters[0]["title"], "林墨")

            limited = service.query(text="", limit=2)
            self.assertEqual(len(limited), 2)
            self.assertGreaterEqual(limited[0]["chapter"], limited[1]["chapter"])

    def test_query_rebuilds_missing_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            service = seed_index_memory(project)
            self.assertFalse(service.config.memory_db.exists())

            matches = service.query(text="缺页")

            self.assertTrue(service.config.memory_db.exists())
            self.assertTrue(any(item["kind"] == "chapter_summary" for item in matches))


if __name__ == "__main__":
    unittest.main()
