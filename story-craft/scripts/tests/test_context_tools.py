from __future__ import annotations

import json
from pathlib import Path

from conftest import reviewer_issue, run_cli
from core.config import StoryCraftConfig
from core.context_manager import ContextManager
from core.chapter_paths import chapter_record_file_name
from core.chapter_record import ChapterRecordService
from core.contract_store import ContractStore
from core.memory_manager import MemoryManager
from tools.genre_profile_builder import build_genre_hints
from tools.init_project import init_project
from tools.agent_workflow import normalize_reviewer_output
from tools.learning_extractor import extract_learning_candidates
from tools.outline_planner import plan_story
from tools.placeholder_scanner import scan_placeholders
from tools.project_memory import append_learning_pattern, get_learning_patterns
from tools.prewrite_validator import validate_prewrite
from tools.review_pipeline import build_review_report
from tools.style_sampler import detect_style_drift, extract_style_sample
from tools.writing_guidance_builder import build_anti_ai_checklist, build_writing_checklist


def _write_chapter_contract(project: Path, chapter: int = 1, **overrides) -> None:
    payload = {
        "contract_version": "story-craft/contract-v1",
        "chapter": chapter,
        "volume": 0,
        "title": f"第{chapter:02d}章",
        "chapter_directive": "推进本章核心冲突。",
        "must_cover": ["兑现关键线索"],
        "forbidden_zones": [],
        "planned_word_count": 3000,
        "expected_strand": "quest",
        "open_loops_to_plant": [],
        "open_loops_to_close": [],
        "created_at": "2026-06-08T00:00:00Z",
        "updated_at": "2026-06-08T00:00:00Z",
    }
    payload.update(overrides)
    ContractStore.from_project(project).write_chapter(payload)


def test_context_manager_builds_four_sections(tmp_path):
    project = tmp_path / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
    )
    plan_story(project, chapter_count=2)
    memory = MemoryManager.from_project(project)
    memory.apply_chapter_delta(
        {
            "chapter": 1,
            "entities_appeared": ["char_protagonist"],
            "new_foreshadowing": [
                {
                    "id": "fh_001",
                    "content": "天台纸条",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                }
            ],
            "timeline_entry": {
                "chapter": 1,
                "time_marker": "周三傍晚",
                "events": ["收到信件"],
                "time_delta": "0",
            },
            "chapter_summary": {
                "chapter": 1,
                "title": "葬礼后的信",
                "summary": "林墨收到亡友来信",
                "hook_type": "悬念钩",
            },
        }
    )
    memory.flush()
    append_learning_pattern(
        project,
        "pacing",
        "铺垫过长",
        "第1章开头",
        "每章前300字内出现行动或异常",
        1,
    )
    ChapterRecordService(StoryCraftConfig.from_project_root(project)).record(
        1,
        "葬礼后的信",
        1800,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        category="pacing",
                        description="节奏略慢",
                        evidence="开头铺垫偏长",
                        fix_hint="压缩背景说明",
                    )
                ],
                "summary": "可提交。",
            }
        ),
        {"chapter_summary": {"chapter": 1, "title": "葬礼后的信", "summary": "林墨收到亡友来信"}},
    )

    context = ContextManager.from_project(project).build_context(2)

    assert {"core", "scene", "continuity", "guidance"}.issubset(context)
    assert context["core"]["chapter_goal"] == "完成主线选择，并兑现开篇承诺。"
    assert context["core"]["chapter_outline"] == "完成主线选择，并兑现开篇承诺。"
    assert context["core"]["must_cover"] == [
        "真相、代价与角色欲望同时抵达临界点。",
        "回收核心伏笔并保留必要余韵。",
    ]
    assert context["core"]["chapter_title"] == "终局回收"
    assert context["core"]["planned_word_count"] == 15000
    assert context["core"]["directive_source"] == "contract"
    assert context["scene"]["recent_summaries"][0]["chapter"] == 1
    assert context["continuity"]["unresolved_foreshadowing"][0]["id"] == "fh_001"
    assert context["guidance"]["genre_profile"]["genre"] == "悬疑灵异"
    assert context["guidance"]["learning_patterns"][0]["pattern_type"] == "pacing"
    assert context["guidance"]["anti_ai_checklist"]


