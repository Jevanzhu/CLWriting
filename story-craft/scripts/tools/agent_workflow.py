#!/usr/bin/env python3
"""Local Agent workflow payloads for story-craft."""

from __future__ import annotations

import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.context_manager import ContextManager
from core.memory_manager import MemoryManager
from core.text_utils import compact_line, count_chinese_chars, first_int, outline_value
from core.types import ExtractionDelta, ReviewerResult, WorkflowManifest
from tools.placeholder_scanner import scan_placeholders
from tools.prewrite_validator import validate_prewrite
from tools.style_sampler import extract_style_sample
from tools.writing_guidance_builder import build_anti_ai_checklist


CHINESE_SENTENCE_RE = re.compile(r"[^。！？!?]+[。！？!?]?")
TITLE_RE = re.compile(r"第0?(?P<chapter>\d+)章[：:\-\s]*(?P<title>[^\n#]*)")
WORKFLOW_FILE_NAMES = {
    "brief": "brief.json",
    "draft": "draft.md",
    "review": "review.json",
    "repair": "repair.json",
    "polish": "polish.json",
    "delta": "delta.json",
    "write_result": "write-result.json",
    "review_report": "review-report.md",
    "manifest": "manifest.json",
}


def _scripts_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def _workflow_dir(project_root: Path, chapter: int) -> Path:
    return project_root / ".story" / "workflows" / f"ch_{int(chapter):02d}"


def _shell_command(args: list[str | Path | int]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in args)


def _story_craft_command(
    project_root: Path,
    *args: str | Path | int,
) -> str:
    return _shell_command(
        [
            sys.executable or "python3",
            "-X",
            "utf8",
            _scripts_dir() / "story_craft.py",
            "--project-root",
            project_root,
            *args,
        ]
    )


def build_workflow_workspace(
    project_root: str | Path,
    chapter: int,
    *,
    create: bool = True,
) -> WorkflowManifest:
    """Build the deterministic /story-write workflow workspace manifest."""
    config = StoryCraftConfig.from_project_root(project_root)
    workflow_dir = _workflow_dir(config.project_root, chapter)
    files = {
        key: str((workflow_dir / file_name).resolve())
        for key, file_name in WORKFLOW_FILE_NAMES.items()
    }
    scripts_dir = str(_scripts_dir())
    payload = {
        "ok": True,
        "chapter": int(chapter),
        "project_root": str(config.project_root),
        "workflow_dir": str(workflow_dir.resolve()),
        "files": files,
        "agent_calls": {
            "context_agent": {
                "subagent_type": "story-craft:context-agent",
                "must_use_agent_tool": True,
                "output_file": files["brief"],
                "prompt": (
                    f"chapter={int(chapter)}; project_root={config.project_root}; "
                    f"scripts_dir={scripts_dir}; output_file={files['brief']}。"
                    "先 research，再输出 context-agent JSON 任务书；不得写正文。"
                ),
            },
            "reviewer": {
                "subagent_type": "story-craft:reviewer",
                "must_use_agent_tool": True,
                "input_file": files["draft"],
                "output_file": files["review"],
                "prompt": (
                    f"chapter={int(chapter)}; chapter_file={files['draft']}; "
                    f"project_root={config.project_root}; scripts_dir={scripts_dir}; "
                    f"output_file={files['review']}。严格输出 reviewer schema JSON。"
                ),
            },
            "data_agent": {
                "subagent_type": "story-craft:data-agent",
                "must_use_agent_tool": True,
                "input_file": files["draft"],
                "output_file": files["delta"],
                "prompt": (
                    f"chapter={int(chapter)}; chapter_file={files['draft']}; "
                    f"project_root={config.project_root}; scripts_dir={scripts_dir}; "
                    f"output_file={files['delta']}。只提取正文事实，生成 write 可消费的 delta。"
                ),
            },
        },
        "cli_commands": {
            "prepare_brief_fallback": _story_craft_command(
                config.project_root,
                "agent",
                "brief",
                "--chapter",
                int(chapter),
                "--output-file",
                files["brief"],
            ),
            "review_report": _story_craft_command(
                config.project_root,
                "review",
                "--chapter",
                int(chapter),
                "--review-results",
                files["review"],
                "--chapter-file",
                files["draft"],
                "--report-file",
                files["review_report"],
            ),
            "repair_plan": _story_craft_command(
                config.project_root,
                "agent",
                "repair",
                "--chapter",
                int(chapter),
                "--review-results",
                files["review"],
                "--draft-file",
                files["draft"],
                "--output-file",
                files["repair"],
            ),
            "polish_plan": _story_craft_command(
                config.project_root,
                "agent",
                "polish",
                "--chapter",
                int(chapter),
                "--draft-file",
                files["draft"],
                "--review-results",
                files["review"],
                "--output-file",
                files["polish"],
            ),
            "extract_fallback": _story_craft_command(
                config.project_root,
                "agent",
                "extract",
                "--chapter",
                int(chapter),
                "--chapter-file",
                files["draft"],
                "--output-file",
                files["delta"],
            ),
            "write": _story_craft_command(
                config.project_root,
                "write",
                "--chapter",
                int(chapter),
                "--draft-file",
                files["draft"],
                "--review-results",
                files["review"],
                "--delta-file",
                files["delta"],
                "--result-file",
                files["write_result"],
            ),
        },
        "steps": [
            "prepare-workflow",
            "Agent(context-agent) -> brief.json",
            "draft.md",
            "Agent(reviewer) -> review.json",
            "review-pipeline/repair",
            "polish",
            "Agent(data-agent) -> delta.json",
            "write -> write-result.json",
        ],
        "hard_rules": [
            "必须使用 Agent 工具调用 context-agent/reviewer/data-agent；不得由主流程口头替代。",
            "review.json 存在 blocking issue 时不得进入 write。",
            "data-agent 只生成 delta，不直接写 state/memory/commit。",
            "CLI 只做确定性校验、报告、修复计划、兜底抽取和提交。",
            "失败只补跑失败步骤，不回退已通过步骤。",
        ],
    }
    if create:
        workflow_dir.mkdir(parents=True, exist_ok=True)
        Path(files["manifest"]).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return payload


