#!/usr/bin/env python3
"""Runtime diagnostics exposed through health checks."""

from __future__ import annotations

import sys
from typing import Any

from core import security_utils


def build_runtime_diagnostics() -> dict[str, Any]:
    diagnostics = {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "filelock_available": bool(security_utils.HAS_FILELOCK),
        "warnings": [],
    }
    if not diagnostics["filelock_available"]:
        diagnostics["warnings"].append(
            "未安装 filelock，JSON 文件写入将只使用原子替换，跨进程锁保护会降级。"
        )
    if sys.platform == "win32":
        stdout_encoding = str(getattr(sys.stdout, "encoding", "") or "").lower()
        stderr_encoding = str(getattr(sys.stderr, "encoding", "") or "").lower()
        diagnostics["stdio_encoding"] = {
            "stdout": stdout_encoding,
            "stderr": stderr_encoding,
        }
        if stdout_encoding != "utf-8" or stderr_encoding != "utf-8":
            diagnostics["warnings"].append(
                "Windows 标准输出不是 UTF-8；建议使用 python -X utf8 运行。"
            )
    return diagnostics
