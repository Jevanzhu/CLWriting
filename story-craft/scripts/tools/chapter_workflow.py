#!/usr/bin/env python3
"""Chapter write workflow helpers for story-craft."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from core.chapter_paths import (
    chapter_file_name,
    chapter_record_file_name,
    commit_file_name,
    summary_file_name,
)
from core.chapter_record import ChapterRecordService
from core.config import StoryCraftConfig
from core.security_utils import AtomicWriteError, atomic_write_text, sanitize_filename
from core.context_manager import ContextManager
from core.text_utils import (
    build_heuristic_summary,
    compact_line,
    count_chinese_chars,
    first_int,
    outline_value,
    split_paragraph_chunks,
)
from core.types import ExtractionDelta, WriteGateFailure, WriteGateStage, WriteResult
from tools.agent_workflow import normalize_reviewer_output
from tools.deslop_metrics import markdown_residue
from tools.placeholder_scanner import scan_placeholders
from tools.style_sampler import extract_style_sample
from tools.prewrite_validator import validate_prewrite
from tools.review_pipeline import build_review_report


WORD_COUNT_BLOCK_RATIO = 0.6
WORD_COUNT_WARNING_RATIO = 0.8
WORD_COUNT_OVER_RATIO = 1.35


def _read_json(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise FileNotFoundError(f"文件不存在：{p}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败（{p}）：{exc}")


def _infer_title(chapter_text: str, chapter: int, fallback: str = "") -> str:
    for raw_line in chapter_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            title = line.lstrip("#").strip()
            if re.match(rf"^第0?{int(chapter)}章(?:[：:\-\s]|$)", title):
                title = re.sub(rf"^第0?{int(chapter)}章[：:\-\s]*", "", title).strip()
                if title:
                    return title
                return f"第{int(chapter):02d}章"
    return fallback or f"第{int(chapter):02d}章"


def _planned_word_count(context: dict[str, Any]) -> int:
    planned_word_count = context.get("core", {}).get("planned_word_count")
    if planned_word_count:
        return int(planned_word_count)
    chapter_outline = str(context.get("core", {}).get("chapter_outline") or "")
    return first_int(outline_value(chapter_outline, "预计字数"))


def _build_word_count_check(
    *,
    actual_words: int,
    planned_words: int,
) -> dict[str, Any]:
    """Build a submit-time word-count gate from the chapter plan."""
    if planned_words <= 0:
        return {
            "planned_words": 0,
            "actual_words": int(actual_words),
            "ratio": None,
            "minimum_words": 0,
            "recommended_min_words": 0,
            "recommended_max_words": 0,
            "blockers": [],
            "warnings": [],
        }

    minimum_words = round(planned_words * WORD_COUNT_BLOCK_RATIO)
    recommended_min_words = round(planned_words * WORD_COUNT_WARNING_RATIO)
    recommended_max_words = round(planned_words * WORD_COUNT_OVER_RATIO)
    ratio = round(actual_words / planned_words, 4)
    blockers: list[str] = []
    warnings: list[str] = []
    if actual_words < minimum_words:
        blockers.append(
            "正文字数过低："
            f"实际 {actual_words} 字，计划 {planned_words} 字，"
            f"低于最低提交阈值 {minimum_words} 字（{int(WORD_COUNT_BLOCK_RATIO * 100)}%）。"
        )
    elif actual_words < recommended_min_words:
        warnings.append(
            "正文字数偏低："
            f"实际 {actual_words} 字，计划 {planned_words} 字，"
            f"建议至少 {recommended_min_words} 字（{int(WORD_COUNT_WARNING_RATIO * 100)}%）。"
        )
    elif actual_words > recommended_max_words:
        warnings.append(
            "正文字数偏高："
            f"实际 {actual_words} 字，计划 {planned_words} 字，"
            f"已超过建议上限 {recommended_max_words} 字。"
        )

    return {
        "planned_words": int(planned_words),
        "actual_words": int(actual_words),
        "ratio": ratio,
        "minimum_words": int(minimum_words),
        "recommended_min_words": int(recommended_min_words),
        "recommended_max_words": int(recommended_max_words),
        "blockers": blockers,
        "warnings": warnings,
    }


def _build_markdown_residue_blockers(metric: dict[str, Any]) -> list[str]:
    """Build blockers for publish-ready prose Markdown residue."""
    if float(metric.get("value") or 0) <= 0:
        return []
    evidence = metric.get("evidence") or []
    detail = "；".join(str(item) for item in evidence[:5] if item)
    suffix = f"命中：{detail}" if detail else "请移除 #、**、列表、引用、链接或代码等标记。"
    return [f"正文存在 Markdown 残留，不符合正文即成品规范；{suffix}"]


def _default_extraction_delta(
    *,
    chapter: int,
    title: str,
    chapter_text: str,
    context: dict[str, Any],
    word_count: int,
    review_source: str,
) -> ExtractionDelta:
    """Build the write command's minimal consumable delta fallback."""
    core = context.get("core", {})
    chapter_outline = str(core.get("chapter_outline") or "")
    summary = _fallback_summary(chapter_text, chapter_outline, title)
    if not summary:
        summary = title
    characters = _fallback_appeared_characters(chapter_text, context)
    new_entities = _fallback_entity_candidates(chapter_text, context)
    key_events = _fallback_key_events(chapter_text, summary)
    timeline_entry = {
        "chapter": int(chapter),
        "events": key_events or [summary],
        "source": "story-write",
    }
    chapter_summary = {
        "chapter": int(chapter),
        "title": title,
        "summary": summary,
        "word_count": int(word_count),
        "key_events": key_events,
        "characters_appeared": characters,
    }
    scenes = _fallback_scenes(
        chapter_text,
        chapter=chapter,
        title=title,
        summary=summary,
        characters=characters,
    )
    accepted_events = _fallback_accepted_events(
        chapter=chapter,
        characters=characters,
        entities_new=new_entities,
        timeline_entry=timeline_entry,
        chapter_summary=chapter_summary,
    )
    return {
        "chapter": int(chapter),
        "title": title,
        "entities_new": new_entities,
        "entities_appeared": characters,
        "accepted_events": accepted_events,
        "dominant_strand": "quest",
        "timeline_entry": timeline_entry,
        "chapter_summary": chapter_summary,
        "scenes": scenes,
        "agent_calls": {
            "context": "cli",
            "review": review_source,
            "data": "fallback",
        },
    }


