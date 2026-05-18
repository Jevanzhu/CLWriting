from __future__ import annotations

import csv
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REFERENCES_DIR = PLUGIN_ROOT / "references"


EXPECTED_REFERENCE_FILES = {
    "README.md",
    "genre-profiles.md",
    "review-schema.md",
    "reading-power-taxonomy.md",
    "shared/core-constraints.md",
    "shared/naming-and-voice-gaps.md",
    "shared/payoff-points-guide.md",
    "shared/strand-weave-pattern.md",
    "csv/README.md",
    "csv/genre-canonical.md",
    "csv/人设与关系.csv",
    "csv/写作技法.csv",
    "csv/命名规则.csv",
    "csv/场景写法.csv",
    "csv/桥段套路.csv",
    "csv/爽点与节奏.csv",
    "csv/裁决规则.csv",
    "csv/金手指与设定.csv",
    "csv/题材与调性推理.csv",
    "outlining/plot-signal-vs-spoiler.md",
    "review/blocking-override-guidelines.md",
    "index/reference-loading-map.md",
    "index/reference-gap-register.md",
}

CSV_FILES = [path for path in EXPECTED_REFERENCE_FILES if path.startswith("csv/") and path.endswith(".csv")]

REQUIRED_MARKDOWN_PHRASES = {
    "genre-profiles.md": ["1-10 万字", "37 个题材标签", "结尾"],
    "review-schema.md": ["blocking", "anti_ai_force_check", "severity"],
    "shared/core-constraints.md": ["1-10 万字", "伏笔", "结尾"],
    "shared/naming-and-voice-gaps.md": ["命名", "语调", "称呼"],
    "outlining/plot-signal-vs-spoiler.md": ["情节信号", "剧透", "回收"],
    "review/blocking-override-guidelines.md": ["不可覆盖", "可考虑覆盖", "用户确认"],
    "index/reference-loading-map.md": ["/story-init", "/story-plan", "/story-write", "/story-review"],
}


class Phase7ReferenceTests(unittest.TestCase):
    def test_all_phase7_reference_files_exist(self) -> None:
        self.assertTrue(REFERENCES_DIR.is_dir(), "missing references dir")
        actual = {
            str(path.relative_to(REFERENCES_DIR))
            for path in REFERENCES_DIR.rglob("*")
            if path.is_file()
        }
        self.assertEqual(EXPECTED_REFERENCE_FILES, actual)

    def test_markdown_references_have_required_content(self) -> None:
        for relative_path, phrases in REQUIRED_MARKDOWN_PHRASES.items():
            with self.subTest(relative_path=relative_path):
                text = (REFERENCES_DIR / relative_path).read_text(encoding="utf-8")
                self.assertGreater(len(text.strip()), 200)
                self.assertTrue(text.lstrip().startswith("# "))
                for phrase in phrases:
                    self.assertIn(phrase, text)

    def test_csv_references_are_parseable_context_tables(self) -> None:
        for relative_path in CSV_FILES:
            with self.subTest(relative_path=relative_path):
                rows = list(
                    csv.reader(
                        (REFERENCES_DIR / relative_path).read_text(encoding="utf-8").splitlines()
                    )
                )
                self.assertGreaterEqual(len(rows), 4)
                self.assertGreaterEqual(len(rows[0]), 3)
                width = len(rows[0])
                for row in rows[1:]:
                    self.assertEqual(width, len(row))

    def test_reference_loading_map_covers_agents_and_skills(self) -> None:
        text = (REFERENCES_DIR / "index" / "reference-loading-map.md").read_text(
            encoding="utf-8"
        )
        for name in (
            "/story-init",
            "/story-plan",
            "/story-write",
            "/story-review",
            "/story-learn",
            "/story-query",
            "context-agent",
            "reviewer",
            "data-agent",
            "deconstruction-agent",
        ):
            self.assertIn(name, text)

    def test_review_schema_and_override_guidelines_share_blocking_policy(self) -> None:
        schema = (REFERENCES_DIR / "review-schema.md").read_text(encoding="utf-8")
        override = (
            REFERENCES_DIR / "review" / "blocking-override-guidelines.md"
        ).read_text(encoding="utf-8")

        self.assertIn("blocking=true", schema)
        self.assertIn("不可覆盖", override)
        self.assertIn("安全", schema)
        self.assertIn("安全", override)


if __name__ == "__main__":
    unittest.main()