def _chapter_title(outline_text: str, chapter: int) -> str:
    for raw_line in outline_text.splitlines():
        line = raw_line.strip().lstrip("#").strip()
        match = TITLE_RE.search(line)
        if match and int(match.group("chapter")) == int(chapter):
            title = match.group("title").strip()
            if title:
                return title
    return f"第{int(chapter):02d}章"


def _first_non_empty(items: list[str], fallback: str = "") -> str:
    for item in items:
        item = str(item or "").strip()
        if item:
            return item
    return fallback


def _as_issue_list(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            normalized.append(dict(item))
        else:
            normalized.append({"description": str(item), "severity": "low", "category": "general"})
    return normalized


def normalize_reviewer_output(review_result: ReviewerResult) -> ReviewerResult:
    """Normalize reviewer-agent JSON into commit-friendly blockers/warnings."""
    normalized = dict(review_result or {})
    issues = _as_issue_list(normalized.get("issues"))
    blockers = _as_issue_list(normalized.get("blockers"))
    warnings = _as_issue_list(normalized.get("warnings"))

    if issues and not blockers and not warnings:
        for issue in issues:
            severity = str(issue.get("severity") or "").lower()
            is_blocking = bool(issue.get("blocking")) or severity in {"critical", "blocker"}
            target = blockers if is_blocking else warnings
            target.append(issue)
    elif issues:
        known = {
            json.dumps(item, ensure_ascii=False, sort_keys=True)
            for item in blockers + warnings
        }
        for issue in issues:
            key = json.dumps(issue, ensure_ascii=False, sort_keys=True)
            if key in known:
                continue
            severity = str(issue.get("severity") or "").lower()
            is_blocking = bool(issue.get("blocking")) or severity in {"critical", "blocker"}
            (blockers if is_blocking else warnings).append(issue)

    normalized["issues"] = issues or blockers + warnings
    normalized["blockers"] = blockers
    normalized["warnings"] = warnings
    normalized["blocker_count"] = int(normalized.get("blocker_count") or len(blockers))
    normalized["issue_count"] = int(
        normalized.get("issue_count")
        or len(normalized["issues"])
        or normalized["blocker_count"] + len(warnings)
    )
    normalized["passed"] = bool(
        normalized.get("passed", normalized["blocker_count"] == 0)
    ) and normalized["blocker_count"] == 0
    return normalized


def build_writing_brief(project_root: str | Path, chapter: int) -> dict[str, Any]:
    """Build a context-agent compatible writing brief for one chapter."""
    config = StoryCraftConfig.from_project_root(project_root)
    validation = validate_prewrite(config.project_root, chapter)
    context = ContextManager(config).build_context(chapter)
    core = context.get("core", {})
    scene = context.get("scene", {})
    continuity = context.get("continuity", {})
    guidance = context.get("guidance", {})
    outline_text = str(core.get("chapter_outline") or "")
    title = _chapter_title(outline_text, chapter)
    target_words = first_int(outline_value(outline_text, "预计字数"))

    goal = _first_non_empty(
        [outline_value(outline_text, "本章目标"), str(core.get("chapter_goal") or "")],
        "围绕本章大纲推进主线。",
    )
    resistance = _first_non_empty(
        [outline_value(outline_text, "核心冲突")],
        "主角行动遭遇新的信息阻力。",
    )
    foreshadowing = outline_value(outline_text, "伏笔计划")
    must_accomplish = list(core.get("must_cover") or [])
    if goal and goal not in must_accomplish:
        must_accomplish.insert(0, goal)
    if foreshadowing:
        must_accomplish.append(f"处理伏笔计划：{foreshadowing}")

    world_forbidden = []
    for rule in continuity.get("world_rules", [])[:5]:
        rule_text = rule.get("rule") if isinstance(rule, dict) else rule
        world_forbidden.append(f"遵守世界规则：{compact_line(rule_text)}")
    active_characters = []
    for item in scene.get("active_characters", []) or []:
        if not isinstance(item, dict):
            continue
        active_characters.append(
            {
                "id": item.get("id") or item.get("name"),
                "name": item.get("name") or item.get("id"),
                "role": item.get("role", ""),
                "motivation": item.get("current_status") or "根据近期剧情谨慎推断",
                "emotional_state": item.get("emotional_state") or "",
                "inferred": not bool(item.get("emotional_state")),
            }
        )

    urgent = continuity.get("unresolved_foreshadowing", []) or []
    must_handle = [
        item
        for item in urgent
        if isinstance(item, dict) and item.get("urgency") == "high"
    ][:3]
    continuity_checks = list(validation.get("warnings") or [])
    if not outline_text:
        continuity_checks.append("总纲未覆盖本章，任务书只能使用通用目标。")
    if not scene.get("location"):
        continuity_checks.append("缺少明确地点，起草时需要先选择与大纲一致的场景。")

    anti_ai_reminders = [
        item.get("instruction", str(item))
        for item in guidance.get("anti_ai_checklist", build_anti_ai_checklist())
    ]
    hook_type = outline_value(outline_text, "章末钩子类型")
    return {
        "ok": bool(validation.get("ready")),
        "prewrite": validation,
        "meta": {
            "chapter": int(chapter),
            "title": title,
            "word_count_target": target_words,
        },
        "core_mission": {
            "goal": goal,
            "resistance": resistance,
            "cost": "解决冲突必须付出可见代价，不能无成本推进。",
            "conflict_one_line": f"{goal}；阻力是{resistance}",
            "must_accomplish": must_accomplish or [goal],
            "absolutely_forbidden": list(core.get("forbidden") or []) + world_forbidden,
            "chapter_arc": outline_value(outline_text, "所属段落"),
        },
        "scene_and_characters": {
            "time_constraint": scene.get("time_constraint") or {},
            "location": {
                "value": scene.get("location") or "",
                "missing": not bool(scene.get("location")),
            },
            "active_characters": active_characters,
            "new_characters_introduced": [],
        },
        "continuity": {
            "last_chapter_hook": continuity.get("last_chapter_hook") or "",
            "reader_expectation": "回应上一章钩子，并让本章结尾产生新的阅读动力。",
            "opening_suggestion": "前300字内给出行动、异常、冲突或悬念之一。",
            "unresolved_foreshadowing": {
                "must_handle": must_handle,
                "open_items": urgent,
            },
            "continuity_checks": continuity_checks,
        },
        "writing_guidance": {
            "style_notes": guidance.get("style_notes") or [],
            "learning_applied": guidance.get("learning_patterns") or [],
            "anti_ai_reminders": anti_ai_reminders,
            "hook_strategy": {
                "type": hook_type,
                "instruction": "章末必须留下选择、情绪落点或下一步问题。",
            },
        },
    }


def build_repair_plan(
    project_root: str | Path,
    chapter: int,
    review_result: ReviewerResult,
    draft_file: Optional[str | Path] = None,
) -> dict[str, Any]:
    """Build a reviewer retry and repair plan without changing chapter text."""
    config = StoryCraftConfig.from_project_root(project_root)
    normalized = normalize_reviewer_output(review_result)
    placeholders = []
    if draft_file:
        text = Path(draft_file).expanduser().resolve().read_text(encoding="utf-8")
        placeholders = scan_placeholders(text)

    blockers = normalized.get("blockers", [])
    warnings = normalized.get("warnings", [])
    return {
        "ok": True,
        "chapter": int(chapter),
        "retry_required": bool(blockers or placeholders),
        "can_commit": not blockers and not placeholders,
        "blocker_actions": [
            {
                "category": item.get("category", "general"),
                "location": item.get("location", ""),
                "evidence": item.get("evidence", ""),
                "instruction": item.get("fix_hint") or item.get("description") or "修复阻断问题",
            }
            for item in blockers
        ],
        "warning_actions": [
            {
                "category": item.get("category", "general"),
                "location": item.get("location", ""),
                "instruction": item.get("fix_hint") or item.get("description") or "润色时处理",
            }
            for item in warnings
        ],
        "placeholder_actions": placeholders,
        "next_step": "重新起草并再次调用 reviewer" if blockers or placeholders else "进入润色或提交",
        "project_root": str(config.project_root),
    }


def build_polish_plan(
    project_root: str | Path,
    chapter: int,
    draft_file: str | Path,
    review_result: Optional[ReviewerResult] = None,
) -> dict[str, Any]:
    """Build a fact-preserving polish plan for a draft."""
    config = StoryCraftConfig.from_project_root(project_root)
    draft_path = Path(draft_file).expanduser().resolve()
    text = draft_path.read_text(encoding="utf-8")
    style_sample = extract_style_sample(text, chapter)
    normalized = normalize_reviewer_output(review_result or {})
    polish_issues = [
        item
        for item in normalized.get("warnings", [])
        if item.get("category") in {"ai_flavor", "pacing", "dialogue", "format"}
    ]
    actions = [
        {
            "category": item.get("category", "style"),
            "location": item.get("location", ""),
            "instruction": item.get("fix_hint") or item.get("description") or "降低 AI 味",
        }
        for item in polish_issues
    ]
    for item in build_anti_ai_checklist():
        actions.append(
            {
                "category": item["category"],
                "location": "全文",
                "instruction": item["instruction"],
            }
        )
    return {
        "ok": True,
        "chapter": int(chapter),
        "draft_file": str(draft_path),
        "style_sample": style_sample,
        "actions": actions,
        "red_lines": [
            "不改变已发生事实",
            "不新增未授权设定",
            "不改动大纲约束下的关键因果",
            "不把阻断问题当作单纯润色处理",
        ],
        "output_expectation": "输出润色后的完整正文，并附简短润色报告。",
        "project_root": str(config.project_root),
    }


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in CHINESE_SENTENCE_RE.findall(text or "") if item.strip()]


