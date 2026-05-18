#!/usr/bin/env python3
"""CLI output helpers."""

from __future__ import annotations

import json
import sys
from typing import Any, Iterable, Tuple


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def print_info(message: str) -> None:
    print(message)


def print_error(message: str) -> None:
    print(message, file=sys.stderr)


def print_kv(items: Iterable[Tuple[str, Any]]) -> None:
    for key, value in items:
        print(f"{key}: {value}")
