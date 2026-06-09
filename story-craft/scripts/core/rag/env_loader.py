#!/usr/bin/env python3
"""best-effort .env 加载（零三方依赖，参考 webnovel-writer 的做法）。

约定与优先级（高 → 低）：
1. 显式环境变量（已存在的 os.environ 永不被覆盖）；
2. 故事项目根目录下的 `.env`；
3. 当前工作目录下的 `.env`；
4. 用户级全局：`~/.claude/story-craft/.env`。

KEY 解析支持 `export KEY=VALUE`、`# 注释`、`KEY="带引号的值"`。
"""

from __future__ import annotations

import os
from pathlib import Path

_LOADED_VALUES: dict[str, str] = {}


def _strip_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _read_dotenv_file(env_path: Path) -> dict[str, str]:
    try:
        if not env_path.exists():
            return {}
        values: dict[str, str] = {}
        with open(env_path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                key, _, value = line.partition("=")
                key = key.strip()
                if not key:
                    continue
                values[key] = _strip_value(value)
        return values
    except OSError:
        return {}


def load_dotenv_file(env_path: Path, *, override: bool = False) -> bool:
    """加载单个 .env 文件；默认不覆盖已有环境变量。返回是否成功读取。"""
    values = _read_dotenv_file(env_path)
    if not values:
        return False
    for key, value in values.items():
        if override or key not in os.environ:
            os.environ[key] = value
            _LOADED_VALUES[key] = value
    return True


def _user_claude_root() -> Path:
    raw = os.environ.get("CLAUDE_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".claude"


def load_dotenv(project_root: str | Path | None = None) -> None:
    """按优先级加载 .env，显式环境变量始终优先。"""
    protected_keys = {
        key
        for key, value in os.environ.items()
        if key not in _LOADED_VALUES or _LOADED_VALUES.get(key) != value
    }
    candidates = [
        _user_claude_root() / "story-craft" / ".env",
        Path.cwd() / ".env",
    ]
    if project_root is not None:
        candidates.append(Path(project_root) / ".env")

    # 低优先级先加载，高优先级后加载；但不覆盖调用前已经显式存在的变量。
    for env_path in candidates:
        for key, value in _read_dotenv_file(env_path).items():
            if key in protected_keys:
                continue
            os.environ[key] = value
            _LOADED_VALUES[key] = value
