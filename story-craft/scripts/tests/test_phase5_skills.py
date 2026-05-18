from __future__ import annotations

import re
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = PLUGIN_ROOT / "skills"


EXPECTED_SKILLS = {
    "story-init": ["充分性闸门", "init", "deconstruction-agent", "完成条件"],
    "story-plan": ["充分性闸门", "大纲/总纲.md", "memory.json", "完成条件"],
    "story-write": ["充分性闸门", "context-agent", "reviewer", "data-agent", "ChapterCommitService.commit"],
    "story-review": ["充分性闸门", "reviewer", "审查报告", "完成条件"],
    "story-learn": ["充分性闸门", "pattern_type", "project_learning.json", "learn"],
    "story-query": ["只读", "query context", "query memory", "query learning", "query genres"],
}


def parse_frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


class Phase5SkillTests(unittest.TestCase):
    def test_all_phase5_skills_have_required_structure(self) -> None:
        for skill_name, phrases in EXPECTED_SKILLS.items():
            with self.subTest(skill_name=skill_name):
                skill_file = SKILLS_DIR / skill_name / "SKILL.md"
                self.assertTrue(skill_file.is_file(), f"missing {skill_file}")
                text = skill_file.read_text(encoding="utf-8")
                frontmatter = parse_frontmatter(text)

                self.assertEqual(frontmatter.get("name"), skill_name)
                self.assertTrue(frontmatter.get("description"))
                self.assertIn("目标", text)
                self.assertIn("流程", text)
                self.assertIn("失败处理", text)

                for phrase in phrases:
                    self.assertIn(phrase, text)

                self.assertNotIn("README.md", text)
                self.assertNotIn("webnovel.py", text)

    def test_skill_cli_references_use_current_entrypoint(self) -> None:
        for skill_file in SKILLS_DIR.glob("story-*/SKILL.md"):
            text = skill_file.read_text(encoding="utf-8")
            if "python -X utf8" in text:
                self.assertIn("story_craft.py", text)

    def test_story_query_is_read_only(self) -> None:
        text = (SKILLS_DIR / "story-query" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("不写 state", text)
        self.assertIn("不调用 Agent", text)


if __name__ == "__main__":
    unittest.main()
