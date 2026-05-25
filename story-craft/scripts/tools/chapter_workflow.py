#!/usr/bin/env python3
"""Chapter write workflow helpers for story-craft."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from core.chapter_paths import chapter_file_name, chapter_record_file_name
from core.chapter_record import ChapterRecordService
from core.config import StoryCraftConfig
from core.security_utils import AtomicWriteError, atomic_write_text
from core.context_manager import ContextManager
from core.text_utils import count_chinese_chars, first_int, outline_value
from core.types import ExtractionDelta, WriteResult
from tools.agent_workflow import normalize_reviewer_output
from tools.placeholder_scanner import scan_placeholders
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
    summary = chapter_outline.splitlines()[0].strip() if chapter_outline else ""
    if not summary:
        summary = chapter_text.strip().splitlines()[0][:80] if chapter_text.strip() else title
    characters = []
    for item in context.get("scene", {}).get("active_characters", []) or []:
        if isinstance(item, dict):
            identifier = item.get("id") or item.get("name")
            if identifier:
                characters.append(str(identifier))
    return {
        "chapter": int(chapter),
        "entities_appeared": characters,
        "timeline_entry": {
            "chapter": int(chapter),
            "events": [summary],
            "source": "story-write",
        },
        "chapter_summary": {
            "chapter": int(chapter),
            "title": title,
            "summary": summary,
            "word_count": int(word_count),
        },
        "scenes": [],
        "agent_calls": {
            "context": "cli",
            "review": review_source,
            "data": "fallback",
        },
    }


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
    stage: str,
    blockers: list[str],
    warnings: list[str],
    draft_path: Path,
    chapter_file: str | Path | None = None,
    report_file: str | Path | None = None,
    record_file: str | Path | None = None,
    word_count_check: dict[str, Any] | None = None,
    **extra: Any,
) -> WriteResult:
    result: WriteResult = {
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
) -> WriteResult:
    """Validate, persist, review-report, and record a chapter draft."""
    config = StoryCraftConfig.from_project_root(project_root)
    config.ensure_dirs()
    draft_path = Path(draft_file).expanduser().resolve()
    validation = validate_prewrite(config.project_root, chapter)
    if not validation["ready"]:
        return _failure_result(
            stage="prewrite",
            blockers=validation["blockers"],
            warnings=validation["warnings"],
            draft_path=draft_path,
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
        )

    inferred_title = _infer_title(chapter_text, chapter, fallback=title)
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
        )
    return {
        "ok": record_result["status"] == "accepted",
        "stage": "record",
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
    }


def commit_chapter_workflow(*args: Any, **kwargs: Any) -> WriteResult:
    """Backward-compatible alias for older internal callers."""
    return record_chapter_workflow(*args, **kwargs)
