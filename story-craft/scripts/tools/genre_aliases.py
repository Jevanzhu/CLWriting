#!/usr/bin/env python3
"""Genre alias normalization for story-craft."""

from __future__ import annotations


GENRE_ALIASES: dict[str, str] = {
    "悬疑": "悬疑灵异",
    "悬疑小说": "悬疑灵异",
    "推理": "悬疑灵异",
    "灵异": "悬疑灵异",
    "规则": "规则怪谈",
    "怪谈": "规则怪谈",
    "现实": "现实题材",
    "现实主义": "现实题材",
    "都市": "都市日常",
    "都市生活": "都市日常",
    "都市异能文": "都市异能",
    "科幻小说": "科幻",
    "科幻短篇": "科幻",
    "奇幻": "西幻",
    "玄幻": "xuanhuan",
    "仙侠": "修仙",
    "修真": "修仙",
    "言情": "现言脑洞",
    "现代言情": "现言脑洞",
    "古代言情": "古言",
    "狗血": "狗血言情",
    "知乎": "知乎短篇",
    "短篇": "知乎短篇",
}


SUPPORTED_GENRES: list[str] = [
    "修仙",
    "克苏鲁",
    "历史古代",
    "历史脑洞",
    "古言",
    "多子多福",
    "女频悬疑",
    "宫斗宅斗",
    "年代",
    "幻想言情",
    "悬疑灵异",
    "悬疑脑洞",
    "抗战谍战",
    "无限流",
    "替身文",
    "末世",
    "民国言情",
    "游戏体育",
    "狗血言情",
    "现实题材",
    "现言脑洞",
    "电竞",
    "直播文",
    "知乎短篇",
    "种田",
    "科幻",
    "系统流",
    "职场婚恋",
    "西幻",
    "规则怪谈",
    "豪门总裁",
    "都市异能",
    "都市日常",
    "都市脑洞",
    "青春甜宠",
    "高武",
    "黑暗题材",
    "xuanhuan",
]


def normalize_genre(genre: str) -> str:
    """Normalize a user-facing genre label to the canonical name."""
    value = (genre or "").strip()
    if not value:
        return "现实题材"
    if value in SUPPORTED_GENRES:
        return value
    return GENRE_ALIASES.get(value, value)


def list_all_genres() -> list[str]:
    """Return supported canonical genres."""
    return list(SUPPORTED_GENRES)