def test_context_manager_does_not_read_outline_without_contract(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    (project / "大纲" / "总纲.md").write_text(
        "# 暗室\n\n## 第01章 葬礼后的信\n必须埋下天台纸条线索。\n",
        encoding="utf-8",
    )

    context = ContextManager.from_project(project).build_context(1)

    assert context["core"]["chapter_goal"] == ""
    assert context["core"]["chapter_outline"] == ""
    assert context["core"]["must_cover"] == []
    assert context["core"]["planned_word_count"] == 0
    assert context["core"]["directive_source"] == "none"


def test_context_tools_return_expected_shapes():
    placeholders = scan_placeholders("这里有[TODO:补线索]，还有{待定结尾}。")
    assert len(placeholders) == 2
    assert "第1行" in placeholders[0]["location"]

    hints = build_genre_hints("悬疑")
    assert hints["genre"] == "悬疑灵异"
    assert "pacing" in hints
    for genre in ("都市日常", "历史脑洞", "电竞", "黑暗题材"):
        layered = build_genre_hints(genre)
        assert layered["genre"] == genre
        assert layered["pacing"] != "保持场景目标清晰，每章至少完成一次信息推进或关系变化。"
        assert len(layered["pitfalls"]) >= 2

    sample = extract_style_sample("“你来了。”他转身。冷光落在门上。", 1)
    baseline = dict(sample)
    baseline["avg_sentence_length"] = sample["avg_sentence_length"] + 20
    assert detect_style_drift(sample, baseline)

    checklist = build_writing_checklist(
        3,
        [{"review": {"warnings": [{"category": "dialogue", "description": "对白解释过多"}]}}],
        [{"id": "pat_001", "pattern_type": "hook", "instruction": "开篇先给异常"}],
    )
    assert len(checklist) >= 4
    assert build_anti_ai_checklist()

    report = build_review_report(
        2,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        severity="critical",
                        category="continuity",
                        location="第2段",
                        description="规则冲突",
                        evidence="正文规则与世界观冲突",
                        fix_hint="按世界观修正规则表达",
                        blocking=True,
                    )
                ],
                "summary": "存在规则冲突。",
            }
        ),
        "正文内容",
    )
    assert "未通过" in report
    assert "规则冲突" in report


