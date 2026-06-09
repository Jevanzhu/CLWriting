from __future__ import annotations

import json
import re
from pathlib import Path

from tools.scenario_router import (
    SCENARIO_DAILY_CONTINUE,
    SCENARIO_IMPORT_EXTERNAL,
    SCENARIO_MAJOR_REVISION,
    SCENARIO_NEW_VOLUME,
    SCENARIO_OPEN_BOOK,
)


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = PLUGIN_ROOT / "agents"


EXPECTED_STAGE3_AGENTS = {
    "story-architect.md": {
        "name": "story-architect",
        "tools": "Read, Grep, Bash",
        "model": "opus",
        "required_phrases": ["master.json", "volumes/", "chapters/", "ChapterContract"],
    },
    "character-designer.md": {
        "name": "character-designer",
        "tools": "Read, Grep, Bash",
        "model": "sonnet",
        "required_phrases": ["character_registry", "设定/角色", "relationships"],
    },
    "context-agent.md": {
        "name": "context-agent",
        "tools": "Read, Grep, Bash",
        "model": "inherit",
        "required_phrases": ["五段任务书", "query context", "anti_patterns", "project_type"],
    },
    "narrative-writer.md": {
        "name": "narrative-writer",
        "tools": "Read, Grep, Bash",
        "model": "sonnet",
        "required_phrases": ["draft.md", "字数硬约束", "去 AI", "不得写入 commit"],
    },
    "reviewer.md": {
        "name": "reviewer",
        "tools": "Read, Grep, Bash",
        "model": "inherit",
        "required_phrases": [
            "三档 mode",
            "6-Gate",
            "S1-S4",
            "ReviewMeta",
            "tools.deslop_metrics.analyze_deslop_metrics",
            "tools.strand_calculator.evaluate_strand_balance",
            "references/shared/review/fallback-rubric.md",
            "CC 验证清单",
        ],
    },
    "consistency-checker.md": {
        "name": "consistency-checker",
        "tools": "Read, Grep, Bash",
        "model": "haiku",
        "required_phrases": ["grep-first", "findings", "只报告可证实问题"],
    },
    "data-agent.md": {
        "name": "data-agent",
        "tools": "Read, Bash",
        "model": "inherit",
        "required_phrases": ["accepted_events", "dominant_strand", "embedding_text", "style_fingerprint.yaml"],
    },
    "story-explorer.md": {
        "name": "story-explorer",
        "tools": "Read, Grep, Bash",
        "model": "haiku",
        "required_phrases": ["只读查询", "query", "不得修改项目文件"],
    },
    "story-researcher.md": {
        "name": "story-researcher",
        "tools": "Read, Grep, Bash",
        "model": "sonnet",
        "required_phrases": ["参考资料", "来源记录", "不得污染 canon"],
    },
}


STANDARD_AGENT_SECTIONS = [
    "输入 JSON Schema",
    "输出 JSON Schema",
    "执行步骤",
    "边界规则",
    "错误处理",
    "自检清单",
]


def parse_frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


def test_stage3_agents_exist_with_required_structure():
    for filename, expected in EXPECTED_STAGE3_AGENTS.items():
        path = AGENTS_DIR / filename
        assert path.is_file(), f"missing {filename}"
        text = path.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text)

        assert frontmatter.get("name") == expected["name"]
        assert frontmatter.get("tools") == expected["tools"]
        assert frontmatter.get("model") == expected["model"]
        assert frontmatter.get("description")

        for section in STANDARD_AGENT_SECTIONS:
            assert section in text
        for phrase in expected["required_phrases"]:
            assert phrase in text

        assert "```json" in text
        assert "webnovel.py" not in text
        assert "index.db" not in text


def test_stage3_agent_set_is_nine_targets_plus_optional_legacy():
    expected_files = set(EXPECTED_STAGE3_AGENTS)
    actual_files = {path.name for path in AGENTS_DIR.glob("*.md")}
    assert expected_files == actual_files
    assert len(expected_files) == 9


def test_core_agents_reference_current_story_craft_entrypoint():
    for filename in ("context-agent.md", "reviewer.md", "data-agent.md"):
        text = (AGENTS_DIR / filename).read_text(encoding="utf-8")
        assert "story_craft.py" in text
        assert "--project-root" in text


def test_context_agent_scenario_enum_matches_router_constants():
    text = (AGENTS_DIR / "context-agent.md").read_text(encoding="utf-8")
    match = re.search(r'"scenario": \{ "enum": (\[[^\]]+\]) \}', text)

    assert match
    assert set(json.loads(match.group(1))) == {
        SCENARIO_DAILY_CONTINUE,
        SCENARIO_IMPORT_EXTERNAL,
        SCENARIO_MAJOR_REVISION,
        SCENARIO_NEW_VOLUME,
        SCENARIO_OPEN_BOOK,
    }
    for legacy in ("`revision`", "`new_book`", "`import`"):
        assert legacy not in text


def test_data_agent_uses_stage3_event_contract_and_style_fingerprint():
    text = (AGENTS_DIR / "data-agent.md").read_text(encoding="utf-8")
    for phrase in (
        "accepted_events",
        "dominant_strand",
        "scenes",
        "embedding_text",
        "ContractStore.write_style_fingerprint",
        "contracts/style_fingerprint.yaml",
    ):
        assert phrase in text
    assert "不直接写 `.story/state.json`" in text


def test_deconstruction_agent_is_removed_with_migration_notes():
    assert not (AGENTS_DIR / "deconstruction-agent.md").exists()
    data_agent = (AGENTS_DIR / "data-agent.md").read_text(encoding="utf-8")
    loading_map = (
        PLUGIN_ROOT / "references" / "index" / "reference-loading-map.md"
    ).read_text(encoding="utf-8")
    assert "style_fingerprint" in data_agent
    assert "旧 `deconstruction-agent` 已在阶段 3 淘汰" in loading_map
    assert "参考拆解迁入 `story-import`" in loading_map
