#!/bin/bash
# pre-compact.sh - summarize state before context compaction.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$HOOK_DIR/lib/common.sh"

ROOT=$(project_root)
CONTEXT_FILE="$ROOT/追踪/上下文.md"

echo "=== Pre-Compact Summary ==="

if [ -f "$CONTEXT_FILE" ]; then
  LINE_COUNT=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')
  echo "Writing context: 追踪/上下文.md ($LINE_COUNT lines)"
else
  echo "Writing context: not found"
fi

CHANGED=$(git -C "$ROOT" diff --name-only 2>/dev/null | wc -l | tr -d ' ') || CHANGED=0
STAGED=$(git -C "$ROOT" diff --name-only --cached 2>/dev/null | wc -l | tr -d ' ') || STAGED=0
echo "Git: ${CHANGED} unstaged, ${STAGED} staged"

echo "=== Pre-Compact Complete ==="
