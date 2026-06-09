#!/bin/bash
# check-story-deployment.sh - deterministic stage 4 deployment checks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"
HOOKS_DIR="$PLUGIN_ROOT/skills/story-init/references/templates/hooks"
SETTINGS_FILE="$PLUGIN_ROOT/skills/story-init/references/templates/settings-hooks.json"
SKILL_FILE="$PLUGIN_ROOT/skills/story-init/SKILL.md"
COMMANDS_DIR="$PLUGIN_ROOT/commands"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/story-craft-deployment.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "required file missing: $1"
}

assert_grep() {
  local pattern="$1"
  local file="$2"
  local message="$3"
  grep -Eq "$pattern" "$file" || fail "$message ($file)"
}

assert_no_grep_tree() {
  local pattern="$1"
  local target="$2"
  local message="$3"
  if grep -R -E "$pattern" "$target" >/dev/null 2>&1; then
    fail "$message ($target)"
  fi
}

copy_hooks() {
  local root="$1"
  mkdir -p "$root/.claude"
  cp -R "$HOOKS_DIR" "$root/.claude/hooks"
}

write_story_project() {
  local root="$1"
  local project_type="$2"
  mkdir -p "$root/.story/contracts"
  printf '{"project":{"title":"demo"}}\n' > "$root/.story/state.json"
  cat > "$root/.story/contracts/deployment.json" <<JSON
{
  "schema_version": "story-craft/deployment-v1",
  "agents_version": 9,
  "setup_skill_version": "4.0.0",
  "target_cli": "claude-code",
  "project_type": "$project_type",
  "resolver_strategy": "project-root-state-json",
  "references_dir": ".claude/story-craft/references"
}
JSON
}

setup_git_repo() {
  local root="$1"
  git -C "$root" init -q
  git -C "$root" config user.email story-craft@example.invalid
  git -C "$root" config user.name story-craft-test
}

run_hook() {
  local root="$1"
  local hook="$2"
  (cd "$root" && CLAUDE_PROJECT_DIR="$root" bash "$root/.claude/hooks/$hook" 2>&1 || true)
}

echo "Story craft deployment check"
echo "============================"
echo "Repo: $REPO_ROOT"

echo "TS1 hook dependency completeness"
for hook in \
  session-start.sh \
  session-end.sh \
  pre-compact.sh \
  post-compact.sh \
  detect-story-gaps.sh \
  validate-story-commit.sh \
  lib/common.sh \
  lib/sentinel.sh
do
  assert_file "$HOOKS_DIR/$hook"
done

runtime_artifacts="$(find "$HOOKS_DIR" -maxdepth 4 \( -name '.DS_Store' -o -name '*.tmp' -o -name '*.log' -o -path '*/.omc*' \) -print 2>/dev/null || true)"
[ -z "$runtime_artifacts" ] || fail "hook templates contain runtime artifacts: $runtime_artifacts"

while IFS= read -r src; do
  [ -n "$src" ] || continue
  case "$src" in
    "\$HOOK_DIR/"*)
      rel="${src#"\$HOOK_DIR/"}"
      assert_file "$HOOKS_DIR/$rel"
      ;;
  esac
