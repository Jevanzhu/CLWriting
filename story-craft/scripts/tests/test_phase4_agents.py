from __future__ import annotations

import re
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = PLUGIN_ROOT / "agents"


EXPECTED_AGENTS = {
    "context-agent.md": {
        "name": "context-agent",
        "tools": "Read, Grep, Bash",
        "required_phrases": [
            "输入 JSON Schema",
            "输出 JSON Schema",
            "执行步骤",
            "边界规则",
            "错误处理",
            "自检清单",
            "query context",
        ],
    },
    "reviewer.md": {
        "name": "reviewer",
        "tools": "Read, Grep, Bash",
        "required_phrases": [
            "输入 JSON Schema",
            "输出 JSON Schema",
            "执行步骤",
            "AI味检查细则",
            "边界规则",
            "错误处理",
            "自检清单",
        ],
    },
    "data-agent.md": {
        "name": "data-agent",
        "tools": "Read, Bash",
        "required_phrases": [
            "输入 JSON Schema",
            "输出 JSON Schema",
            "执行步骤",
            "字段约束",
            "边界规则",
            "错误处理",
            "自检清单",
        ],
    },
    "deconstruction-agent.md": {
        "name": "deconstruction-agent",
        "tools": "Read, Grep, Bash",
        "required_phrases": [
            "输入 JSON Schema",
            "输出 JSON Schema",
            "路由规则",
            "执行步骤",
            "禁止复制",
            "错误处理",
            "自检清单",
        ],
    },
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


class Phase4AgentTests(unittest.TestCase):
    def test_all_phase4_agents_exist_with_required_structure(self) -> None:
        for filename, expected in EXPECTED_AGENTS.items():
            with self.subTest(filename=filename):
                path = AGENTS_DIR / filename
                self.assertTrue(path.is_file(), f"missing {filename}")
                text = path.read_text(encoding="utf-8")
                frontmatter = parse_frontmatter(text)

                self.assertEqual(frontmatter.get("name"), expected["name"])
                self.assertEqual(frontmatter.get("tools"), expected["tools"])
                self.assertEqual(frontmatter.get("model"), "inherit")
                self.assertTrue(frontmatter.get("description"))

                for phrase in expected["required_phrases"]:
                    self.assertIn(phrase, text)

                self.assertIn("```json", text)
                self.assertNotIn("webnovel.py", text)
                self.assertNotIn("index.db", text)

    def test_agents_reference_current_story_craft_entrypoint(self) -> None:
        for filename in ("context-agent.md", "reviewer.md", "data-agent.md"):
            text = (AGENTS_DIR / filename).read_text(encoding="utf-8")
            self.assertIn("story_craft.py", text)
            self.assertIn("--project-root", text)

    def test_deconstruction_agent_blocks_memory_only_analysis(self) -> None:
        text = (AGENTS_DIR / "deconstruction-agent.md").read_text(encoding="utf-8")
        self.assertIn("不得凭书名或作者记忆生成候选", text)
        self.assertIn("canon_contamination_warnings", text)


if __name__ == "__main__":
    unittest.main()
