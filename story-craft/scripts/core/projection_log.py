#!/usr/bin/env python3
"""投影执行日志（append-only jsonl）。

每次投影 run（chapter-commit 落盘或 rebuild-views 重放）追加一条记录，
保留 writers 各路投影的 ok/skipped/detail 与整体状态，供 health/排查事后
定位「state/memory/summary/index/vector/markdown_view 哪一路没同步」。

commit 是真源、投影可重建，因此投影失败不阻断 commit；本日志提供事后可观测性，
是 write 即时 warnings 之外的历史追溯层（借鉴 webnovel projection_log.jsonl）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from core.config import StoryCraftConfig
from core.projection.base import ProjectionResult
from core.time_utils import now_utc_iso

SCHEMA_VERSION = "story-craft/projection-log/v1"
PROJECTION_LOG_NAME = "projection_log.jsonl"


def projection_log_path(config: StoryCraftConfig) -> Path:
    return config.story_dir / PROJECTION_LOG_NAME


def _overall_status(results: dict[str, ProjectionResult]) -> str:
    if not results:
        return "done"
    if any(not result.ok for result in results.values()):
        return "failed"
    if all(result.skipped for result in results.values()):
        return "skipped"
    return "done"


def build_projection_run(
    *,
    chapter: int,
    commit_status: str,
    results: dict[str, ProjectionResult],
    source: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": uuid4().hex,
        "created_at": now_utc_iso(),
        "chapter": int(chapter or 0),
        "source": source,
        "commit_status": str(commit_status or ""),
        "status": _overall_status(results),
        "writers": {
            name: {
                "ok": result.ok,
                "skipped": result.skipped,
                "detail": result.detail,
            }
            for name, result in results.items()
        },
    }


def append_projection_run(
    config: StoryCraftConfig,
    *,
    chapter: int,
    commit_status: str,
    results: dict[str, ProjectionResult],
    source: str,
) -> dict[str, Any]:
    record = build_projection_run(
        chapter=chapter,
        commit_status=commit_status,
        results=results,
        source=source,
    )
    path = projection_log_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
        handle.write("\n")
    return record


def read_projection_runs(
    config: StoryCraftConfig,
    *,
    chapter: Optional[int] = None,
) -> list[dict[str, Any]]:
    path = projection_log_path(config)
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if chapter is not None and int(payload.get("chapter") or 0) != int(chapter):
            continue
        records.append(payload)
    return records


def latest_projection_run(
    config: StoryCraftConfig,
    *,
    chapter: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    records = read_projection_runs(config, chapter=chapter)
    return records[-1] if records else None


def failed_writers(run: Optional[dict[str, Any]]) -> list[str]:
    """返回 run 中失败（ok=False）的投影名列表。"""
    if not isinstance(run, dict):
        return []
    writers = run.get("writers")
    if not isinstance(writers, dict):
        return []
    return sorted(
        name
        for name, state in writers.items()
        if isinstance(state, dict) and state.get("ok") is False
    )
