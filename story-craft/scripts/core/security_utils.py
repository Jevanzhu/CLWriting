#!/usr/bin/env python3
"""Security and filesystem helpers."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Union

logger = logging.getLogger("core.security_utils")

try:
    from filelock import FileLock

    HAS_FILELOCK = True
except (ImportError, OSError):
    FileLock = None  # type: ignore[assignment]
    HAS_FILELOCK = False


class AtomicWriteError(Exception):
    """Raised when atomic file writing fails."""


_git_available: Optional[bool] = None


def sanitize_filename(name: str, max_length: int = 100) -> str:
    """Sanitize a filename and strip path traversal characters."""
    safe_name = os.path.basename(name)
    safe_name = safe_name.replace("/", "_").replace("\\", "_")
    safe_name = re.sub(r"[^\w\u4e00-\u9fff-]", "_", safe_name)
    safe_name = re.sub(r"_+", "_", safe_name).strip("_")
    if len(safe_name) > max_length:
        safe_name = safe_name[:max_length].strip("_")
    return safe_name or "unnamed"


def sanitize_record_label(label: str, max_length: int = 200) -> str:
    """Sanitize a human-facing record label."""
    safe_label = label.replace("\n", " ").replace("\r", " ")
    safe_label = re.sub(r"--[\w-]+", "", safe_label)
    safe_label = safe_label.replace("'", "").replace('"', "")
    safe_label = safe_label.lstrip("-")
    safe_label = re.sub(r"\s+", " ", safe_label).strip()
    if len(safe_label) > max_length:
        safe_label = safe_label[:max_length].strip()
    return safe_label or "Untitled record"


def is_git_available() -> bool:
    """Return whether git is available in PATH."""
    global _git_available
    if _git_available is not None:
        return _git_available

    try:
        result = subprocess.run(
            ["git", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        _git_available = result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        _git_available = False
    return _git_available


def atomic_write_json(
    file_path: Union[str, Path],
    data: Dict[str, Any],
    *,
    use_lock: bool = True,
    backup: bool = False,
    indent: int = 2,
) -> None:
    """Atomically write a JSON file."""
    target = Path(file_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        payload = json.dumps(data, ensure_ascii=False, indent=indent)
    except (TypeError, ValueError) as exc:
        raise AtomicWriteError(f"Failed to serialize JSON: {exc}") from exc

    _atomic_write_payload(target, payload, use_lock=use_lock, backup=backup)


def atomic_write_text(
    file_path: Union[str, Path],
    data: str,
    *,
    use_lock: bool = True,
    backup: bool = False,
    encoding: str = "utf-8",
) -> None:
    """Atomically write a text file."""
    target = Path(file_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_payload(target, data, use_lock=use_lock, backup=backup, encoding=encoding)


def _atomic_write_payload(
    file_path: Union[str, Path],
    payload: str,
    *,
    use_lock: bool = True,
    backup: bool = False,
    encoding: str = "utf-8",
) -> None:
    """Atomically write a serialized text payload."""
    target = Path(file_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_suffix(target.suffix + ".lock")
    backup_path = target.with_suffix(target.suffix + ".bak")
    fd, temp_path = tempfile.mkstemp(
        suffix=".tmp",
        prefix=target.stem + "_",
        dir=target.parent,
    )
    temp_file = Path(temp_path)

    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())

        lock = None
        if use_lock and HAS_FILELOCK:
            lock = FileLock(str(lock_path), timeout=10)
            lock.acquire()

        try:
            if backup and target.exists():
                backup_path.write_bytes(target.read_bytes())
            os.replace(temp_file, target)
        finally:
            if lock is not None:
                lock.release()
    except Exception as exc:
        raise AtomicWriteError(f"Failed to write {target}: {exc}") from exc
    finally:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass


def read_json_safe(
    file_path: Union[str, Path],
    default: Optional[Dict[str, Any]] = None,
    *,
    preserve_corrupt: bool = False,
) -> Dict[str, Any]:
    """Safely read a JSON file and return a default dict on failure.

    preserve_corrupt=True 时，若文件存在但 JSON 损坏，先把损坏内容另存为带时间戳的
    .corrupt 副本再回退默认值——避免损坏内容被后续 atomic_write 覆盖、丢失取证线索。
    供 state.json / memory.json 这类关键文件读取时启用。
    """
    target = Path(file_path)
    fallback: Dict[str, Any] = default or {}
    if not target.exists():
        return dict(fallback)

    try:
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else dict(fallback)
    except json.JSONDecodeError as exc:
        if preserve_corrupt:
            _preserve_corrupt_file(target, exc)
        else:
            logger.warning("failed to read JSON %s: %s", target, exc)
        return dict(fallback)
    except OSError as exc:
        logger.warning("failed to read JSON %s: %s", target, exc)
        return dict(fallback)


def _preserve_corrupt_file(target: Path, exc: Exception) -> None:
    """把损坏的关键 JSON 另存为带时间戳的 .corrupt 副本供取证，避免被后续写入覆盖。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    corrupt_path = target.with_name(f"{target.name}.corrupt_{stamp}")
    try:
        shutil.copy2(target, corrupt_path)
        logger.warning(
            "JSON 文件损坏 %s：%s；已另存损坏副本 %s 供取证，本次回退到默认值。",
            target,
            exc,
            corrupt_path,
        )
    except OSError as copy_exc:
        logger.warning(
            "JSON 文件损坏 %s：%s；保留损坏副本失败：%s",
            target,
            exc,
            copy_exc,
        )
