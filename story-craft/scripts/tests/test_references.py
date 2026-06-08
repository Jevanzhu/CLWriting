from __future__ import annotations

import csv
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
    "review/fallback-rubric.md",
    "index/reference-loading-map.md",
    "index/reference-gap-register.md",
}

CSV_FILES = [path for path in EXPECTED_REFERENCE_FILES if path.startswith("csv/") and path.endswith(".csv")]

REQUIRED_MARKDOWN_PHRASES = {
    "genre-profiles.md": ["1-10 万字", "37 个题材标签", "结尾"],
    "review-schema.md": ["blocking", "issues", "severity", "S1", "6-Gate"],
    "shared/core-constraints.md": ["1-10 万字", "伏笔", "结尾"],
    "shared/naming-and-voice-gaps.md": ["命名", "语调", "称呼"],
    "outlining/plot-signal-vs-spoiler.md": ["情节信号", "剧透", "回收"],
    "review/blocking-override-guidelines.md": ["不可覆盖", "可考虑覆盖", "用户确认"],
    "review/fallback-rubric.md": ["13 条核心 rubric", "AI 味速查", "Rubric Source"],
    "index/reference-loading-map.md": [
        "/story-init",
        "/story-plan",
        "/story-write",
        "/story-long-write",
        "/story-long-plan",
        "/story-long-analyze",
        "/story-long-scan",
        "/story-review",
        "fallback rubric",
    ],
}


def test_all_reference_files_exist():
    assert REFERENCES_DIR.is_dir(), "missing references dir"
    actual = {
        str(path.relative_to(REFERENCES_DIR))
        for path in REFERENCES_DIR.rglob("*")
        if path.is_file()
    }
    assert EXPECTED_REFERENCE_FILES == actual


def test_markdown_references_have_required_content():
    for relative_path, phrases in REQUIRED_MARKDOWN_PHRASES.items():
        text = (REFERENCES_DIR / relative_path).read_text(encoding="utf-8")
        assert len(text.strip()) > 200
        assert text.lstrip().startswith("# ")
        for phrase in phrases:
            assert phrase in text


def test_csv_references_are_parseable_context_tables():
    for relative_path in CSV_FILES:
        rows = list(
            csv.reader(
                (REFERENCES_DIR / relative_path).read_text(encoding="utf-8").splitlines()
            )
        )
        assert len(rows) >= 4
        assert len(rows[0]) >= 3
        width = len(rows[0])
        for row in rows[1:]:
            assert width == len(row)


def test_reference_loading_map_covers_agents_and_skills():
    text = (REFERENCES_DIR / "index" / "reference-loading-map.md").read_text(
        encoding="utf-8"
    )
    for name in (
        "/story-init",
        "/story-plan",
        "/story-write",
        "/story-long-write",
        "/story-long-plan",
        "/story-long-analyze",
        "/story-long-scan",
        "/story-review",
        "/story-learn",
        "/story-query",
        "story-architect",
        "character-designer",
        "context-agent",
        "narrative-writer",
        "reviewer",
        "consistency-checker",
        "data-agent",
        "story-explorer",
        "story-researcher",
        "旧 `deconstruction-agent` 已在阶段 3 淘汰",
        "参考拆解迁入 `story-import`",
    ):
        assert name in text


def test_review_schema_and_override_guidelines_share_blocking_policy():
    schema = (REFERENCES_DIR / "review-schema.md").read_text(encoding="utf-8")
    override = (
        REFERENCES_DIR / "review" / "blocking-override-guidelines.md"
    ).read_text(encoding="utf-8")

    assert "blocking=true" in schema
    assert "不可覆盖" in override
    assert "安全" in schema
    assert "安全" in override


def test_stage3_review_schema_documents_findings_contract():
    schema = (REFERENCES_DIR / "review-schema.md").read_text(encoding="utf-8")
    fallback = (REFERENCES_DIR / "review" / "fallback-rubric.md").read_text(
        encoding="utf-8"
    )
    for severity in ("S1", "S2", "S3", "S4"):
        assert severity in schema
    for category in (
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
    ):
        assert category in schema
    assert "tools/deslop_metrics.py" in schema
    assert "fallback-rubric.md" in schema
    assert "S1/S2 必须 `blocking=true`" in fallback
