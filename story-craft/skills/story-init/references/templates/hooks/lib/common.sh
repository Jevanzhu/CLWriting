#!/bin/bash
# common.sh - shared helpers for story-craft hook templates.
# Do not set shell options here; this file is sourced by hook entrypoints.

_story_craft_abs_dir() {
  local path="$1"
  [ -n "$path" ] || return 1
  [ -d "$path" ] || return 1
  (cd "$path" 2>/dev/null && pwd -P)
}

_story_craft_find_root_from() {
  local start="$1"
  local dir
  dir=$(_story_craft_abs_dir "$start") || return 1

  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.story/state.json" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done

  if [ -f "/.story/state.json" ]; then
    printf '%s\n' "/"
    return 0
  fi
  return 1
}

# project_root - locate the story-craft project root.
# A valid project root is the nearest ancestor containing .story/state.json.
project_root() {
  local candidate

  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    candidate=$(_story_craft_find_root_from "$CLAUDE_PROJECT_DIR" 2>/dev/null || true)
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  local git_root
  git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$git_root" ]; then
    candidate=$(_story_craft_find_root_from "$git_root" 2>/dev/null || true)
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  candidate=$(_story_craft_find_root_from "$(pwd -P)" 2>/dev/null || true)
  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then
    _story_craft_abs_dir "$CLAUDE_PROJECT_DIR"
    return 0
  fi
  if [ -n "$git_root" ] && [ -d "$git_root" ]; then
    _story_craft_abs_dir "$git_root"
    return 0
  fi
  pwd -P
}

resolve_project_path() {
  local path="$1"
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$(project_root)" "$path" ;;
  esac
}

project_has_story_state() {
  [ -f "$(project_root)/.story/state.json" ]
}

tracking_context_file() {
  printf '%s/追踪/上下文.md\n' "$(project_root)"
}
