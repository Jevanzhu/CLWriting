from __future__ import annotations

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
GENRE_PACKS_DIR = PLUGIN_ROOT / "genres"


EXPECTED_PACKS = {
    "realistic": ["现实题材", "都市日常", "职场婚恋"],
    "rules-mystery": ["悬疑灵异", "规则怪谈", "悬疑脑洞"],
    "dog-blood-romance": ["狗血言情", "替身文", "豪门总裁"],
    "period-drama": ["历史古代", "古言", "宫斗宅斗"],
    "xuanhuan": ["修仙", "高武", "系统流"],
    "zhihu-short": ["知乎短篇", "强问题", "反击"],
}

EXPECTED_FILES = {"README.md", "patterns.md", "checklist.md"}

REQUIRED_PACK_PHRASES = [
    "短篇",
    "中篇",
    "推荐读取顺序",
]

REQUIRED_PATTERN_PHRASES = [
    "## 短篇压缩",
    "1-3 万字",
    "3-5 万字",
    "5-10 万字",
]

REQUIRED_CHECKLIST_PHRASES = [
    "## 写前检查",
    "## 写作中检查",
    "## 审查检查",
]


def test_all_genre_packs_exist():
    assert GENRE_PACKS_DIR.is_dir(), "missing genres dir"
    actual = {path.name for path in GENRE_PACKS_DIR.iterdir() if path.is_dir()}
    assert set(EXPECTED_PACKS) == actual


def test_each_genre_pack_has_required_files_and_content():
    for pack, phrases in EXPECTED_PACKS.items():
        pack_dir = GENRE_PACKS_DIR / pack
        actual = {path.name for path in pack_dir.iterdir() if path.is_file()}
        assert EXPECTED_FILES == actual

        readme = (pack_dir / "README.md").read_text(encoding="utf-8")
        patterns = (pack_dir / "patterns.md").read_text(encoding="utf-8")
        checklist = (pack_dir / "checklist.md").read_text(encoding="utf-8")

        assert f"# {pack}" == readme.splitlines()[0]
        for phrase in REQUIRED_PACK_PHRASES + phrases:
            assert phrase in readme

        for phrase in REQUIRED_PATTERN_PHRASES:
            assert phrase in patterns

        for phrase in REQUIRED_CHECKLIST_PHRASES:
            assert phrase in checklist

        assert len(readme.strip()) > 200
        assert len(patterns.strip()) > 300
        assert len(checklist.strip()) > 200


def test_genre_packs_link_to_existing_templates():
    template_dir = PLUGIN_ROOT / "templates" / "genres"
    for pack, template_names in EXPECTED_PACKS.items():
        for template_name in template_names:
            if template_name in {"强问题", "反击"}:
                continue
            assert (template_dir / f"{template_name}.md").is_file()
