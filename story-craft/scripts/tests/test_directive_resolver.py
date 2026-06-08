from __future__ import annotations

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.contract_store import ContractStore
from core.directive_resolver import resolve_chapter_directive


def test_resolve_chapter_directive_prefers_contract(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    ContractStore(config).write_chapter(
        {
            "contract_version": "story-craft/contract-v1",
            "chapter": 2,
            "title": "旧楼",
            "chapter_directive": "进入旧楼并发现灯光异常。",
            "must_cover": ["灯光异常", "门卫证词"],
            "planned_word_count": 3000,
        }
    )
    CommitStore(config).write(
        {
            "chapter": 2,
            "title": "旧记录",
            "status": "accepted",
            "summary_text": "旧摘要不应覆盖合同。",
        }
    )

    result = resolve_chapter_directive(config, 2)

    assert result == {
        "chapter_directive": "进入旧楼并发现灯光异常。",
        "must_cover": ["灯光异常", "门卫证词"],
        "title": "旧楼",
        "planned_word_count": 3000,
        "source": "contract",
    }


def test_resolve_chapter_directive_falls_back_to_commit(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    CommitStore(config).write(
        {
            "chapter": 3,
            "title": "档案室",
            "status": "accepted",
            "summary_text": "林墨查到旧档案。",
            "chapter_summary": {
                "chapter": 3,
                "title": "档案室",
                "summary": "林墨在档案室发现尸检报告异常。",
            },
        }
    )

    result = resolve_chapter_directive(config, 3)

    assert result == {
        "chapter_directive": "林墨在档案室发现尸检报告异常。",
        "must_cover": [],
        "title": "档案室",
        "planned_word_count": 0,
        "source": "commit",
    }


def test_resolve_chapter_directive_returns_none_payload_without_sources(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()

    result = resolve_chapter_directive(config, 8)

    assert result == {
        "chapter_directive": "",
        "must_cover": [],
        "title": "",
        "planned_word_count": 0,
        "source": "none",
    }


def test_resolve_chapter_directive_does_not_read_outline_markdown(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    outline = config.outline_dir / "总纲.md"
    outline.write_text(
        "# 暗室\n\n## 第04章 档案室\n必须发现尸检报告异常。\n",
        encoding="utf-8",
    )

    result = resolve_chapter_directive(config, 4)

    assert result["source"] == "none"
    assert result["chapter_directive"] == ""
    assert result["must_cover"] == []
