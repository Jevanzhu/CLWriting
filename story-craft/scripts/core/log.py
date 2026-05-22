#!/usr/bin/env python3
"""Unified logging configuration for story-craft."""

from __future__ import annotations

import logging
import os

_LOGGER_NAMES = ("story_craft", "core", "tools")


def setup_logging() -> None:
    """Configure logging with level from STORY_CRAFT_LOG_LEVEL env var."""
    level_name = os.environ.get("STORY_CRAFT_LOG_LEVEL", "WARNING").upper()
    level = getattr(logging, level_name, logging.WARNING)
    for name in _LOGGER_NAMES:
        logging.getLogger(name).setLevel(level)


def get(name: str) -> logging.Logger:
    """Get a logger under the story-craft namespace."""
    return logging.getLogger(name)
