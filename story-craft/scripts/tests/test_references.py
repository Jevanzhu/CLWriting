from __future__ import annotations

import csv
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REFERENCES_DIR = PLUGIN_ROOT / "references"


EXPECTED_REFERENCE_FILES = {
    "README.md",
    "shared/core-constraints.md",
    "shared/genre-profiles.md",
    "shared/naming-and-voice-gaps.md",
    "shared/payoff-points-guide.md",
    "shared/review-schema.md",
    "shared/review/blocking-override-guidelines.md",
    "shared/review/fallback-rubric.md",
    "shared/strand-weave-pattern.md",
    "shared/csv/README.md",
    "shared/csv/genre-canonical.md",
    "shared/csv/人设与关系.csv",
    "shared/csv/写作技法.csv",
    "shared/csv/命名规则.csv",
    "shared/csv/场景写法.csv",
    "shared/csv/桥段套路.csv",
    "shared/csv/爽点与节奏.csv",
    "shared/csv/裁决规则.csv",
    "shared/csv/金手指与设定.csv",
    "shared/csv/题材与调性推理.csv",
    "short/reading-power-taxonomy.md",
    "short/plot-signal-vs-spoiler.md",
    "long/README.md",
    "index/reference-loading-map.md",
    "index/reference-gap-register.md",
}

CSV_FILES = [
    path
    for path in EXPECTED_REFERENCE_FILES
    if path.startswith("shared/csv/") and path.endswith(".csv")
]

REQUIRED_MARKDOWN_PHRASES = {
    "README.md": ["短篇项目只加载 `short/` + `shared/`", "长篇项目加载 `long/` + `shared/`"],
    "shared/genre-profiles.md": ["1-10 万字", "37 个题材标签", "结尾"],
    "shared/review-schema.md": ["blocking", "issues", "severity", "S1", "6-Gate"],
    "shared/core-constraints.md": ["1-10 万字", "伏笔", "结尾"],
    "shared/naming-and-voice-gaps.md": ["命名", "语调", "称呼"],
    "short/reading-power-taxonomy.md": ["阅读驱动力", "短篇", "结尾"],
    "short/plot-signal-vs-spoiler.md": ["情节信号", "剧透", "回收"],
    "long/README.md": ["S5-01", "S5-02", "references/shared/"],
    "shared/review/blocking-override-guidelines.md": ["不可覆盖", "可考虑覆盖", "用户确认"],
    "shared/review/fallback-rubric.md": ["13 条核心 rubric", "AI 味速查", "Rubric Source"],
    "index/reference-loading-map.md": [
        "references/short/",
        "references/long/",
        "references/shared/",
        "/story-init",
        "/story-plan",
        "/story-write",
        "/story-long-write",
        "/story-long-plan",
        "/story-long-analyze",
        "/story-long-scan",
        "/story-short-write",
        "/story-short-analyze",
        "/story-short-scan",
        "/story-review",
        "fallback rubric",
        "/story-preflight",
        "/story-deslop",
        "/story-repair",
        "/story-import",
    ],
}


def test_stage5_reference_tree_uses_three_way_split():
    for dirname in ("shared", "short", "long", "index"):
        assert (REFERENCES_DIR / dirname).is_dir()

    root_files = {
        path.name for path in REFERENCES_DIR.iterdir() if path.is_file()
    }
    assert root_files == {"README.md"}

    for old_dir in ("csv", "review", "outlining"):
        old_path = REFERENCES_DIR / old_dir
        if old_path.exists():
            assert not any(path.is_file() for path in old_path.rglob("*"))


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
        "/story-short-write",
        "/story-short-analyze",
        "/story-short-scan",
        "/story-review",
        "/story-learn",
        "/story-query",
        "/story-preflight",
        "/story-deslop",
        "/story-repair",
        "/story-import",
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
    schema = (REFERENCES_DIR / "shared" / "review-schema.md").read_text(encoding="utf-8")
    override = (
        REFERENCES_DIR / "shared" / "review" / "blocking-override-guidelines.md"
    ).read_text(encoding="utf-8")

    assert "blocking=true" in schema
    assert "不可覆盖" in override
    assert "安全" in schema
    assert "安全" in override


def test_stage3_review_schema_documents_findings_contract():
    schema = (REFERENCES_DIR / "shared" / "review-schema.md").read_text(
        encoding="utf-8"
    )
    fallback = (
        REFERENCES_DIR / "shared" / "review" / "fallback-rubric.md"
    ).read_text(encoding="utf-8")
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


def test_reference_loading_map_paths_exist_and_short_track_excludes_long():
    text = (REFERENCES_DIR / "index" / "reference-loading-map.md").read_text(
        encoding="utf-8"
    )
    reference_paths = set()
    for line in text.splitlines():
        for token in line.split("`"):
            if token.startswith("references/") and token.endswith((".md", ".csv")):
                reference_paths.add(token)

    assert reference_paths
    for reference_path in reference_paths:
        relative_path = reference_path.removeprefix("references/")
        assert (REFERENCES_DIR / relative_path).is_file(), reference_path

    short_sections = []
    capture = False
    for line in text.splitlines():
        if line.startswith("- `/story-short-"):
            capture = True
        elif capture and line.startswith("- `/story-"):
            capture = False
        if capture:
            short_sections.append(line)
    assert "references/long/" not in "\n".join(short_sections)
