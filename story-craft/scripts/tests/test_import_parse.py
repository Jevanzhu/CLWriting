from __future__ import annotations

from tools.import_parser import parse_import_source, split_import_chapters


def test_split_import_chapters_detects_chinese_headings():
    text = """第一章 暗室来信
林墨收到一封空白来信。

第二章 旧楼声响
周晚听见楼道里有人停步。
"""

    chapters = split_import_chapters(text)

    assert len(chapters) == 2
    assert chapters[0]["title"] == "第一章 暗室来信"
    assert chapters[0]["chapter"] == 1
    assert chapters[0]["word_count"] > 0
    assert "空白来信" in chapters[0]["body"]


def test_split_import_chapters_wraps_single_body_as_one_chapter():
    chapters = split_import_chapters("林墨推开门。\n门后没有人。")

    assert len(chapters) == 1
    assert chapters[0]["title"] == "导入章节001"
    assert chapters[0]["chapter"] == 1


def test_parse_import_source_supports_directory_inputs(tmp_path):
    source_dir = tmp_path / "import"
    source_dir.mkdir()
    (source_dir / "b.md").write_text("第二章 雨夜\n雨声盖住脚步。", encoding="utf-8")
    (source_dir / "a.txt").write_text("第一章 旧信\n信纸没有署名。", encoding="utf-8")

    result = parse_import_source(source_dir)

    assert result["ok"]
    assert result["file_count"] == 2
    assert result["chapter_count"] == 2
    assert result["chapters"][0]["title"] == "第一章 旧信"
    assert "rebuild-views" in " ".join(result["next_steps"])