done < <(grep -RhoE '^source[[:space:]]+"[^"]+"' "$HOOKS_DIR"/*.sh | sed -E 's/^source[[:space:]]+"//;s/"$//' | sort -u)

assert_no_grep_tree '\.active-book|\.story-deployed|discover_[A-Za-z0-9_]*book|/story-setup' "$HOOKS_DIR" "legacy hook model leaked into templates"
echo "  OK"

echo "TS2 settings hooks and JSON"
python3 -m json.tool "$SETTINGS_FILE" >/dev/null
python3 - "$SETTINGS_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    hooks = json.load(handle)["hooks"]

expected = {"SessionStart", "SessionEnd", "PreToolUse", "PreCompact"}
if set(hooks) != expected:
    raise SystemExit(f"unexpected hook events: {sorted(hooks)}")
if "PostCompact" in hooks:
    raise SystemExit("PostCompact must be represented by SessionStart source=compact")

commands = []
for entry in hooks["SessionStart"]:
    for hook in entry["hooks"]:
        commands.append(hook["command"])
if not any("post-compact.sh" in command for command in commands):
    raise SystemExit("post-compact.sh missing from SessionStart")
if not any(entry.get("matcher") == "source=compact" for entry in hooks["SessionStart"]):
    raise SystemExit("source=compact matcher missing")

pre_tool = hooks["PreToolUse"][0]
if pre_tool.get("matcher") != "Bash":
    raise SystemExit("PreToolUse matcher must be Bash")
if pre_tool["hooks"][0].get("if") != "Bash(git commit*)":
    raise SystemExit("validate-story-commit must self-gate git commit")
PY
echo "  OK"

echo "TS3 deployment manifest table"
for header in 'Source path' 'Target path' 'Owner class' 'Merge mode' 'Validation check'; do
  assert_grep "$header" "$SKILL_FILE" "deployment manifest missing column: $header"
done
for group in \
  'templates/hooks/\*\.sh' \
  'lib/common\.sh' \
  'lib/sentinel\.sh' \
  'agents/\*\.md' \
  'commands/\*\.md' \
  'references/' \
  'settings-hooks\.json' \
  'CLAUDE\.md' \
  'deployment-sentinel'
do
  assert_grep "$group" "$SKILL_FILE" "deployment manifest missing asset group: $group"
done
assert_grep 'read_deployment\(config\)' "$SKILL_FILE" "read_deployment must be documented"
assert_grep 'needs_redeploy\(current, AGENTS_VERSION\)' "$SKILL_FILE" "needs_redeploy must be documented"
assert_grep 'write_deployment' "$SKILL_FILE" "write_deployment must be documented"
echo "  OK"

echo "TS4 command frontmatter and delegation"
command_count="$(find "$COMMANDS_DIR" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
[ "$command_count" -eq 13 ] || fail "expected 13 command files, found $command_count"
for command in \
  story-init \
  story-review \
  story-deslop \
  story-repair \
  story-import \
  story-query \
  story-learn \
  story-preflight \
  story-long-write \
  story-long-plan \
  story-long-analyze \
  story-long-scan \
  story-short-write
do
  file="$COMMANDS_DIR/$command.md"
  assert_file "$file"
  assert_grep '^description:' "$file" "command frontmatter missing description: $command"
  assert_grep "story-craft:$command" "$file" "command does not delegate to matching skill: $command"
done
assert_no_grep_tree 'story-migrate|story-cover|story-dashboard|story-short-analyze|story-short-scan' "$COMMANDS_DIR" "excluded command leaked into command definitions"
echo "  OK"

echo "TS5 commit hook self-gating"
commit_root="$TMP_DIR/commit-hook"
mkdir -p "$commit_root/正文" "$commit_root/设定"
write_story_project "$commit_root" "long"
setup_git_repo "$commit_root"
copy_hooks "$commit_root"
printf '# 第一章\n\n年龄: 18\n' > "$commit_root/正文/第0001章.md"
git -C "$commit_root" add 正文/第0001章.md

non_commit_out="$(cd "$commit_root" && CLAUDE_PROJECT_DIR="$commit_root" STORY_COMMIT_COMMAND='git status' bash .claude/hooks/validate-story-commit.sh 2>&1 || true)"
[ -z "$non_commit_out" ] || fail "validate-story-commit should be silent for non-commit command"

commit_out="$(cd "$commit_root" && CLAUDE_PROJECT_DIR="$commit_root" STORY_COMMIT_COMMAND='env FOO=1 git -C . commit -m demo' bash .claude/hooks/validate-story-commit.sh 2>&1 || true)"
echo "$commit_out" | grep -q 'Story Commit Warnings' || fail "validate-story-commit did not warn for git commit"
echo "$commit_out" | grep -q 'hardcoded character attributes' || fail "validate-story-commit did not inspect staged markdown"
echo "  OK"

echo "TS6 gap detection and sentinel parsing"
long_root="$TMP_DIR/long-gap"
mkdir -p "$long_root/正文"
write_story_project "$long_root" "long"
setup_git_repo "$long_root"
copy_hooks "$long_root"
printf '# 第一章\n' > "$long_root/正文/第0001章.md"
long_gap_out="$(run_hook "$long_root" detect-story-gaps.sh)"
echo "$long_gap_out" | grep -q '大纲/' || fail "long project gap detection did not require 大纲/ or contracts"

short_root="$TMP_DIR/short-gap"
mkdir -p "$short_root"
write_story_project "$short_root" "short"
setup_git_repo "$short_root"
copy_hooks "$short_root"
printf '# 正文\n' > "$short_root/正文.md"
short_gap_out="$(run_hook "$short_root" detect-story-gaps.sh)"
echo "$short_gap_out" | grep -q '小节大纲.md' || fail "short project gap detection did not require 小节大纲.md"

old_root="$TMP_DIR/old-deployment"
mkdir -p "$old_root"
write_story_project "$old_root" "long"
setup_git_repo "$old_root"
copy_hooks "$old_root"
python3 - "$old_root/.story/contracts/deployment.json" <<'PY'
import json
import sys

path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
data["agents_version"] = 8
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
PY
session_out="$(run_hook "$old_root" session-start.sh)"
echo "$session_out" | grep -q 'older than v9' || fail "session-start did not warn for stale agents_version"
echo "  OK"

echo "All story-craft deployment checks passed."
