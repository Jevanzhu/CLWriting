#!/usr/bin/env python3
"""Contract truth-source storage for story-craft projects."""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

from core.config import StoryCraftConfig
from core.security_utils import atomic_write_json, atomic_write_text, read_json_safe
from core.types import (
    ChapterContract,
    MasterContract,
    ReviewContract,
    VolumeContract,
)


class ContractStore:
    """Read and write pre-write contracts under .story/contracts."""

    def __init__(self, config: StoryCraftConfig | None = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "ContractStore":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def read_master(self) -> MasterContract | None:
        return _read_optional_json(self.config.contracts_dir / "master.json")

    def write_master(self, contract: MasterContract) -> Path:
        path = self.config.contracts_dir / "master.json"
        _write_json(path, contract)
        return path

    def read_volume(self, volume: int) -> VolumeContract | None:
        return _read_optional_json(self._volume_path(volume))

    def write_volume(self, contract: VolumeContract) -> Path:
        path = self._volume_path(int(contract.get("volume") or 0))
        _write_json(path, contract)
        return path

    def iter_volumes(self) -> list[VolumeContract]:
        if not self.config.volumes_dir.exists():
            return []
        volumes: list[tuple[int, VolumeContract]] = []
        for path in sorted(self.config.volumes_dir.glob("volume_*.json")):
            payload = _read_optional_json(path)
            if payload is None:
                continue
            volume = _volume_number(path.name)
            if volume is not None:
                volumes.append((volume, payload))
        return [payload for _, payload in sorted(volumes, key=lambda item: item[0])]

    def read_chapter(self, chapter: int) -> ChapterContract | None:
        return _read_optional_json(self._chapter_path(chapter))

    def write_chapter(self, contract: ChapterContract) -> Path:
        path = self._chapter_path(int(contract.get("chapter") or 0))
        _write_json(path, contract)
        return path

    def read_review(self, chapter: int) -> ReviewContract | None:
        return _read_optional_json(self._review_path(chapter))

    def write_review(self, contract: ReviewContract) -> Path:
        path = self._review_path(int(contract.get("chapter") or 0))
        _write_json(path, contract)
        return path

    def read_style_fingerprint(self) -> dict[str, Any]:
        return _read_light_yaml(self.config.style_fingerprint_file)

    def write_style_fingerprint(self, data: dict[str, Any]) -> Path:
        atomic_write_text(
            self.config.style_fingerprint_file,
            _dump_light_yaml(data),
            use_lock=True,
            backup=True,
        )
        return self.config.style_fingerprint_file

    def read_anti_patterns(self) -> dict[str, Any]:
        return read_json_safe(self.config.anti_patterns_file, {})

    def write_anti_patterns(self, data: dict[str, Any]) -> Path:
        _write_json(self.config.anti_patterns_file, data)
        return self.config.anti_patterns_file

    def read_deployment(self) -> dict[str, Any]:
        return read_json_safe(self.config.deployment_file, {})

    def write_deployment(self, data: dict[str, Any]) -> Path:
        _write_json(self.config.deployment_file, data)
        return self.config.deployment_file

    def _volume_path(self, volume: int) -> Path:
        return self.config.volumes_dir / f"volume_{int(volume):03d}.json"

    def _chapter_path(self, chapter: int) -> Path:
        return self.config.chapter_contracts_dir / f"chapter_{int(chapter):03d}.json"

    def _review_path(self, chapter: int) -> Path:
        return self.config.review_contracts_dir / f"chapter_{int(chapter):03d}.review.json"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_json(path, dict(payload), use_lock=True, backup=True)


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return read_json_safe(path, {})


def _volume_number(name: str) -> int | None:
    if not name.startswith("volume_") or not name.endswith(".json"):
        return None
    try:
        return int(name.removeprefix("volume_").removesuffix(".json"))
    except ValueError:
        return None


def _dump_light_yaml(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for key in sorted(data):
        value = data[key]
        if isinstance(value, dict):
            lines.append(f"{key}:")
            for child_key in sorted(value):
                lines.append(f"  {child_key}: {repr(value[child_key])}")
        elif isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {repr(item)}")
        else:
            lines.append(f"{key}: {repr(value)}")
    return "\n".join(lines) + ("\n" if lines else "")


def _read_light_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}

    result: dict[str, Any] = {}
    current_key: str | None = None
    current_list: list[Any] | None = None
    current_dict: dict[str, Any] | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if not raw_line.startswith("  "):
            key, _, raw_value = raw_line.partition(":")
            current_key = key.strip()
            raw_value = raw_value.strip()
            if raw_value:
                result[current_key] = _literal_value(raw_value)
                current_list = None
                current_dict = None
            else:
                current_list = None
                current_dict = None
                result[current_key] = {}
            continue

        if current_key is None:
            continue
        stripped = raw_line.strip()
        if stripped.startswith("- "):
            if current_list is None:
                current_list = []
                result[current_key] = current_list
                current_dict = None
            current_list.append(_literal_value(stripped[2:].strip()))
            continue

        child_key, _, raw_value = stripped.partition(":")
        if raw_value:
            if current_dict is None:
                current_dict = {}
                result[current_key] = current_dict
                current_list = None
            current_dict[child_key.strip()] = _literal_value(raw_value.strip())
    return result


def _literal_value(value: str) -> Any:
    try:
        return ast.literal_eval(value)
    except (SyntaxError, ValueError):
        return value