def _fallback_summary(chapter_text: str, chapter_outline: str, title: str) -> str:
    outline_first = chapter_outline.splitlines()[0].strip() if chapter_outline else ""
    summary = build_heuristic_summary(chapter_text, outline_hint=outline_first, max_length=120)
    return summary or title


def _fallback_key_events(chapter_text: str, summary: str) -> list[str]:
    parts = [
        compact_line(part, max_length=80)
        for part in re.split(r"[。！？!?；;\n]+", chapter_text)
    ]
    events = [part for part in parts if part and not part.startswith("#")]
    return events[:3] or ([summary] if summary else [])


# 段落级 chunk 的最小字数：过短的自然段并入前一段，避免碎片化降低召回质量。
_SCENE_MIN_CHARS = 80
# 单个段落 embedding_text 的字数上限：极长段落截断，避免向量被稀释。
_SCENE_MAX_CHARS = 600


def _fallback_scenes(
    chapter_text: str,
    *,
    chapter: int,
    title: str,
    summary: str,
    characters: list[str],
) -> list[dict[str, Any]]:
    """把章节正文按自然段切成段落级 scene，让向量检索覆盖全文而非仅前几句。

    每个 scene 即一个 chunk：embedding_text 为段落原文（带章节标题前缀助章节级召回），
    start_line/end_line 指向正文行范围。切分逻辑见 text_utils.split_paragraph_chunks。
    """
    paragraphs = split_paragraph_chunks(chapter_text, min_chars=_SCENE_MIN_CHARS)
    if not paragraphs:
        fallback_text = compact_line(chapter_text, max_length=_SCENE_MAX_CHARS) or summary
        paragraphs = [
            {"start_line": 1, "end_line": max(1, len(chapter_text.splitlines())), "text": fallback_text}
        ]

    scenes: list[dict[str, Any]] = []
    for index, para in enumerate(paragraphs, start=1):
        para_text = str(para["text"])
        scenes.append(
            {
                "index": index,
                "start_line": int(para["start_line"]),
                "end_line": int(para["end_line"]),
                "summary": compact_line(para_text, max_length=60),
                "characters": characters,
                "strand": "quest",
                "embedding_text": compact_line(
                    f"第{int(chapter):03d}章 {title} {para_text}",
                    max_length=_SCENE_MAX_CHARS,
                ),
            }
        )
    return scenes


