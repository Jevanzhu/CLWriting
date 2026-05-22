#!/usr/bin/env python3
"""Shared time helpers for story-craft."""

from __future__ import annotations

from datetime import datetime, timezone


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
