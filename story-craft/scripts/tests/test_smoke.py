from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import long_chapter


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def test_two_chapter_smoke_keeps_context_clean(tmp_path):
    project = tmp_path / "demo"

    init = run_cli(
        "init",
        str(project),
        "暗室来信",
        "悬疑",
        "--word-count-target",
        "30000",
        "--synopsis",
        "法医收到亡友留下的空白来信，追查旧楼暗室真相。",
        "--protagonist-name",
        "林墨",
        "--protagonist-desire",
        "查清亡友死因",
        "--unique-advantage-desc",
        "法医病理学和现场痕迹阅读",
        "--world-setting",
        "近现代城市，线索必须能由物证、证词或行动记录回溯。",
    )
    assert init.returncode == 0, init.stderr

    plan = run_cli("--project-root", str(project), "plan", "--chapter-count", "8")
    assert plan.returncode == 0, plan.stderr

    brief1 = tmp_path / "brief-ch1.json"
    first_brief = run_cli(
        "--project-root",
        str(project),
        "agent",
        "brief",
        "--chapter",
        "1",
        "--output-file",
        str(brief1),
    )
    assert first_brief.returncode == 0, first_brief.stderr
    assert read_json(brief1)["ok"]

    brief2_before = tmp_path / "brief-ch2-before.json"
    blocked_brief = run_cli(
        "--project-root",
        str(project),
        "agent",
        "brief",
        "--chapter",
        "2",
        "--output-file",
        str(brief2_before),
    )
    assert blocked_brief.returncode == 1, blocked_brief.stderr
    assert "缺少上一章提交记录" in " ".join(read_json(brief2_before)["prewrite"]["blockers"])

    draft1 = tmp_path / "chapter-01.md"
    draft1.write_text(
        long_chapter(
            "第01章 信封上的刮痕",
            "林墨在解剖室收到亡友秦澈留下的信封，邮戳、封蜡刮痕、门卫证词和监控黑屏共同指向旧楼。",
        ),
        encoding="utf-8",
    )
    review1 = tmp_path / "review-ch1.json"
    write_json(review1, {"issues": [], "summary": "第1章可提交。"})
    delta1 = tmp_path / "delta-ch1.json"
    extract1 = run_cli(
        "--project-root",
        str(project),
        "agent",
        "extract",
        "--chapter",
        "1",
        "--chapter-file",
        str(draft1),
        "--output-file",
        str(delta1),
    )
    assert extract1.returncode == 0, extract1.stderr
    write1 = run_cli(
        "--project-root",
        str(project),
        "write",
        "1",
        "--draft-file",
        str(draft1),
        "--review-results",
        str(review1),
        "--delta-file",
        str(delta1),
    )
    assert write1.returncode == 0, write1.stderr

    brief2 = tmp_path / "brief-ch2.json"
    second_brief = run_cli(
        "--project-root",
        str(project),
        "agent",
        "brief",
        "--chapter",
        "2",
        "--output-file",
        str(brief2),
    )
    assert second_brief.returncode == 0, second_brief.stderr
    assert read_json(brief2)["ok"]

    context2 = json.loads(
        run_cli("--project-root", str(project), "query", "context", "--chapter", "2").stdout
    )
    recent_chapters = {item["chapter"] for item in context2["scene"]["recent_timeline"]}
    assert recent_chapters == {1}
    assert all(not item.get("planned") for item in context2["scene"]["recent_timeline"])

    draft2 = tmp_path / "chapter-02.md"
    draft2.write_text(
        long_chapter(
            "第02章 旧楼门禁",
            "林墨在旧楼外复查门禁、照片、排水沟封条和许照证词，确认有人改写过现场并隐藏地下室入口。",
        ),
        encoding="utf-8",
    )
    review2 = tmp_path / "review-ch2.json"
    write_json(review2, {"issues": [], "summary": "第2章可提交。"})
    delta2 = tmp_path / "delta-ch2.json"
    extract2 = run_cli(
        "--project-root",
        str(project),
        "agent",
        "extract",
        "--chapter",
        "2",
        "--chapter-file",
        str(draft2),
        "--output-file",
        str(delta2),
    )
    assert extract2.returncode == 0, extract2.stderr
    write2 = run_cli(
        "--project-root",
        str(project),
        "write",
        "2",
        "--draft-file",
        str(draft2),
        "--review-results",
        str(review2),
        "--delta-file",
        str(delta2),
    )
    assert write2.returncode == 0, write2.stderr

    status = json.loads(run_cli("--project-root", str(project), "query", "status").stdout)
    memory = json.loads(run_cli("--project-root", str(project), "query", "memory").stdout)
    entity_graph = json.loads(run_cli("--project-root", str(project), "query", "entity-graph").stdout)
    ranked = json.loads(
        run_cli("--project-root", str(project), "query", "ranked-context", "--chapter", "3").stdout
    )

    planned = [item for item in memory["timeline"] if item.get("planned")]
    actual = [item for item in memory["timeline"] if not item.get("planned")]
    assert status["progress"]["current_chapter"] == 2
    assert memory["last_updated_chapter"] == 2
    assert len(planned) == 6
    assert len(actual) == 2
    assert status["memory_counts"]["open_foreshadowing"] == 0
    assert any(node["name"] == "林墨" for node in entity_graph["nodes"])
    assert all(not item["payload"].get("planned") for item in ranked["selected"])
    ranked_timeline_chapters = {
        item["chapter"] for item in ranked["selected"] if item["kind"] == "timeline"
    }
    assert ranked_timeline_chapters == {1, 2}