def _fallback_appeared_characters(
    chapter_text: str,
    context: dict[str, Any],
) -> list[str]:
    characters: list[str] = []
    for item in context.get("scene", {}).get("active_characters", []) or []:
        if not isinstance(item, dict):
            continue
        identifier = item.get("id") or item.get("name")
        name = str(item.get("name") or "")
        if identifier and (not name or name in chapter_text):
            value = str(identifier)
            if value not in characters:
                characters.append(value)
    return characters


def _fallback_entity_candidates(
    chapter_text: str,
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    known_names = {
        str(item.get("name"))
        for item in context.get("scene", {}).get("active_characters", []) or []
        if isinstance(item, dict) and item.get("name")
    }
    stop_words = {
        "第一章",
        "第二章",
        "第三章",
        "本章",
        "这里",
        "那里",
        "雨水",
        "邮戳",
        "档案",
        "证词",
        "线索",
        "旧楼",
    }
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in re.finditer(
        r"([\u4e00-\u9fff]{2,3})(?=说|问|看|站|走|跑|推|拿|收|回|想|把|将|听|抬|低|转|翻|查|盯|笑|哭|喊)",
        chapter_text,
    ):
        name = match.group(1)
        if name in known_names or name in stop_words or name in seen:
            continue
        seen.add(name)
        candidates.append(
            {
                "id": f"ent_auto_{len(candidates) + 1:03d}",
                "name": name,
                "entity_type": "角色",
                "role": "待确认",
                "source": "story-write-fallback",
            }
        )
        if len(candidates) >= 5:
            break
    return candidates


def _fallback_accepted_events(
    *,
    chapter: int,
    characters: list[str],
    entities_new: list[dict[str, Any]],
    timeline_entry: dict[str, Any],
    chapter_summary: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for entity in entities_new:
        events.append(
            {
                "event_type": "entity_introduced",
                "entity_id": str(entity.get("id") or entity.get("name") or ""),
                "entity_type": str(entity.get("entity_type") or "角色"),
                "payload": entity,
                "chapter": int(chapter),
                "source": "story-write-fallback",
                "strand": "quest",
            }
        )
    for identifier in characters:
        events.append(
            {
                "event_type": "entity_appeared",
                "entity_id": identifier,
                "entity_type": "角色",
                "payload": {"id": identifier},
                "chapter": int(chapter),
                "source": "story-write-fallback",
                "strand": "quest",
            }
        )
    events.append(
        {
            "event_type": "timeline_advanced",
            "payload": timeline_entry,
            "chapter": int(chapter),
            "source": "story-write-fallback",
            "strand": "quest",
        }
    )
    events.append(
        {
            "event_type": "summary_recorded",
            "payload": chapter_summary,
            "chapter": int(chapter),
            "source": "story-write-fallback",
            "strand": "quest",
        }
    )
    return events


def _normalize_delta_chapter(
    delta: ExtractionDelta,
    *,
    chapter: int,
) -> tuple[ExtractionDelta, list[str], list[str]]:
    normalized: ExtractionDelta = dict(delta)
    errors: list[str] = []
    warnings: list[str] = []

    def normalize_field(container: dict[str, Any], field_path: str) -> None:
        raw = container.get("chapter")
        if raw in (None, ""):
            container["chapter"] = int(chapter)
            warnings.append(f"{field_path}.chapter 缺失，已补齐为 {int(chapter)}")
            return
        try:
            value = int(raw)
        except (TypeError, ValueError):
            errors.append(f"{field_path}.chapter 不是有效章节号：{raw!r}")
            return
        if value != int(chapter):
            errors.append(
                f"{field_path}.chapter={value} 与目标章节 {int(chapter)} 不一致"
            )
            return
        container["chapter"] = value

    normalize_field(normalized, "delta")
    for key in ("timeline_entry", "chapter_summary"):
        item = normalized.get(key)
        if item is None:
            continue
        if not isinstance(item, dict):
            errors.append(f"delta.{key} 必须是对象")
            continue
        nested = dict(item)
        normalize_field(nested, f"delta.{key}")
        normalized[key] = nested

    return normalized, errors, warnings


def _failure_result(
    *,
    stage: WriteGateStage,
    blockers: list[str],
    warnings: list[str],
    draft_path: Path,
    chapter_file: str | Path | None = None,
    report_file: str | Path | None = None,
    record_file: str | Path | None = None,
    word_count_check: dict[str, Any] | None = None,
    **extra: Any,
) -> WriteGateFailure:
    result: WriteGateFailure = {
        "ok": False,
        "stage": stage,
        "blockers": list(blockers),
        "warnings": list(warnings),
        "chapter_file": str(chapter_file) if chapter_file else None,
        "report_file": str(report_file) if report_file else None,
        "record_file": str(record_file) if record_file else None,
        "draft_file": str(draft_path),
    }
    if word_count_check is not None:
        result["word_count_check"] = word_count_check
    result.update(extra)
    return result


def _snapshot_files(paths: list[Path]) -> dict[Path, bytes | None]:
    snapshots: dict[Path, bytes | None] = {}
    for path in paths:
        if path not in snapshots:
            snapshots[path] = path.read_bytes() if path.exists() else None
    return snapshots


def _restore_snapshots(snapshots: dict[Path, bytes | None]) -> list[str]:
    errors: list[str] = []
    for path, data in snapshots.items():
        try:
            if data is None:
                if path.exists():
                    path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        except OSError as exc:
            errors.append(f"{path}: {exc}")
    return errors


def build_chapter_brief(project_root: str | Path, chapter: int) -> dict[str, Any]:
    """Build prewrite validation and context for a target chapter."""
    project = Path(project_root).expanduser().resolve()
    validation = validate_prewrite(project, chapter)
    context = ContextManager.from_project(project).build_context(chapter)
    return {
        "ready": validation["ready"],
        "blockers": validation["blockers"],
        "warnings": validation["warnings"],
        "context": context,
    }


def record_chapter_workflow(
    project_root: str | Path,
    *,
    chapter: int,
    draft_file: str | Path,
    review_results: Optional[str | Path] = None,
    extraction_delta: Optional[str | Path] = None,
    title: str = "",
    output_file: Optional[str | Path] = None,
    report_file: Optional[str | Path] = None,
    allow_warnings: bool = True,
    require_review: bool = False,
) -> WriteResult:
    """Validate, persist, review-report, and record a chapter draft."""
    config = StoryCraftConfig.from_project_root(project_root)
    config.ensure_dirs()
    draft_path = Path(draft_file).expanduser().resolve()
    review_status = "provided" if review_results else "skipped"
    validation = validate_prewrite(config.project_root, chapter)
    if not validation["ready"]:
        return _failure_result(
            stage="prewrite",
            blockers=validation["blockers"],
            warnings=validation["warnings"],
            draft_path=draft_path,
            review_status=review_status,
        )

    chapter_text = draft_path.read_text(encoding="utf-8")
    placeholders = scan_placeholders(chapter_text)
    if placeholders:
        return _failure_result(
            stage="placeholder",
            blockers=["正文存在占位符"],
            warnings=validation["warnings"],
            draft_path=draft_path,
            placeholders=placeholders,
            review_status=review_status,
        )

    residue_metric = markdown_residue(chapter_text)
    markdown_blockers = _build_markdown_residue_blockers(residue_metric)
    if markdown_blockers:
        return _failure_result(
            stage="markdown",
            blockers=markdown_blockers,
            warnings=validation["warnings"],
            draft_path=draft_path,
            markdown_residue=residue_metric,
            review_status=review_status,
        )

    context = ContextManager(config).build_context(chapter)
    word_count = count_chinese_chars(chapter_text)
    word_count_check = _build_word_count_check(
        actual_words=word_count,
        planned_words=_planned_word_count(context),
    )
    all_warnings = list(validation["warnings"]) + word_count_check["warnings"]
    if word_count_check["blockers"]:
        return _failure_result(
            stage="word_count",
            blockers=word_count_check["blockers"],
            warnings=all_warnings,
            draft_path=draft_path,
            word_count_check=word_count_check,
            review_status=review_status,
        )

    context_title = str(context.get("core", {}).get("chapter_title") or "")
    inferred_title = _infer_title(chapter_text, chapter, fallback=title or context_title)
    chapter_title = title or inferred_title
    chapter_path = (
        Path(output_file).expanduser().resolve()
        if output_file
        else config.project_chapters_dir
        / chapter_file_name(chapter, chapter_title, pad_width=config.chapter_pad_width)
    )

    if not allow_warnings and all_warnings:
        return _failure_result(
            stage="warnings",
            blockers=["写前校验存在警告，当前设置不允许继续"],
            warnings=all_warnings,
            draft_path=draft_path,
            word_count_check=word_count_check,
            review_status=review_status,
        )

    if require_review and not review_results:
        return _failure_result(
            stage="prewrite",
            blockers=["未提供 reviewer 结果，且已开启 --require-review"],
            warnings=all_warnings,
            draft_path=draft_path,
            word_count_check=word_count_check,
            review_status=review_status,
        )

    review_source = "provided" if review_results else "fallback"
    if review_results:
        review_result = normalize_reviewer_output(_read_json(review_results))
    else:
        review_result = normalize_reviewer_output(
            {
                "issues": [
                    {
                        "severity": "low",
                        "category": "format",
                        "location": "reviewer 结果",
                        "description": "未提供 reviewer 结果，已执行本地占位符和字数检查。",
                        "evidence": "review_results 参数为空",
                        "fix_hint": "正式验收前补充 reviewer JSON，或确认本地轻量检查足够。",
                        "blocking": False,
                    }
                ],
                "summary": "未提供 reviewer 结果，使用本地轻量检查兜底。",
            }
        )
    review_meta = dict(review_result.get("meta") or {})
    review_meta["source"] = "agent" if review_results else "fallback"
    review_result["meta"] = review_meta
    if extraction_delta:
        delta: ExtractionDelta = _read_json(extraction_delta)  # type: ignore[assignment]
    else:
        delta = _default_extraction_delta(
            chapter=chapter,
            title=chapter_title,
            chapter_text=chapter_text,
            context=context,
            word_count=word_count,
            review_source=review_source,
        )
    delta, delta_errors, delta_warnings = _normalize_delta_chapter(delta, chapter=chapter)
    all_warnings.extend(delta_warnings)
    if delta_errors:
        return _failure_result(
            stage="delta_validation",
            blockers=delta_errors,
            warnings=all_warnings,
            draft_path=draft_path,
            word_count_check=word_count_check,
            review_status=review_status,
        )

    report_path = (
        Path(report_file).expanduser().resolve()
        if report_file
        else config.review_dir / f"第{int(chapter):02d}章审查报告.md"
    )
    record_path = config.chapters_dir / chapter_record_file_name(
        chapter,
        pad_width=config.chapter_pad_width,
    )
    snapshots = _snapshot_files(
        [
            report_path,
            chapter_path,
            record_path,
            *_projection_snapshot_paths(config, chapter, delta),
            config.memory_file,
            config.state_file,
        ]
    )
    chapter_file = None
    try:
        atomic_write_text(
            report_path,
            build_review_report(chapter, review_result, chapter_text),
            backup=True,
        )

        record_result = ChapterRecordService(config).record(
            chapter,
            chapter_title,
            word_count,
            review_result,
            delta,
            style_sample=extract_style_sample(chapter_text, chapter),
        )

        if record_result["status"] == "accepted":
            atomic_write_text(chapter_path, chapter_text, backup=True)
            chapter_file = str(chapter_path)
    except (AtomicWriteError, OSError, ValueError) as exc:
        rollback_errors = _restore_snapshots(snapshots)
        blockers = [f"正式写入失败：{exc}"]
        if rollback_errors:
            blockers.append("回滚失败：" + "；".join(rollback_errors))
        return _failure_result(
            stage="write_error",
            blockers=blockers,
            warnings=all_warnings,
            draft_path=draft_path,
            word_count_check=word_count_check,
            chapter=int(chapter),
            title=chapter_title,
            word_count=word_count,
            status="failed",
            memory_updated=False,
            state_updated=False,
            review_status=review_status,
        )
    return {
        "ok": record_result["status"] == "accepted",
        "stage": "record",
        "review_status": review_status,
        "chapter": int(chapter),
        "title": chapter_title,
        "word_count": word_count,
        "chapter_file": chapter_file,
        "report_file": str(report_path),
        "record_file": record_result["record_file"],
        "status": record_result["status"],
        "memory_updated": record_result["memory_updated"],
        "state_updated": record_result["state_updated"],
        "warnings": all_warnings,
        "word_count_check": word_count_check,
        "commit_file": record_result.get("commit_file"),
        "projections": record_result.get("projections", {}),
    }


def commit_chapter_workflow(*args: Any, **kwargs: Any) -> WriteResult:
    """Backward-compatible alias for older internal callers."""
    return record_chapter_workflow(*args, **kwargs)


def _projection_snapshot_paths(
    config: StoryCraftConfig,
    chapter: int,
    delta: ExtractionDelta,
) -> list[Path]:
    paths = [
        config.commits_dir / commit_file_name(chapter),
        config.summaries_dir / summary_file_name(chapter),
        config.index_db,
        config.vector_db,
        config.tracking_dir / "上下文.md",
        config.tracking_dir / "伏笔.md",
        config.tracking_dir / "时间线.md",
        config.tracking_dir / "角色状态.md",
    ]
    for identifier in _projected_entity_names(delta):
        paths.append(config.settings_view_dir / "角色" / f"{sanitize_filename(identifier)}.md")
    for rule in delta.get("new_world_rules", []) or []:
        if not isinstance(rule, dict):
            continue
        title = str(rule.get("id") or rule.get("title") or "")
        if title:
            paths.append(config.settings_view_dir / "世界观" / f"{sanitize_filename(title)}.md")
    return paths


def _projected_entity_names(delta: ExtractionDelta) -> list[str]:
    names: list[str] = []

    def add(value: Any) -> None:
        text = str(value or "")
        if text and text not in names:
            names.append(text)

    for entity in delta.get("entities_new", []) or []:
        if isinstance(entity, dict):
            add(entity.get("name") or entity.get("id") or entity.get("suggested_id"))
    for entity in delta.get("entities_appeared", []) or []:
        if isinstance(entity, dict):
            add(entity.get("name") or entity.get("id") or entity.get("suggested_id"))
        else:
            add(entity)
    for event in delta.get("accepted_events", []) or []:
        if event.get("event_type") in {"entity_introduced", "entity_appeared", "state_changed"}:
            payload = event.get("payload") or {}
            add(payload.get("name") or event.get("entity_id"))
    return names
