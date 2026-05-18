#!/usr/bin/env python3
"""Runtime compatibility helpers."""

from __future__ import annotations

import io
import os
import re
import sys
from pathlib import Path
from typing import Union


def enable_windows_utf8_stdio(*, skip_in_pytest: bool = False) -> bool:
    """Enable UTF-8 stdio wrappers on Windows."""
    if sys.platform != "win32":
        return False
    if skip_in_pytest and os.environ.get("PYTEST_CURRENT_TEST"):
        return False

    stdout_encoding = str(getattr(sys.stdout, "encoding", "") or "").lower()
    stderr_encoding = str(getattr(sys.stderr, "encoding", "") or "").lower()
    if stdout_encoding == "utf-8" and stderr_encoding == "utf-8":
        return False

    try:
        if hasattr(sys.stdout, "buffer"):
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
        if hasattr(sys.stderr, "buffer"):
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")
        return True
    except Exception:
        return False


_WIN_POSIX_DRIVE_RE = re.compile(r"^/(?P<drive>[a-zA-Z])/(?P<rest>.*)$")
_WIN_WSL_MNT_DRIVE_RE = re.compile(r"^/mnt/(?P<drive>[a-zA-Z])/(?P<rest>.*)$")


def normalize_windows_path(value: Union[str, Path]) -> Path:
    """Normalize common POSIX-style paths to Windows drive paths."""
    if sys.platform != "win32":
        return Path(value)

    raw = str(value).strip()
    if not raw:
        return Path(raw)

    match = _WIN_WSL_MNT_DRIVE_RE.match(raw)
    if match:
        drive = match.group("drive").upper()
        rest = match.group("rest")
        return Path(f"{drive}:/{rest}")

    match = _WIN_POSIX_DRIVE_RE.match(raw)
    if match:
        drive = match.group("drive").upper()
        rest = match.group("rest")
        return Path(f"{drive}:/{rest}")

    return Path(value)