def _infer_chapter_heading(text: str, chapter: int, fallback_title: str = "") -> str:
    first_line = ""
    for raw_line in text.splitlines():
        line = raw_line.strip().lstrip("#").strip()
        if not line:
            continue
        if not first_line:
            first_line = line
        match = TITLE_RE.search(line)
        if match and int(match.group("chapter")) == int(chapter):
            return match.group("title").strip() or fallback_title or f"第{int(chapter):02d}章"
    if fallback_title:
        return fallback_title
    if first_line:
        return first_line[:30]
    return fallback_title or f"第{int(chapter):02d}章"


def build_extraction_delta(
    project_root: str | Path,
    chapter: int,
    chapter_file: str | Path,
    title: str = "",
) -> ExtractionDelta:
    """Build a data-agent compatible fallback delta from committed text."""
    config = StoryCraftConfig.from_project_root(project_root)
    path = Path(chapter_file).expanduser().resolve()
    text = path.read_text(encoding="utf-8")
    memory = MemoryManager(config).load()
    inferred_title = title or _infer_chapter_heading(text, chapter)
    sentences = _sentences(text)
    key_events = [compact_line(sentence, 80) for sentence in sentences[:3]]
    entities_appeared = []
    for char in memory.get("characters", []):
        char_id = char.get("id") or char.get("name")
        name = str(char.get("name") or "")
        if char_id and name and name in text:
            entities_appeared.append(str(char_id))
    if not entities_appeared:
        context = ContextManager(config).build_context(chapter)
        for item in context.get("scene", {}).get("active_characters", []) or []:
            if isinstance(item, dict) and (item.get("id") or item.get("name")):
                entities_appeared.append(str(item.get("id") or item.get("name")))

    summary = "；".join(key_events) or compact_line(text, 120)
    word_count = count_chinese_chars(text)
    return {
        "chapter": int(chapter),
        "title": inferred_title,
        "entities_new": [],
        "entities_appeared": entities_appeared,
        "state_changes": [],
        "new_foreshadowing": [],
        "resolved_foreshadowing": [],
        "new_world_rules": [],
        "timeline_entry": {
            "chapter": int(chapter),
            "time_marker": "",
            "events": key_events or [summary],
            "time_elapsed": "",
            "time_delta": "",
            "source": "agent-workflow-fallback",
        },
        "scenes": [
            {
                "index": 1,
                "start_line": 1,
                "end_line": max(1, len(text.splitlines())),
                "location": "",
                "summary": summary,
                "characters": entities_appeared,
                "tone": "",
            }
        ],
        "chapter_summary": {
            "chapter": int(chapter),
            "title": inferred_title,
            "summary": summary,
            "word_count": word_count,
            "key_events": key_events,
            "characters_appeared": entities_appeared,
            "hook_type": "",
            "hook_strength": "",
        },
        "agent_calls": {
            "data": "agent-workflow-fallback",
        },
    }