def test_project_memory_and_prewrite_validator(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    pattern = append_learning_pattern(
        project,
        "dialogue",
        "对白解释",
        "某段对白",
        "对白必须带冲突",
        1,
    )
    assert pattern["id"] == "pat_001"
    assert get_learning_patterns(project, "dialogue")[0]["instruction"] == "对白必须带冲突"

    validation = validate_prewrite(project, 1)
    assert not validation["ready"]
    assert any("缺少章节合同" in item for item in validation["blockers"])

    _write_chapter_contract(project, 1)
    (project / "大纲" / "总纲.md").write_text(
        "# 暗室\n\n## 第01章\n[TODO:总纲旧占位符]\n",
        encoding="utf-8",
    )
    validation = validate_prewrite(project, 1)
    assert validation["ready"]
    assert not any("占位符" in item for item in validation["warnings"])

    (project / "大纲" / "总纲.md").unlink()
    validation = validate_prewrite(project, 1)
    assert validation["ready"]
    assert not any("总纲" in item for item in validation["warnings"])

    _write_chapter_contract(project, 2)
    validation = validate_prewrite(project, 2)
    assert not validation["ready"]
    assert any("缺少上一章验收记录" in item for item in validation["blockers"])


def test_learning_pattern_dedup_and_metadata(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    first = append_learning_pattern(
        project,
        "hook",
        "章末钩子",
        "",
        "每章末留悬念钩子",
        1,
        source="manual",
        importance="medium",
    )
    assert first["id"] == "pat_001"
    assert first["source"] == "manual"
    assert first["importance"] == "medium"
    assert "merged" not in first

    # 同类型 + 标点/空白差异的相同指令 → 合并而非新增；importance 取高、补 example
    merged = append_learning_pattern(
        project,
        "hook",
        "章末钩子（自动提炼）",
        "他推开门，发现尸体",
        "每章末，留悬念钩子。",
        2,
        source="auto-review",
        importance="high",
    )
    assert merged["id"] == "pat_001"
    assert merged["merged"] is True
    assert merged["importance"] == "high"
    assert merged["example"] == "他推开门，发现尸体"
    # 合并保留所有来源，不丢失"被多来源确认"信息
    assert set(merged["source"].split(",")) == {"manual", "auto-review"}
    assert len(get_learning_patterns(project)) == 1

    # 不同类型的相同指令 → 不合并
    other = append_learning_pattern(
        project, "pacing", "节奏", "", "每章末留悬念钩子", 3
    )
    assert other["id"] == "pat_002"
    assert len(get_learning_patterns(project)) == 2

    # 纯标点 instruction 归一化为空时回退原文，仍能去重而非重复新增
    punct1 = append_learning_pattern(project, "format", "排版1", "", "。。。", 4)
    punct2 = append_learning_pattern(project, "format", "排版2", "", "。。。", 5)
    assert punct2["id"] == punct1["id"]
    assert punct2["merged"] is True


def test_map_pattern_type_maps_reviewer_categories():
    from tools.agent_workflow import REVIEWER_CATEGORIES
    from tools.learning_extractor import _map_pattern_type

    # 真实 reviewer category 的映射
    assert _map_pattern_type("pacing") == "pacing"
    assert _map_pattern_type("format") == "format"
    assert _map_pattern_type("high_point") == "payoff"
    assert _map_pattern_type("reader_pull") == "hook"
    assert _map_pattern_type("ooc") == "dialogue"
    assert _map_pattern_type("ai_flavor") == "format"
    # 无 learning 对应的 reviewer 类归 other
    assert _map_pattern_type("timeline") == "other"
    assert _map_pattern_type("continuity") == "other"
    # 非 reviewer 类/未知归 other（精确查表不再子串误匹配）
    assert _map_pattern_type("information") == "other"
    assert _map_pattern_type("spacing") == "other"
    # 所有真实 reviewer 类都映射到合法 learning 7 类（实战对齐保证）
    valid = {"hook", "pacing", "dialogue", "payoff", "emotion", "format", "other"}
    for category in REVIEWER_CATEGORIES:
        assert _map_pattern_type(category) in valid


def test_rank_learning_patterns_sorts_and_truncates():
    from tools.project_memory import DEFAULT_LEARNING_LIMIT, rank_learning_patterns

    patterns = [
        {"id": "p1", "importance": "low", "chapter": 1, "instruction": "a"},
        {"id": "p2", "importance": "high", "chapter": 2, "instruction": "b"},
        {"id": "p3", "importance": "medium", "chapter": 5, "instruction": "c"},
        {"id": "p4", "importance": "high", "chapter": 8, "instruction": "d"},
    ]
    # importance 高优先，同级按章节新近度：p4(high,8) > p2(high,2) > p3(medium,5) > p1(low,1)
    ranked = rank_learning_patterns(patterns, limit=0)
    assert [p["id"] for p in ranked] == ["p4", "p2", "p3", "p1"]

    # top-N 截断只保留最重要/最新的
    assert [p["id"] for p in rank_learning_patterns(patterns, limit=2)] == ["p4", "p2"]

    # 默认上限防膨胀
    many = [
        {"id": f"p{i}", "importance": "medium", "chapter": i, "instruction": f"i{i}"}
        for i in range(20)
    ]
    assert len(rank_learning_patterns(many)) == DEFAULT_LEARNING_LIMIT


def test_disable_learning_pattern_excludes_from_injection(tmp_path):
    from tools.project_memory import (
        disable_learning_pattern,
        rank_learning_patterns,
    )

    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    p1 = append_learning_pattern(project, "hook", "钩子", "", "每章末留悬念", 1)
    append_learning_pattern(project, "pacing", "节奏", "", "中段保持密度", 2)

    # 停用 p1
    assert disable_learning_pattern(project, p1["id"])["status"] == "disabled"
    # 注入路径排除已停用，但保留另一条
    ranked = rank_learning_patterns(get_learning_patterns(project))
    assert p1["id"] not in [p["id"] for p in ranked]
    assert len(ranked) == 1
    # 数据仍保留可恢复
    assert any(p.get("disabled") for p in get_learning_patterns(project))
    # 幂等 + 不存在 id
    assert disable_learning_pattern(project, p1["id"])["status"] == "already_disabled"
    assert disable_learning_pattern(project, "pat_999")["status"] == "not_found"


def test_cli_learn_forget_and_missing_args(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    run_cli(
        "--project-root", str(project), "learn",
        "--chapter", "1", "--pattern-type", "hook",
        "--description", "钩子", "--instruction", "每章末留悬念",
    )
    # --forget 停用
    forget = run_cli("--project-root", str(project), "learn", "--forget", "pat_001")
    assert forget.returncode == 0, forget.stderr
    assert json.loads(forget.stdout)["status"] == "disabled"
    # 记录模式缺必填参数 → 报错
    bad = run_cli("--project-root", str(project), "learn", "--pattern-type", "hook")
    assert bad.returncode != 0


def test_failure_result_includes_next_step():
    from pathlib import Path as _Path

    from tools.chapter_workflow import _failure_result

    result = _failure_result(
        stage="markdown", blockers=["残留"], warnings=[], draft_path=_Path("/tmp/d.md")
    )
    assert "Markdown" in result["next_step"]
    # 未知 stage 用兜底修复指引
    fallback = _failure_result(
        stage="write_error", blockers=["x"], warnings=[], draft_path=_Path("/tmp/d.md")
    )
    assert fallback["next_step"]


def test_extract_learning_candidates_tolerates_malformed_records(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    config = StoryCraftConfig.from_project_root(project)
    config.chapters_dir.mkdir(parents=True, exist_ok=True)
    (config.chapters_dir / chapter_record_file_name(1)).write_text(
        json.dumps({"chapter": 1, "review": ["bad"]}, ensure_ascii=False),
        encoding="utf-8",
    )
    (config.chapters_dir / chapter_record_file_name(2)).write_text(
        json.dumps(
            {"chapter": 2, "review": {"warnings": "notalist", "blockers": None}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    # 畸形结构不崩溃且不产出垃圾候选
    assert extract_learning_candidates(project) == []


def _write_chapter_record(config, chapter, warnings=None, blockers=None, style_sample=None):
    config.chapters_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "chapter": chapter,
        "status": "accepted",
        "word_count": 2000,
        "review": {
            "passed": not blockers,
            "warnings": warnings or [],
            "blockers": blockers or [],
        },
        "style_sample": style_sample or {},
    }
    path = config.chapters_dir / chapter_record_file_name(chapter)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def test_extract_learning_candidates_from_reviews(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    config = StoryCraftConfig.from_project_root(project)

    # 同一节奏问题跨 3 章重复 → 提炼（pacing→pacing）
    for ch in (1, 2, 3):
        _write_chapter_record(
            config, ch, warnings=[{"category": "pacing", "description": "中段节奏拖沓"}]
        )
    # 单次 warning（仅 1 章）→ 不提炼
    _write_chapter_record(
        config, 4, warnings=[{"category": "reader_pull", "description": "开篇拉力不足"}]
    )
    # blocker 单次 → 提炼为高重要度（timeline 无 learning 对应，归 other）
    _write_chapter_record(
        config, 5, blockers=[{"category": "timeline", "description": "时间线前后矛盾"}]
    )
    # high_point 跨 2 章 → 提炼，映射到 payoff
    for ch in (6, 7):
        _write_chapter_record(
            config, ch, warnings=[{"category": "high_point", "description": "高潮平淡收尾"}]
        )

    candidates = extract_learning_candidates(project)
    by_type = {item["pattern_type"]: item for item in candidates}

    # 节奏问题被提炼，类型映射正确、跨 3 章、来源 auto-review
    assert "pacing" in by_type
    pacing = by_type["pacing"]
    assert pacing["source"] == "auto-review"
    assert pacing["evidence"]["occurrences"] == 3
    assert pacing["evidence"]["chapters"] == [1, 2, 3]
    assert "中段节奏拖沓" in pacing["instruction"]

    # high_point 跨 2 章 → 提炼并映射到 payoff
    assert "payoff" in by_type
    assert by_type["payoff"]["evidence"]["occurrences"] == 2

    # reader_pull 仅单次 → 未达阈值，hook 不出现
    assert "hook" not in by_type

    # timeline blocker 单次即提炼，importance=high，归 other
    assert "other" in by_type
    flagged = by_type["other"]
    assert flagged["importance"] == "high"
    assert flagged["evidence"]["has_blocker"] is True

    # 严重度优先：blocker/high importance 候选排最前
    assert candidates[0]["importance"] == "high"
    assert candidates[0]["evidence"]["has_blocker"] is True
    # 同严重度内按置信度降序
    ranks = {"low": 0, "medium": 1, "high": 2}
    sort_keys = [(ranks[item["importance"]], item["confidence"]) for item in candidates]
    assert sort_keys == sorted(sort_keys, reverse=True)


def test_extract_style_drift_candidates_unit():
    from tools.learning_extractor import _extract_style_drift_candidates

    base = {
        "avg_sentence_length": 15, "dialogue_ratio": 0.3,
        "description_ratio": 0.2, "action_ratio": 0.2, "vocabulary_tier": "simple",
    }
    drifted = {
        "avg_sentence_length": 33, "dialogue_ratio": 0.3,
        "description_ratio": 0.2, "action_ratio": 0.2, "vocabulary_tier": "literary",
    }
    # 句长+词汇层级相对基准持续漂移，跨 ch2/3/4
    records = [(1, base), (2, drifted), (3, drifted), (4, drifted)]
    cands = _extract_style_drift_candidates(records, min_chapters=2)
    assert cands
    assert all(c["source"] == "auto-style" and c["pattern_type"] == "format" for c in cands)
    assert any("句长" in c["description"] for c in cands)
    # 样本不足（仅 baseline + 1 章）不提炼
    assert _extract_style_drift_candidates([(1, base), (2, drifted)], min_chapters=2) == []


def test_extract_includes_auto_style_from_records(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    config = StoryCraftConfig.from_project_root(project)
    base = {
        "avg_sentence_length": 15, "dialogue_ratio": 0.3,
        "description_ratio": 0.2, "action_ratio": 0.2, "vocabulary_tier": "simple",
    }
    drifted = {
        "avg_sentence_length": 33, "dialogue_ratio": 0.3,
        "description_ratio": 0.2, "action_ratio": 0.2, "vocabulary_tier": "literary",
    }
    _write_chapter_record(config, 1, style_sample=base)
    _write_chapter_record(config, 2, style_sample=drifted)
    _write_chapter_record(config, 3, style_sample=drifted)

    auto_style = [c for c in extract_learning_candidates(project) if c["source"] == "auto-style"]
    assert auto_style
    assert all(c["pattern_type"] == "format" for c in auto_style)


def test_cli_learn_suggest(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    config = StoryCraftConfig.from_project_root(project)
    for ch in (1, 2):
        _write_chapter_record(
            config, ch, warnings=[{"category": "pacing", "description": "中段节奏拖沓"}]
        )

    result = run_cli("--project-root", str(project), "query", "learning-suggestions")
    assert result.returncode == 0, result.stderr
    candidates = json.loads(result.stdout)["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["pattern_type"] == "pacing"
    assert candidates[0]["source"] == "auto-review"

    # 阈值收紧后不再产出候选
    strict = run_cli(
        "--project-root",
        str(project),
        "query",
        "learning-suggestions",
        "--min-occurrences",
        "5",
    )
    assert strict.returncode == 0, strict.stderr
    assert json.loads(strict.stdout)["candidates"] == []


def test_cli_learn_import_source(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    result = run_cli(
        "--project-root",
        str(project),
        "learn",
        "--chapter",
        "1",
        "--pattern-type",
        "pacing",
        "--description",
        "参考作品的快节奏开篇",
        "--instruction",
        "开篇用短句快速切入冲突",
        "--source",
        "import",
    )
    assert result.returncode == 0, result.stderr
    pattern = json.loads(result.stdout)
    assert pattern["source"] == "import"
    # 参考拆解技法入库后与其它 learning 同一体系，可被写作上下文读取
    patterns = get_learning_patterns(project)
    assert any(item["source"] == "import" for item in patterns)


def test_prewrite_validator_blocks_incomplete_contract_and_scans_contract_placeholders(
    tmp_path,
):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    _write_chapter_contract(
        project,
        1,
        chapter_directive="进入旧楼并处理[TODO:补行动目标]。",
        must_cover=["发现门卫证词", "{待定线索}"],
        planned_word_count=0,
    )

    validation = validate_prewrite(project, 1)

    assert not validation["ready"]
    assert any("planned_word_count 无效" in item for item in validation["blockers"])
    assert any("章节合同存在占位符" in item for item in validation["warnings"])


def test_prewrite_validator_blocks_invalid_planned_word_count_values(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    invalid_values = (None, -1, "三千")
    for chapter, planned_word_count in enumerate(invalid_values, start=1):
        if planned_word_count is None:
            _write_chapter_contract(project, chapter)
            contract_path = (
                StoryCraftConfig.from_project_root(project).chapter_contracts_dir
                / f"chapter_{chapter:03d}.json"
            )
            payload = json.loads(contract_path.read_text(encoding="utf-8"))
            payload.pop("planned_word_count")
            contract_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        else:
            _write_chapter_contract(
                project,
                chapter,
                planned_word_count=planned_word_count,
            )

        validation = validate_prewrite(project, chapter)
        assert not validation["ready"]
        assert any("planned_word_count 无效" in item for item in validation["blockers"])


def test_cli_query_learn_review_paths(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")

    learn = run_cli(
        "--project-root",
        str(project),
        "learn",
        "--chapter",
        "1",
        "--pattern-type",
        "hook",
        "--description",
        "开篇慢",
        "--instruction",
        "前300字给异常",
    )
    assert learn.returncode == 0, learn.stderr
    assert json.loads(learn.stdout)["pattern_type"] == "hook"

    query = run_cli(
        "--project-root",
        str(project),
        "query",
        "context",
        "--chapter",
        "1",
    )
    assert query.returncode == 0, query.stderr
    assert "core" in json.loads(query.stdout)

    review_json = tmp_path / "review.json"
    chapter_file = tmp_path / "chapter.md"
    report_file = tmp_path / "report.md"
    review_json.write_text(json.dumps({"issues": [], "summary": "可提交。"}), encoding="utf-8")
    chapter_file.write_text("正文内容", encoding="utf-8")
    review = run_cli(
        "--project-root",
        str(project),
        "review",
        "--chapter",
        "1",
        "--review-results",
        str(review_json),
        "--chapter-file",
        str(chapter_file),
        "--report-file",
        str(report_file),
    )
    assert review.returncode == 0, review.stderr
    assert report_file.is_file()


def test_cli_reviewer_schema_errors_are_actionable(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "暗室", "悬疑")
    chapter_file = tmp_path / "chapter.md"
    chapter_file.write_text("正文内容", encoding="utf-8")

    missing_summary = tmp_path / "missing-summary.json"
    missing_summary.write_text(json.dumps({"issues": []}), encoding="utf-8")
    review = run_cli(
        "--project-root",
        str(project),
        "review",
        "--chapter",
        "1",
        "--review-results",
        str(missing_summary),
        "--chapter-file",
        str(chapter_file),
        "--report-file",
        str(tmp_path / "report.md"),
    )
    assert review.returncode == 1
    assert "内部错误" not in review.stderr
    assert "reviewer JSON 缺少必需字段：summary" in review.stderr

    missing_issues = tmp_path / "missing-issues.json"
    missing_issues.write_text(json.dumps({"summary": "格式错误"}), encoding="utf-8")
    repair = run_cli(
        "--project-root",
        str(project),
        "agent",
        "repair",
        "--chapter",
        "1",
        "--review-results",
        str(missing_issues),
        "--draft-file",
        str(chapter_file),
    )
    assert repair.returncode == 1
    assert "内部错误" not in repair.stderr
    assert "reviewer JSON 缺少必需字段：issues" in repair.stderr
