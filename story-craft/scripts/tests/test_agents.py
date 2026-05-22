from __future__ import annotations

import re
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


def test_all_agents_exist_with_required_structure():
    for filename, expected in EXPECTED_AGENTS.items():
        path = AGENTS_DIR / filename
        assert path.is_file(), f"missing {filename}"
        text = path.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text)

        assert frontmatter.get("name") == expected["name"]
        assert frontmatter.get("tools") == expected["tools"]
        assert frontmatter.get("model") == "inherit"
        assert frontmatter.get("description")

        for phrase in expected["required_phrases"]:
            assert phrase in text

        assert "```json" in text
        assert "webnovel.py" not in text
        assert "index.db" not in text


def test_agents_reference_current_story_craft_entrypoint():
    for filename in ("context-agent.md", "reviewer.md", "data-agent.md"):
        text = (AGENTS_DIR / filename).read_text(encoding="utf-8")
        assert "story_craft.py" in text
        assert "--project-root" in text


def test_deconstruction_agent_blocks_memory_only_analysis():
    text = (AGENTS_DIR / "deconstruction-agent.md").read_text(encoding="utf-8")
    assert "不得凭书名或作者记忆生成候选" in text
    assert "canon_contamination_warnings" in text
