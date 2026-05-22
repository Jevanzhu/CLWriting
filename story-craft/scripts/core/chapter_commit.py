#!/usr/bin/env python3
"""Chapter commit service."""

from __future__ import annotations

from copy import deepcopy
import logging
from pathlib import Path
from typing import Any, Optional

from core.chapter_paths import chapter_commit_file_name
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import atomic_write_json
from core.state_manager import StateManager
from core.time_utils import now_utc_iso
from core.types import ExtractionDelta, NormalizedReviewerResult

logger = logging.getLogger("core.chapter_commit")


class ChapterCommitService:
    """Persist chapter commit payloads and update state/memory.

    review_result must already be normalized by normalize_reviewer_output().
    The blockers list is authoritative.
    """

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    def commit(
        self,
        chapter: int,
        title: str,
        word_count: int,
        review_result: NormalizedReviewerResult,
        extraction_delta: ExtractionDelta,
    ) -> dict[str, Any]:
        payload = self._build_commit_payload(
            chapter,
            title,
            word_count,
            review_result,
            extraction_delta,
        )
        commit_file = self._persist_commit(payload)
        memory_updated = False
        state_updated = False
        if payload["status"] == "accepted":
            self._update_memory(payload)
            self._update_state(chapter, word_count)
            memory_updated = True
            state_updated = True
            logger.info("chapter %d '%s' accepted, %d words", chapter, title, word_count)
        else:
            logger.info("chapter %d '%s' rejected, %d blockers", chapter, title, payload["review"]["blocker_count"])

        return {
            "chapter": chapter,
            "title": title,
            "status": payload["status"],
            "commit_file": str(commit_file),
            "memory_updated": memory_updated,
            "state_updated": state_updated,
        }

    def _build_commit_payload(
        self,
        chapter: int,
        title: str,
        word_count: int,
        review_result: NormalizedReviewerResult,
        extraction_delta: ExtractionDelta,
    ) -> dict[str, Any]:
        self._ensure_normalized_review_result(review_result)
        blockers = review_result.get("blockers") or []
        warnings = review_result.get("warnings") or []
        issues = review_result.get("issues") or blockers + warnings
        blocker_count = len(blockers)
        issue_count = len(issues)
        passed = blocker_count == 0
        status = "accepted" if passed and blocker_count == 0 else "rejected"
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

    def _persist_commit(self, payload: dict[str, Any]) -> Path:
        self.config.chapters_dir.mkdir(parents=True, exist_ok=True)
        commit_file = self.config.chapters_dir / chapter_commit_file_name(
            payload["chapter"],
            pad_width=self.config.chapter_pad_width,
        )
        atomic_write_json(commit_file, payload, use_lock=True, backup=True)
        return commit_file

    def _update_memory(self, payload: dict[str, Any]) -> None:
        memory = MemoryManager(self.config)
        memory.apply_chapter_delta(payload["delta"])
        memory.flush()

    def _update_state(self, chapter: int, word_count: int) -> None:
        state = StateManager(self.config)
        state.update_progress(chapter=chapter, words_delta=word_count, phase="writing")
        state.flush()
