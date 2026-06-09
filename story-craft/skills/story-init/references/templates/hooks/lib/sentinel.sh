#!/bin/bash
# sentinel.sh - read story-craft deployment metadata from JSON.
# Do not set shell options here; this file is sourced by hook entrypoints.

deployment_file() {
  if [ -n "${STORY_DEPLOYMENT_FILE:-}" ]; then
    printf '%s\n' "$STORY_DEPLOYMENT_FILE"
  elif command -v project_root >/dev/null 2>&1; then
    printf '%s/.story/contracts/deployment.json\n' "$(project_root)"
  else
    printf '%s\n' ".story/contracts/deployment.json"
  fi
}

read_deployment_field() {
  local field="$1"
  local file="${2:-$(deployment_file)}"
  [ -f "$file" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  python3 - "$field" "$file" <<'PY' 2>/dev/null || true
import json
import sys

field = sys.argv[1]
path = sys.argv[2]

try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(0)

value = data.get(field, "")
if value is None:
    sys.exit(0)
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
  return 0
}

sentinel_exists() {
  [ -f "${1:-$(deployment_file)}" ]
}
