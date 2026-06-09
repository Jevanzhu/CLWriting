#!/bin/bash
# post-compact.sh - remind Claude Code to reload writing context.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$HOOK_DIR/lib/common.sh"

ROOT=$(project_root)
CONTEXT_FILE="$ROOT/追踪/上下文.md"

if [ -f "$CONTEXT_FILE" ]; then
  LINE_COUNT=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')
  echo "Context was compacted. Read 追踪/上下文.md ($LINE_COUNT lines) to restore writing context."
else
  echo "Context was compacted. Check 追踪/上下文.md to restore writing context."
fi
