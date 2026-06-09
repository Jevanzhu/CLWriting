from __future__ import annotations

import re
from pathlib import Path

from conftest import reviewer_issue
from tools.agent_workflow import REVIEWER_CATEGORIES, normalize_reviewer_output


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REVIEWER = PLUGIN_ROOT / "agents" / "reviewer.md"
SCHEMA = PLUGIN_ROOT / "references" / "shared" / "review-schema.md"

STAGE3_CATEGORIES = {
    "high_point",
    "consistency",
    "pacing",
    "ooc",
    "continuity",
    "reader_pull",
    "setting",
    "timeline",
    "logic",
    "ai_flavor",
    "format",
    "safety",
    "contract",
    "strand",
}
SIX_DIMENSIONS = {
    "High-point",
    "Consistency",
    "Pacing",
    "OOC",
    "Continuity",
    "Reader-pull",
}
SIX_DESLOP_GATES = {
    "禁用词密度",
    "连续排比段数",
    "心理词占比",
    "对话标签密度",
    "平均段落句数",
    "重复描写密度",
}


def test_reviewer_declares_all_six_dimensions_and_strand_diagnostic():
    text = REVIEWER.read_text(encoding="utf-8")

    for dimension in SIX_DIMENSIONS:
        assert dimension in text
    assert "tools.strand_calculator.evaluate_strand_balance" in text
    assert "Strand 60/20/20" in text


def test_reviewer_declares_all_six_deslop_gates_and_quant_meta():
    reviewer_text = REVIEWER.read_text(encoding="utf-8")
    schema_text = SCHEMA.read_text(encoding="utf-8")

    for gate in SIX_DESLOP_GATES:
        assert gate in reviewer_text
        assert gate in schema_text
    assert "tools.deslop_metrics.analyze_deslop_metrics" in reviewer_text
    assert "tools/deslop_metrics.py" in schema_text
    assert "meta.quant" in reviewer_text


def test_reviewer_modes_have_required_behavior():
    text = REVIEWER.read_text(encoding="utf-8")

    for agent_name in (
        "story-architect",
        "character-designer",
        "narrative-writer",
        "consistency-checker",
    ):
        assert agent_name in text
    assert "长篇：默认 `lean`" in text
    assert "短篇：默认 `solo`" in text
    assert "自动降级为 `solo`" in text
    assert "lean`：只调用本 reviewer 逻辑" in text
    assert "不并行多视角" in text
    assert "solo`：只读正文、合同上下文和 `references/shared/review/fallback-rubric.md`" in text
    assert "rubric_source=fallback" in SCHEMA.read_text(encoding="utf-8")


def test_reviewer_meta_contract_is_complete():
    text = REVIEWER.read_text(encoding="utf-8")
    schema_text = SCHEMA.read_text(encoding="utf-8")

    for key in (
        "requested_mode",
        "effective_mode",
        "fallback_reason",
        "rubric_source",
        "dimensions",
        "quant",
    ):
        assert key in text
        assert key in schema_text

    for label in (
        "Requested Mode",
        "Effective Mode",
        "Fallback",
        "Rubric",
        "Rubric Source",
    ):
        assert label in text


def test_reviewer_output_categories_are_stage3_fourteen_with_local_character_compat():
    reviewer_categories = _reviewer_category_enum(REVIEWER.read_text(encoding="utf-8"))
    schema_categories = _schema_category_bullets(SCHEMA.read_text(encoding="utf-8"))

    assert reviewer_categories == STAGE3_CATEGORIES
    assert schema_categories == STAGE3_CATEGORIES
    assert REVIEWER_CATEGORIES == STAGE3_CATEGORIES | {"character"}

    legacy = reviewer_issue(category="character", severity="low", blocking=False)
    normalized = normalize_reviewer_output({"issues": [legacy], "summary": "兼容旧输入"})
    assert normalized["warnings"][0]["category"] == "character"


def _reviewer_category_enum(text: str) -> set[str]:
    match = re.search(r'"category":\s*\{\s*"enum":\s*\[(.*?)\]\s*\}', text, re.DOTALL)
    assert match, "reviewer category enum missing"
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


def _schema_category_bullets(text: str) -> set[str]:
    category_section = text.split("## category", 1)[1].split("兼容输入", 1)[0]
    return set(re.findall(r"- `([a-z_]+)`：", category_section))
