#!/bin/bash
# detect-story-gaps.sh - advisory project-level writing gap checks.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$HOOK_DIR/lib/common.sh"
source "$HOOK_DIR/lib/sentinel.sh"

ROOT=$(project_root)

if [ ! -f "$ROOT/.story/state.json" ]; then
  exit 0
fi

PROJECT_NAME=$(basename "$ROOT")
PROJECT_TYPE=$(read_deployment_field project_type "$(deployment_file)")
if [ "$PROJECT_TYPE" != "long" ] && [ "$PROJECT_TYPE" != "short" ]; then
  if [ -d "$ROOT/追踪" ]; then
    PROJECT_TYPE="long"
  else
    PROJECT_TYPE="short"
  fi
fi

OUTPUT=""
HAS_WARNINGS=false

CHAPTER_COUNT=0
if [ -d "$ROOT/正文" ]; then
  CHAPTER_COUNT=$(find "$ROOT/正文" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
elif [ -f "$ROOT/正文.md" ]; then
  CHAPTER_COUNT=1
fi

SETTING_COUNT=0
if [ -d "$ROOT/设定" ]; then
  SETTING_COUNT=$(find "$ROOT/设定" -type f -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
fi

if [ "$CHAPTER_COUNT" -gt 10 ] && [ "$SETTING_COUNT" -lt 3 ]; then
  OUTPUT+="[WARN] $PROJECT_NAME: $CHAPTER_COUNT chapters but only $SETTING_COUNT setting files. Consider adding more settings.\n"
  HAS_WARNINGS=true
fi

if [ -f "$ROOT/追踪/伏笔.md" ]; then
  ABNORMAL_FORESHADOW=$(awk -F'|' '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    /^\|/ && $0 !~ /^\|[-[:space:]|]+$/ {
      status=trim($6)
      if (status == "" || status == "状态" || status ~ /^状态\{/) next
      if (status == "已过期" || (status != "未埋" && status != "已埋" && status != "已回收")) print
    }
  ' "$ROOT/追踪/伏笔.md" 2>/dev/null || true)
  if [ -n "$ABNORMAL_FORESHADOW" ]; then
    OUTPUT+="[WARN] $PROJECT_NAME: Overdue/abnormal foreshadowing entries detected in 伏笔.md. Consider /story-review lean or explicit foreshadow audit.\n"
    HAS_WARNINGS=true
  fi
fi

has_long_outline() {
  if [ -d "$ROOT/大纲" ] && find "$ROOT/大纲" -maxdepth 2 -type f -name "*.md" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  if [ -d "$ROOT/.story/contracts/volumes" ] && find "$ROOT/.story/contracts/volumes" -type f -name "*.json" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  if [ -d "$ROOT/.story/contracts/chapters" ] && find "$ROOT/.story/contracts/chapters" -type f -name "*.json" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if [ "$CHAPTER_COUNT" -gt 0 ]; then
  if [ "$PROJECT_TYPE" = "long" ]; then
    if ! has_long_outline; then
      OUTPUT+="[WARN] $PROJECT_NAME: 正文 exists but 大纲/ or outline contracts are missing. Consider creating an outline first.\n"
      HAS_WARNINGS=true
    fi
  elif [ ! -f "$ROOT/小节大纲.md" ]; then
    OUTPUT+="[WARN] $PROJECT_NAME: 正文 exists but 小节大纲.md is missing. Consider creating an outline first.\n"
    HAS_WARNINGS=true
  fi
fi

if [ -d "$ROOT/拆文库" ]; then
  while IFS= read -r -d '' progress_file; do
    OUTPUT+="[WARN] Incomplete analysis: ${progress_file#$ROOT/}. Run /story-import or /story-long-analyze to continue.\n"
    HAS_WARNINGS=true
  done < <(find "$ROOT/拆文库" -name "_progress.md" -print0 2>/dev/null || true)
fi

if [ "$HAS_WARNINGS" = true ]; then
  printf '%b' "=== Story Gap Detection ===\nChecking: $PROJECT_NAME\n$OUTPUT\n"
fi
