from __future__ import annotations

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
GENRES_DIR = PLUGIN_ROOT / "templates" / "genres"


EXPECTED_GENRES = {
    "修仙.md",
    "克苏鲁.md",
    "历史古代.md",
    "历史脑洞.md",
    "古言.md",
    "多子多福.md",
    "女频悬疑.md",
    "宫斗宅斗.md",
    "年代.md",
    "幻想言情.md",
    "悬疑灵异.md",
    "悬疑脑洞.md",
    "抗战谍战.md",
    "无限流.md",
    "替身文.md",
    "末世.md",
    "民国言情.md",
    "游戏体育.md",
    "狗血言情.md",
    "现实题材.md",
    "现言脑洞.md",
    "电竞.md",
    "直播文.md",
    "知乎短篇.md",
    "种田.md",
    "科幻.md",
    "系统流.md",
    "职场婚恋.md",
    "西幻.md",
    "规则怪谈.md",
    "豪门总裁.md",
    "都市异能.md",
    "都市日常.md",
    "都市脑洞.md",
    "青春甜宠.md",
    "高武.md",
    "黑暗题材.md",
}

REQUIRED_SECTIONS = [
    "## 题材定位",
    "## 题材抓手",
    "## 短篇适配",
    "### 字数分配建议",
    "### 情节压缩方法",
    "### 角色精简指南",
    "### 结局类型建议",
    "### 避免的坑",
]

REQUIRED_SHORT_FORM_PHRASES = [
    "1-3万字",
    "3-5万字",
    "5-10万字",
    "结局",
    "核心角色",
]

FORBIDDEN_LONG_FORM_PHRASES = [
    "完整升级链",
    "完整后宫",
    "完整商业帝国",
    "完整联赛",
    "百万字",
    "卷节拍",
    "第1卷",
]


def test_all_genre_templates_exist():
    assert GENRES_DIR.is_dir(), "missing templates/genres"
    actual = {path.name for path in GENRES_DIR.glob("*.md")}
    assert EXPECTED_GENRES == actual


def test_each_genre_template_has_required_short_form_sections():
    for template_file in GENRES_DIR.glob("*.md"):
        text = template_file.read_text(encoding="utf-8")
        assert len(text.strip()) > 500
        assert f"# {template_file.stem}" == text.splitlines()[0]
        for section in REQUIRED_SECTIONS:
            assert section in text
        for phrase in REQUIRED_SHORT_FORM_PHRASES:
            assert phrase in text


def test_genre_templates_avoid_long_form_planning_terms():
    for template_file in GENRES_DIR.glob("*.md"):
        text = template_file.read_text(encoding="utf-8")
        for phrase in FORBIDDEN_LONG_FORM_PHRASES:
            assert phrase not in text


def test_genre_profile_reference_lists_same_genres():
    text = (
        PLUGIN_ROOT / "references" / "shared" / "genre-profiles.md"
    ).read_text(encoding="utf-8")
    for filename in EXPECTED_GENRES:
        assert filename.removesuffix(".md") in text
