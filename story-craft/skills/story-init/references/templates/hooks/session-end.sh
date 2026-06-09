#!/bin/bash
# session-end.sh - optionally record session end time.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$HOOK_DIR/lib/common.sh"

if [ "${STORY_SESSION_LOG:-0}" != "1" ]; then
  exit 0
fi

ROOT=$(project_root)

if [ -d "$ROOT/追踪" ]; then
  printf '[%s] session ended\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$ROOT/追踪/session-log.txt"
fi
