#!/bin/bash
# session-start.sh - show story-craft project status when useful.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT=""
HAS_CONTENT=false

if [ ! -f "$HOOK_DIR/lib/common.sh" ] || [ ! -f "$HOOK_DIR/lib/sentinel.sh" ]; then
  printf '%b' "[WARN] story-craft hook libraries are missing. Re-run /story-init to restore .claude/hooks/lib/.\n"
  exit 0
fi

source "$HOOK_DIR/lib/common.sh"
source "$HOOK_DIR/lib/sentinel.sh"

ROOT=$(project_root)
DEPLOYMENT=$(deployment_file)

if sentinel_exists "$DEPLOYMENT"; then
  MISSING_HOOKS=""
  for hook in session-start.sh session-end.sh detect-story-gaps.sh pre-compact.sh post-compact.sh validate-story-commit.sh lib/common.sh lib/sentinel.sh; do
    if [ ! -f "$ROOT/.claude/hooks/$hook" ]; then
      MISSING_HOOKS+="$hook "
    fi
  done
  if [ -n "$MISSING_HOOKS" ]; then
    OUTPUT+="[WARN] deployment metadata exists but hooks are missing: $MISSING_HOOKS\n"
    OUTPUT+="  Fix: re-run /story-init to restore missing hooks.\n\n"
    HAS_CONTENT=true
  fi

  AGENTS_VERSION=$(read_deployment_field agents_version "$DEPLOYMENT")
  case "$AGENTS_VERSION" in
    ''|*[!0-9]*)
      OUTPUT+="[WARN] deployment metadata missing numeric agents_version. Re-run /story-init.\n\n"
      HAS_CONTENT=true
      ;;
    *)
      if [ "$AGENTS_VERSION" -lt 9 ]; then
        OUTPUT+="[WARN] story-craft agents_version=$AGENTS_VERSION is older than v9. Re-run /story-init to refresh hooks and references.\n\n"
        HAS_CONTENT=true
      fi
      ;;
  esac

  for field in project_type setup_skill_version target_cli; do
    if [ -z "$(read_deployment_field "$field" "$DEPLOYMENT")" ]; then
      OUTPUT+="[WARN] deployment metadata missing $field. Re-run /story-init to refresh deployment metadata.\n\n"
      HAS_CONTENT=true
    fi
  done
else
  OUTPUT+="[WARN] Writing infrastructure not deployed. Run /story-init to initialize.\n\n"
  HAS_CONTENT=true
fi

BRANCH=$(git -C "$ROOT" branch --show-current 2>/dev/null || true)
if [ -n "$BRANCH" ]; then
  OUTPUT+="=== Story Writing ===\n"
  OUTPUT+="Branch: $BRANCH\n"
  RECENT=$(git -C "$ROOT" log --oneline -5 2>/dev/null || true)
  if [ -n "$RECENT" ]; then
    OUTPUT+="$RECENT\n"
  fi
  OUTPUT+="\n"
  HAS_CONTENT=true
fi

CONTEXT_FILE="$ROOT/追踪/上下文.md"
if [ -f "$CONTEXT_FILE" ]; then
  OUTPUT+="--- 当前位置 ---\n"
  SNAPSHOT=$(head -10 "$CONTEXT_FILE")
  OUTPUT+="${SNAPSHOT}\n---\n\n"
  HAS_CONTENT=true
fi

if [ -d "$ROOT/拆文库" ]; then
  PROGRESS_COUNT=$(find "$ROOT/拆文库" -name "_progress.md" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PROGRESS_COUNT" -gt 0 ]; then
    OUTPUT+="[INFO] $PROGRESS_COUNT incomplete analysis in 拆文库/. Run /story-long-analyze or /story-import.\n"
    HAS_CONTENT=true
  fi
fi

if [ "$HAS_CONTENT" = true ]; then
  printf '%b' "$OUTPUT"
fi
