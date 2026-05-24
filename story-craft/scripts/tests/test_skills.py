from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = PLUGIN_ROOT / "skills"


EXPECTED_SKILLS = {
    "story-init": ["充分性闸门", "init", "deconstruction-agent", "完成条件"],
    "story-plan": ["充分性闸门", "大纲/总纲.md", "memory.json", "完成条件"],
    "story-write": ["充分性闸门", "context-agent", "reviewer", "data-agent", "ChapterRecordService.record"],
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


def test_all_skills_have_required_structure():
    for skill_name, phrases in EXPECTED_SKILLS.items():
        skill_file = SKILLS_DIR / skill_name / "SKILL.md"
        assert skill_file.is_file(), f"missing {skill_file}"
        text = skill_file.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text)

        assert frontmatter.get("name") == skill_name
        assert frontmatter.get("description")
        assert "目标" in text
        assert "流程" in text
        assert "失败处理" in text

        for phrase in phrases:
            assert phrase in text

        assert "README.md" not in text
        assert "webnovel.py" not in text


def test_skill_cli_references_use_current_entrypoint():
    for skill_file in SKILLS_DIR.glob("story-*/SKILL.md"):
        text = skill_file.read_text(encoding="utf-8")
        if "python -X utf8" in text:
            assert "story_craft.py" in text


def test_story_query_is_read_only():
    text = (SKILLS_DIR / "story-query" / "SKILL.md").read_text(encoding="utf-8")
    assert "不写 state" in text
    assert "不调用 Agent" in text
