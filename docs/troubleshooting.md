# 故障排查

## 验收闸门

`write` 会在验收前执行这些检查：

- 项目已完成 `init` 和 `plan`。
- 目标章节存在于 `大纲/总纲.md`。
- 第 2 章及以后必须存在上一章 accepted 验收记录。
- 正文不能包含 `[TODO]`、`[待定]`、`[XXX]` 等占位符。
- 实际字数低于本章规划字数 60% 会阻断验收。
- 实际字数低于 80% 或高于 135% 会返回 warning。使用 `--strict-warnings` 时 warning 也视为阻断。
- reviewer JSON 中存在 blocking issue 时，章节记录为 rejected，不写入 `正文/`，不更新 `memory.json` / `state.json`。
- `stage=warnings` 且启用 `--strict-warnings` 时，同样不写入 `正文/`、`审查报告/` 或验收记录。

`write` 输出中的 `word_count_check` 会展示计划字数、实际字数、阈值和比例。

## 常见问题

- 找不到项目根目录：使用 `--project-root <项目>`，项目内必须有 `.story/state.json`。全局参数要放在子命令前，例如 `story_craft.py --project-root <项目> query status`。
- 第 2 章无法写：确认第 1 章已经通过 `write` 验收，且记录状态为 `accepted`。
- 字数不足：查看 `write` 输出中的 `word_count_check`，按 `planned_words` 扩写。
- reviewer 阻断：先运行 `agent repair`，按 `blocker_actions` 修复后重新审查。
- reviewer JSON 被拒绝：确认顶层包含 `issues` 数组和 `summary` 字符串；不要把 `passed`、`blockers`、`warnings` 当作原始输入字段。
- delta 缺失：可以先用 `agent extract` 生成兜底 delta，再人工补充角色、伏笔和状态变化。
- 路径含空格：CLI 命令和 manifest 中的路径已做 shell quoting，可直接使用。
- 可选依赖缺失：`filelock` 不可用时会降级为无锁写入，`maintain health` 的 `runtime` 字段会显示降级提示。
- 中期需要修改大纲：运行 `maintain outline-revision --chapter N --note "修改原因"` 生成修正建议。

## 工作台恢复

`.story/workflows/ch_NN/` 缺失文件时，按缺失文件补跑对应步骤：

- 缺 `manifest.json`：重新运行 `agent workflow --chapter N`。
- 缺 `brief.json`：重新调用 `context-agent`，或仅做冒烟时运行 `agent brief --chapter N`。
- 缺 `draft.md`：根据 `brief.json` 重新起草正文。
- 缺 `review.json`：重新调用 `reviewer`。
- 缺 `repair.json`：运行 `agent repair --chapter N`。
- 缺 `polish.json`：运行 `agent polish --chapter N`。
- 缺 `delta.json`：重新调用 `data-agent`，或仅做冒烟时运行 `agent extract --chapter N`。
- 缺 `write-result.json`：确认前置文件齐全后重新运行 `write N`。

## 健康检查

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain health
```

输出包含项目状态摘要和运行时诊断（Python 版本、平台、`filelock` 可用性）。
