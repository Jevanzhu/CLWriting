#!/usr/bin/env python3
"""Chapter-commit truth-source storage."""

from __future__ import annotations

from pathlib import Path

from core.chapter_paths import commit_file_name, iter_commit_files
from core.config import StoryCraftConfig
from core.security_utils import atomic_write_json, read_json_safe
from core.types import ChapterCommit


class CommitStore:
    """Read and write accepted/rejected chapter commits under .story/commits."""

    def __init__(self, config: StoryCraftConfig | None = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "CommitStore":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def write(self, commit: ChapterCommit) -> Path:
        path = self.config.commits_dir / commit_file_name(int(commit["chapter"]))
        atomic_write_json(path, dict(commit), use_lock=True, backup=True)
        return path

    def read(self, chapter: int) -> ChapterCommit | None:
        path = self.config.commits_dir / commit_file_name(chapter)
        if not path.exists():
            return None
        return read_json_safe(path, {})

    def latest(self) -> ChapterCommit | None:
        commits = self.iter_all()
        return commits[-1] if commits else None

    def latest_accepted(self) -> ChapterCommit | None:
        for commit in reversed(self.iter_all()):
            if commit.get("status") == "accepted":
                return commit
        return None

    def iter_all(self) -> list[ChapterCommit]:
        commits: list[tuple[int, ChapterCommit]] = []
        for path in iter_commit_files(config=self.config):
            payload = read_json_safe(path, {})
            chapter = _commit_chapter(payload, path)
            if chapter is not None:
                commits.append((chapter, payload))
        return [payload for _, payload in sorted(commits, key=lambda item: item[0])]

    def exists(self, chapter: int) -> bool:
        return (self.config.commits_dir / commit_file_name(chapter)).exists()


def _commit_chapter(payload: dict, path: Path) -> int | None:
    try:
        return int(payload.get("chapter") or path.stem.split("_", 1)[1].split(".", 1)[0])
    except (IndexError, TypeError, ValueError):
        return None
