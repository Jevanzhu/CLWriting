#!/usr/bin/env python3
"""Chapter acceptance record service."""

from __future__ import annotations

from copy import deepcopy
import logging
from pathlib import Path
from typing import Any, Optional

from core.chapter_commit_builder import build_chapter_commit
from core.chapter_paths import chapter_record_file_name
from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.event_projection_router import EventProjectionRouter
from core.projection.base import ProjectionResult
from core.projection_log import append_projection_run
from core.security_utils import atomic_write_json
from core.time_utils import now_utc_iso
from core.types import ExtractionDelta, NormalizedReviewerResult

logger = logging.getLogger("core.chapter_record")


class ChapterRecordService:
    """Persist chapter acceptance records and update state/memory.

    review_result must already be normalized by normalize_reviewer_output().
    The blockers list is authoritative.
    """

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    def record(
        self,
        chapter: int,
        title: str,
        word_count: int,
        review_result: NormalizedReviewerResult,
        extraction_delta: ExtractionDelta,
        style_sample: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = self._build_record_payload(
            chapter,
            title,
            word_count,
            review_result,
            extraction_delta,
            style_sample,
        )
        record_file = self._persist_record(payload)
        commit = build_chapter_commit(
            chapter=chapter,
            title=title,
            word_count=word_count,
            review_result=review_result,
            extraction_delta=extraction_delta,
        )
        commit_file = CommitStore(self.config).write(commit)
        projection_results = EventProjectionRouter(self.config).dispatch(commit)
        append_projection_run(
            self.config,
            chapter=int(chapter),
            commit_status=str(commit.get("status") or ""),
            results=projection_results,
            source="chapter-commit",
        )
        memory_updated = _projection_updated(projection_results.get("memory"))
        state_updated = _projection_updated(projection_results.get("state"))

        if payload["status"] == "accepted":
            logger.info("chapter %d '%s' accepted, %d words", chapter, title, word_count)
        else:
            logger.info(
                "chapter %d '%s' rejected, %d blockers",
                chapter,
                title,
                payload["review"]["blocker_count"],
            )

        return {
            "chapter": chapter,
            "title": title,
            "status": payload["status"],
            "record_file": str(record_file),
            "commit_file": str(commit_file),
            "projections": _projection_payload(projection_results),
            "memory_updated": memory_updated,
            "state_updated": state_updated,
        }

    def _build_record_payload(
        self,
        chapter: int,
        title: str,
        word_count: int,
        review_result: NormalizedReviewerResult,
        extraction_delta: ExtractionDelta,
        style_sample: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._ensure_normalized_review_result(review_result)
        blockers = review_result.get("blockers") or []
        warnings = review_result.get("warnings") or []
        issues = review_result["issues"]
        blocker_count = len(blockers)
        issue_count = len(issues)
        passed = blocker_count == 0
        status = "accepted" if passed else "rejected"
        delta = deepcopy(extraction_delta)
        delta.setdefault("chapter", int(chapter))
        return {
            "chapter": int(chapter),
            "title": title,
            "word_count": int(word_count),
            "written_at": now_utc_iso(),
            "status": status,
            "review": {
                "passed": passed,
                "blockers": blockers,
                "warnings": warnings,
                "issue_count": issue_count,
                "blocker_count": blocker_count,
            },
            "delta": delta,
            "scenes": extraction_delta.get("scenes", []),
            "agent_calls": extraction_delta.get("agent_calls", {}),
            "style_sample": style_sample or {},
        }

    def _ensure_normalized_review_result(self, review_result: dict[str, Any]) -> None:
        required = {"passed", "issues", "blockers", "warnings"}
        missing = sorted(required - set(review_result))
        if missing:
            raise ValueError(
                "review_result 必须先经过 normalize_reviewer_output()，缺少字段："
                + ", ".join(missing)
            )
        blockers = review_result.get("blockers") or []
        if bool(review_result.get("passed")) != (not blockers):
            raise ValueError("review_result.passed 与 blockers 列表冲突")

    def _persist_record(self, payload: dict[str, Any]) -> Path:
        self.config.chapters_dir.mkdir(parents=True, exist_ok=True)
        record_file = self.config.chapters_dir / chapter_record_file_name(
            payload["chapter"],
            pad_width=self.config.chapter_pad_width,
        )
        atomic_write_json(record_file, payload, use_lock=True, backup=True)
        return record_file


def _projection_updated(result: ProjectionResult | None) -> bool:
    return bool(result and result.ok and not result.skipped)


def _projection_payload(results: dict[str, ProjectionResult]) -> dict[str, dict[str, Any]]:
    return {
        name: {
            "ok": result.ok,
            "skipped": result.skipped,
            "detail": result.detail,
        }
        for name, result in results.items()
    }
