from __future__ import annotations

from dataclasses import asdict
import subprocess
from pathlib import Path

from tools.deployment import deployment_manifest


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parent
CHECK_SCRIPT = PLUGIN_ROOT / "scripts" / "check-story-deployment.sh"


def test_stage4_deployment_manifest_sources_exist():
    for project_type in ("short", "long"):
        for asset in deployment_manifest(project_type):
            payload = asdict(asset)
            source = payload["source"]
            if source == "deployment-sentinel":
                continue

            source_path = PLUGIN_ROOT / source
            if source.endswith("/"):
                assert source_path.is_dir(), payload
            else:
                assert source_path.is_file(), payload


def test_stage4_deployment_shell_regression_passes():
    result = subprocess.run(
        ["bash", str(CHECK_SCRIPT)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "All story-craft deployment checks passed." in result.stdout


def test_stage4_cc_verification_doc_keeps_runtime_boundaries_clear():
    text = (REPO_ROOT / "docs" / "stage4-cc-verification.md").read_text(encoding="utf-8")

    for phrase in (
        "已自动验证",
        "待 Claude Code 验证",
        "不得标为已通过",
        "/story-init 首次部署",
        "/story-init 升级重部署",
        "SessionStart source=compact",
        "PreToolUse(Bash, git commit*)",
        "13 command 真实调用",
        "use <path>",
        "where",
    ):
        assert phrase in text

    assert "不能用本地 pytest 或 shell 回归结果替代" in text
