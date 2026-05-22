#!/usr/bin/env python3
"""Security and filesystem helpers."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
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


def sanitize_commit_message(message: str, max_length: int = 200) -> str:
    """Sanitize a git commit message."""
    safe_msg = message.replace("\n", " ").replace("\r", " ")
    safe_msg = re.sub(r"--[\w-]+", "", safe_msg)
    safe_msg = safe_msg.replace("'", "").replace('"', "")
    safe_msg = safe_msg.lstrip("-")
    safe_msg = re.sub(r"\s+", " ", safe_msg).strip()
    if len(safe_msg) > max_length:
        safe_msg = safe_msg[:max_length].strip()
    return safe_msg or "Untitled commit"


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

    lock_path = target.with_suffix(target.suffix + ".lock")
    backup_path = target.with_suffix(target.suffix + ".bak")
    fd, temp_path = tempfile.mkstemp(
        suffix=".tmp",
        prefix=target.stem + "_",
        dir=target.parent,
    )
    temp_file = Path(temp_path)

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
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
) -> Dict[str, Any]:
    """Safely read a JSON file and return a default dict on failure."""
    target = Path(file_path)
    fallback: Dict[str, Any] = default or {}
    if not target.exists():
        return dict(fallback)

    try:
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else dict(fallback)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("failed to read JSON %s: %s", target, exc)
        return dict(fallback)
