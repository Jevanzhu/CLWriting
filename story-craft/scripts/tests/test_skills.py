from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = PLUGIN_ROOT / "skills"


EXPECTED_SKILLS = {
    "story-init": [
        "充分性闸门",
        "init",
        "--project-type",
        "--from-config",
        "project_type=short",
        "project_type=long",
        "4 核心 Agent",
        "9 Agent",
        "story-import",
        "完成条件",
    ],
    "story-plan": ["充分性闸门", "大纲/总纲.md", "memory.json", "完成条件"],
    "story-write": ["充分性闸门", "context-agent", "reviewer", "data-agent", "ChapterRecordService.record"],
    "story-long-write": [
        "5 个场景",
        "8 步 commit pipeline",
        "tools.scenario_router.detect_scenario",
        'subagent_type: "story-craft:context-agent"',
        'subagent_type: "story-craft:narrative-writer"',
        'subagent_type: "story-craft:reviewer"',
        'subagent_type: "story-craft:data-agent"',
        "ChapterContract",
        "chapter-commit",
        "EventProjectionRouter.dispatch",
        "state",
        "memory",
        "summary",
        "index",
        "vector",
        "markdown_view",
        "CC 验证清单",
    ],
    "story-long-plan": [
        'subagent_type: "story-craft:story-architect"',
        'subagent_type: "story-craft:character-designer"',
        "master.json",
        "volumes/",
        "chapters/",
        "character_registry",
        "project_type=long",
        "CC 验证清单",
    ],
    "story-long-analyze": [
        "只读分析",
        "query status",
        "query memory",
        "query quality",
        "tools.strand_calculator.evaluate_strand_balance",
        "伏笔债",
        "Strand 分布",
        "CC 验证清单",
    ],
    "story-long-scan": [
        "placeholder-scan",
        'subagent_type: "story-craft:consistency-checker"',
        "grep-first",
        "health",
        "默认只读",
        "CC 验证清单",
    ],
    "story-short-write": [
        "project_type=short",
        "退化矩阵",
        'subagent_type: "story-craft:context-agent"',
        'subagent_type: "story-craft:narrative-writer"',
        'subagent_type: "story-craft:reviewer"',
        'subagent_type: "story-craft:data-agent"',
        "requested_mode=solo",
        "index/vector",
        "lazy",
        "chapter-commit",
        "跳过 Git 备份",
        "CC 验证清单",
    ],
    "story-short-analyze": [
        "只读分析",
        "情绪曲线",
        "反转链",
        "tools.deslop_metrics.analyze_deslop_metrics",
        "结尾回响",
        "CC 验证清单",
    ],
    "story-short-scan": [
        "placeholder-scan",
        "6-Gate",
        'subagent_type: "story-craft:reviewer"',
        "requested_mode=solo",
        "默认只读",
        "不执行 Git 备份",
        "CC 验证清单",
    ],
    "story-review": [
        "充分性闸门",
        "reviewer",
        "requested_mode",
        "full",
        "lean",
        "solo",
        "S1/S2",
        "审查报告",
        "完成条件",
    ],
    "story-learn": [
        "充分性闸门",
        "pattern_type",
        "project_learning.json",
        "短篇",
        "长篇",
        "shared",
        "learn",
    ],
    "story-query": [
        "只读",
        "ContractStore",
        "CommitStore",
        "query context",
        "query memory",
        "query learning",
        "query genres",
    ],
    "story-preflight": [
        "充分性闸门",
        "placeholder-scan",
        "project_type=short",
        "project_type=long",
        "recommended_skill",
        "无合同 = blocker",
        "只读",
        "CC 验证清单",
    ],
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
    assert "不触发 `index/vector` rebuild" in text


def test_story_long_write_documents_all_scenarios_and_pipeline_order():
    text = (SKILLS_DIR / "story-long-write" / "SKILL.md").read_text(encoding="utf-8")
    for scenario in (
        "daily_continue",
        "major_revision",
        "new_volume",
        "open_book",
        "import_external",
    ):
        assert scenario in text
    for step in range(1, 9):
        assert f"Step {step}" in text
    assert "无合同 = blocker" in text
    assert "不得读取 `大纲/总纲.md` 反推章节合同" in text
    assert "真实 Claude Code 端到端结果与本地 pytest 自动验证分开记录" in text


def test_story_long_plan_analyze_scan_have_distinct_boundaries():
    long_plan = (SKILLS_DIR / "story-long-plan" / "SKILL.md").read_text(encoding="utf-8")
    long_analyze = (SKILLS_DIR / "story-long-analyze" / "SKILL.md").read_text(encoding="utf-8")
    long_scan = (SKILLS_DIR / "story-long-scan" / "SKILL.md").read_text(encoding="utf-8")

    assert "不写正文，不调用 `narrative-writer`" in long_plan
    assert "最终合同写入必须由主流程确认后执行" in long_plan
    assert "只读，不写 state、memory、commit、合同或正文" in long_analyze
    assert "不生成新剧情事实" in long_analyze
    assert "默认只读" in long_scan
    assert "若用户要求修复，转入 `story-long-write` 的 `major_revision` 场景" in long_scan


def test_story_short_skills_document_degradation_matrix():
    short_write = (SKILLS_DIR / "story-short-write" / "SKILL.md").read_text(encoding="utf-8")
    short_analyze = (SKILLS_DIR / "story-short-analyze" / "SKILL.md").read_text(encoding="utf-8")
    short_scan = (SKILLS_DIR / "story-short-scan" / "SKILL.md").read_text(encoding="utf-8")

    for phrase in (
        "无 `volumes/`",
        "`style_fingerprint` 可选",
        "`state/memory/summary/markdown_view` 4 投影实时",
        "`index/vector` 默认 lazy",
        "只使用 4 核心 Agent",
        "reviewer 默认 `solo` mode",
        "跳过 Git 备份",
    ):
        assert phrase in short_write
    assert "不生成新剧情事实" in short_analyze
    assert "只读，不写 state、memory、commit、合同或正文" in short_analyze
    assert "不改正文，不写 commit" in short_scan
    assert "不调用 `data-agent`" in short_scan


def test_common_skills_document_stage3_dual_track_contracts():
    init = (SKILLS_DIR / "story-init" / "SKILL.md").read_text(encoding="utf-8")
    review = (SKILLS_DIR / "story-review" / "SKILL.md").read_text(encoding="utf-8")
    learn = (SKILLS_DIR / "story-learn" / "SKILL.md").read_text(encoding="utf-8")
    preflight = (SKILLS_DIR / "story-preflight" / "SKILL.md").read_text(encoding="utf-8")

    assert "写入 `.story/contracts/master.json`" in init
    assert "短篇 `/story-short-write`，长篇 `/story-long-plan`" in init
    assert "project_type=short" in review
    assert "project_type=long" in review
    assert "requested/effective mode" in review
    assert "适用轨道：短篇、长篇或 shared" in learn
    assert "只写 `.story/project_learning.json`" in learn
    assert "短篇项目不因缺 `volumes/` 阻断" in preflight
    assert "长篇项目缺 volume/chapter 合同时阻断" in preflight
    assert "不写 state、memory、commit、合同或正文" in preflight
