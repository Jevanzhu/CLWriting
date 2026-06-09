# 故障排查

## 写前闸门

`/story-preflight` 和写作链会在进入正文前检查：

- 项目根目录可定位，且存在 `.story/state.json`。
- `.story/contracts/master.json` 存在，并包含 `project_type=short|long`。
- 目标章节存在 `.story/contracts/chapters/chapter_NNN.json` 章节合同。
- 长篇项目按需存在 `.story/contracts/volumes/volume_NNN.json`。
- 第 2 章及以后必须存在上一章 accepted commit 或验收记录。
- 正文不能包含 `[TODO]`、`[待定]`、`[XXX]` 等占位符。
- reviewer JSON 中存在 S1/S2、`blocking=true` 或 critical issue 时，不进入 commit。

`write` 输出中的 `word_count_check` 会展示计划字数、实际字数、阈值和比例。低于规划字数 60% 会阻断；低于 80% 或超出 135% 会返回 warning；使用 `--strict-warnings` 时 warning 也视为阻断。

## 常见问题

- 找不到项目根目录：使用 `--project-root <项目>`，项目内必须有 `.story/state.json`。全局参数要放在子命令前，例如 `story_craft.py --project-root <项目> query status`。
- master contract 缺失：重新执行 `/story-init`，或用 `init --project-type short|long` 写入 `.story/contracts/master.json`。
- project_type 缺失：停止，不要猜测轨道；补 master contract 后再继续。
- 章节合同缺失：短篇先补短篇规划或导入合同；长篇先运行 `/story-long-plan`。
- 长篇 volume 缺失：补 `.story/contracts/volumes/volume_NNN.json`，不要用总纲文字替代。
- 第 2 章无法写：确认第 1 章存在 accepted commit，路径形如 `.story/commits/chapter_NNN.commit.json`。
- 字数不足：查看 `word_count_check`，按 `planned_words` 扩写。
- reviewer 阻断：运行 `/story-repair`，修复后必须重新 `/story-review`。
- reviewer JSON 被拒绝：确认顶层包含 `issues` 数组和 `summary` 字符串，不要把 `passed`、`blockers`、`warnings` 当作原始输入字段。
- delta 缺失：重新调用 `data-agent`，或仅冒烟时用 `agent extract` 生成兜底 delta。
- 路径含空格：CLI 命令和 manifest 中的路径已做 shell quoting，可直接使用。

## 短篇退化

短篇项目的正常降级行为：

- 无 `volumes/` 不阻断。
- reviewer 默认 `solo` mode。
- `style_fingerprint` 可选。
- `index/vector` 默认 lazy，首次 query、semantic、graph 或 rebuild 时补建。
- 不执行 Git 备份。

如果短篇写作被 volume 缺失阻断，应检查当前是否误走 `/story-long-write` 或 master contract 的 `project_type` 是否写错。

## 长篇场景

长篇 `/story-long-write` 依赖 5 个场景路由：

- `daily_continue`：上一章 accepted commit 存在，下一章合同存在。
- `major_revision`：用户要求修订既有章节，必须有目标草稿或 commit。
- `new_volume`：新卷开始，必须有 volume/chapter 合同。
- `open_book`：开书首章，master 和第 1 章合同必须存在。
- `import_external`：导入外部作品后继续，必须保留导入解析结果和合同重建摘要。

场景路由不满足时，先补合同、commit 或导入产物，不要让正文反写真源。

## 工作台恢复

`.story/workflows/ch_NN/` 缺失文件时，按缺失文件补跑对应步骤：

- 缺 `manifest.json`：重新运行 `agent workflow --chapter N`。
- 缺 `brief.json`：重新调用 `context-agent`，或仅冒烟时运行 `agent brief --chapter N`。
- 缺 `draft.md`：根据 `brief.json` 重新起草正文。
- 缺 `review.json`：重新调用 `reviewer`。
- 缺 `repair.json`：运行 `/story-repair` 或 `agent repair --chapter N`。
- 缺 `polish.json`：运行 `agent polish --chapter N`。
- 缺 `delta.json`：重新调用 `data-agent`，或仅冒烟时运行 `agent extract --chapter N`。
- 缺 `write-result.json`：确认前置文件齐全后重新运行 `chapter-commit`。

## 投影重建

commit 真源存在但 read-model 异常时，运行：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> rebuild-views
```

也可以只重建某个投影：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> rebuild-views --only summary
```

6 个投影是 `state`、`memory`、`summary`、`index`、`vector`、`markdown_view`。如果 `vector` 因嵌入能力不可用跳过，检索会降级到 BM25 或 LIKE，不阻断短篇写作。

## 健康检查

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> health
```

输出包含项目状态摘要和运行时诊断。可选依赖缺失时应显示降级提示，而不是伪装为完整能力可用。
