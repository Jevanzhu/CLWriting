#!/usr/bin/env python3
"""Project location helpers for story-craft."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple

from core.runtime_compat import normalize_windows_path


ENV_PROJECT_ROOT = "STORYCRAFT_PROJECT_ROOT"
CURRENT_PROJECT_POINTER = Path(".claude") / ".story-craft-current-project"
DEFAULT_PROJECT_DIR = "story-craft-project"


def is_project_root(path: Path) -> bool:
    """Return whether a path is a story-craft project root."""
    return (path / ".story" / "state.json").is_file()


def _find_workspace_root_with_claude(start: Path) -> Optional[Path]:
    for candidate in (start, *start.parents):
        if (candidate / ".claude").is_dir():
            return candidate
    return None


def _resolve_pointer(root: Path) -> Optional[Path]:
    for candidate in (root, *root.parents):
        pointer = candidate / CURRENT_PROJECT_POINTER
        if not pointer.is_file():
            continue
        raw = pointer.read_text(encoding="utf-8").strip()
        if not raw:
            continue
        target = normalize_windows_path(raw).expanduser()
        if not target.is_absolute():
            target = (pointer.parent / target).resolve()
        if is_project_root(target):
            return target.resolve()
    return None


def locate_project_root(
    candidate: Optional[str | Path] = None,
    *,
    cwd: Optional[Path] = None,
    allow_fallback: bool = False,
) -> Tuple[Path, str]:
    """Locate the active story-craft project root."""
    base = (cwd or Path.cwd()).resolve()

    if candidate is not None:
        root = normalize_windows_path(candidate).expanduser().resolve()
        if is_project_root(root):
            return root, "explicit"
        pointer_root = _resolve_pointer(root)
        if pointer_root is not None:
            return pointer_root, "explicit-pointer"
        if allow_fallback:
            return root, "explicit-fallback"
        raise FileNotFoundError(
            f"不是有效的 story-craft 项目根目录，缺少 .story/state.json：{root}"
        )

    env_root = os.environ.get(ENV_PROJECT_ROOT)
    if env_root:
        root = normalize_windows_path(env_root).expanduser().resolve()
        if is_project_root(root):
            return root, "env"
        if allow_fallback:
            return root, "env-fallback"
        raise FileNotFoundError(
            f"STORYCRAFT_PROJECT_ROOT 已设置，但不是有效项目根目录：{root}"
        )

    pointer_root = _resolve_pointer(base)
    if pointer_root is not None:
        return pointer_root, "pointer"

    for current in (base, *base.parents):
        if is_project_root(current):
            return current.resolve(), "ancestor"

    default_root = (base / DEFAULT_PROJECT_DIR).resolve()
    if is_project_root(default_root):
        return default_root, "default"
    if allow_fallback:
        return default_root, "default-fallback"

    raise FileNotFoundError(
        "无法定位 story-craft 项目根目录。请在当前目录或父目录放置 "
        ".story/state.json，或使用 --project-root 显式指定项目目录。"
    )


def resolve_project_root(
    candidate: Optional[str | Path] = None,
    *,
    cwd: Optional[Path] = None,
    allow_fallback: bool = False,
) -> Path:
    """Resolve the story-craft project root and return only the path."""
    path, _source = locate_project_root(candidate, cwd=cwd, allow_fallback=allow_fallback)
    return path


def write_current_project_pointer(
    project_root: Path,
    workspace_root: Optional[Path] = None,
) -> Optional[Path]:
    """Write a workspace-level project pointer file."""
    root = normalize_windows_path(project_root).expanduser().resolve()
    if not is_project_root(root):
        raise FileNotFoundError(
            f"不是有效的 story-craft 项目根目录，缺少 .story/state.json：{root}"
        )

    ws_root = (
        workspace_root.expanduser().resolve()
        if workspace_root is not None
        else _find_workspace_root_with_claude(Path.cwd().resolve())
    )
    if ws_root is None:
        ws_root = _find_workspace_root_with_claude(root)
    if ws_root is None:
        return None

    pointer = ws_root / CURRENT_PROJECT_POINTER
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(str(root), encoding="utf-8")
    return pointer
