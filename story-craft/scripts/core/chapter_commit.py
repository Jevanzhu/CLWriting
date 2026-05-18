#!/usr/bin/env python3
"""Chapter commit service."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from core.chapter_paths import chapter_commit_file_name
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import atomic_write_json
from core.state_manager import StateManager
from core.types import ExtractionDelta, ReviewerResult


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ChapterCommitService:
    """Persist chapter commit payloads and update state/memory."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    def commit(
        self,
        chapter: int,
        title: str,
        word_count: int,
        review_result: ReviewerResult,
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
        review_result: ReviewerResult,
        extraction_delta: ExtractionDelta,
    ) -> dict[str, Any]:
        blockers = review_result.get("blockers") or []
        blocker_count = int(review_result.get("blocker_count") or len(blockers))
        passed = bool(review_result.get("passed", blocker_count == 0))
        status = "accepted" if passed and blocker_count == 0 else "rejected"
        delta = deepcopy(extraction_delta)
        delta.setdefault("chapter", int(chapter))
        return {
            "chapter": int(chapter),
            "title": title,
            "word_count": int(word_count),
            "written_at": now_utc(),
            "status": status,
            "review": {
                "passed": passed,
                "blockers": blockers,
                "warnings": review_result.get("warnings", []),
                "issue_count": int(review_result.get("issue_count") or 0),
                "blocker_count": blocker_count,
            },
            "delta": delta,
            "scenes": extraction_delta.get("scenes", []),
            "agent_calls": extraction_delta.get("agent_calls", {}),
        }

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
