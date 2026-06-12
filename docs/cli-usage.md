# 终端 CLI 使用说明

终端命令是底层工具入口，主要用于调试、冒烟验证、脚本化运维，或在 Skill 流程中被调用。

## 基本入口

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
python3 -X utf8 story-craft/scripts/story_craft.py preflight --format json
```

全局参数 `--project-root` 必须放在子命令前，例如：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query status
```

## 子命令一览

当前共有 20 个顶层子命令：

- `where`：打印当前解析到的故事项目根目录。
- `preflight`：检查 CLI、插件目录和项目定位状态。
- `use`：把当前 Claude 工作区绑定到指定故事项目。
- `init`：初始化一个故事项目，可写入 `project_type=short|long`。
- `plan`：生成或刷新短中篇总纲和章节合同。
- `write`：验收一章草稿并更新故事记忆，可写成 `write N`。
- `agent`：生成 Agent 所需的任务书、修复计划、润色计划或兜底 delta。
- `review`：把 reviewer JSON 转为 Markdown 审查报告，可写成 `review N`。
- `rebuild-views`：从 commit 真源幂等重建全部投影。
- `learn`：记录可复用写作经验；`--source` 区分来源（`manual` 人工 / `auto-review` 审查提炼 / `auto-style` 风格漂移 / `import` 参考拆解），`--importance` 标重要度，同类经验自动去重合并；`--forget <id>` 停用过时经验（软删除，可恢复，注入时按重要度+新近度排序并按上限截断）。
- `query`：查询状态、上下文、记忆、学习记录（`learning` 已入库 / `learning-suggestions` 从审查历史自动提炼候选）、章节影响、索引、实体图和质量趋势。
- `index`：重建项目记忆索引。
- `backup`：创建项目备份。
- `health`：运行故事项目健康检查。
- `outline-revision`：生成中期大纲修正建议。
- `chapter-commit`：通过现有验收链路写入 chapter-commit 真源。
- `deslop`：运行 6-Gate 去 AI 味检测，支持 `.deslop-whitelist`。
- `repair`：根据 reviewer JSON 生成三段式修复强度计划。
- `placeholder-scan`：扫描文本占位符。
- `import`：解析外部 txt/md/docx 作品章节。

## 创建调试项目

```bash
python3 -X utf8 story-craft/scripts/story_craft.py init /tmp/story-demo 暗室来信 悬疑 \
  --project-type short \
  --word-count-target 30000 \
  --sub-genre 都市悬疑 \
  --synopsis "法医收到亡友留下的空白来信，追查旧楼暗室真相。" \
  --protagonist-name 林墨 \
  --protagonist-desire "查清亡友死因" \
  --unique-advantage-desc "法医病理学和现场痕迹阅读" \
  --world-setting "近现代城市，线索必须能由物证、证词或行动记录回溯。"
```

也可以把初始化参数放入 JSON 配置文件，并用命令行参数覆盖同名字段：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py init \
  --from-config /tmp/story-demo-init.json \
  --project-type long \
  --protagonist-name 林墨
```

`--project-type` 可取 `short` 或 `long`。显式传入时会写入 `.story/contracts/master.json`，供双轨运行时读取。

## 绑定工作区

```bash
python3 -X utf8 story-craft/scripts/story_craft.py use /tmp/story-demo
python3 -X utf8 story-craft/scripts/story_craft.py where
```

`use` 会写入当前 Claude 工作区的项目指针；`where` 用于确认当前解析到的故事项目根。

## 规划与写作

短中篇规划调试：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo plan --chapter-count 8
```

工作台冒烟：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent workflow \
  --chapter 1 \
  --output-file /tmp/story-demo/.story/workflows/ch_01/manifest.json
```

本地兜底任务书与 delta：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent brief \
  --chapter 1 \
  --output-file /tmp/story-demo/.story/workflows/ch_01/brief.json

python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent extract \
  --chapter 1 \
  --chapter-file /tmp/story-demo/.story/workflows/ch_01/draft.md \
  --output-file /tmp/story-demo/.story/workflows/ch_01/delta.json
```

正式写入 commit 真源：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo chapter-commit \
  1 \
  --draft-file /tmp/story-demo/.story/workflows/ch_01/draft.md \
  --review-results /tmp/story-demo/.story/workflows/ch_01/review.json \
  --require-review \
  --delta-file /tmp/story-demo/.story/workflows/ch_01/delta.json \
  --result-file /tmp/story-demo/.story/workflows/ch_01/write-result.json
```

`write 1` 可用于验收一章草稿并更新故事记忆；`chapter-commit` 是阶段 3 后更明确的真源写入入口。使用 `--strict-warnings` 可把字数偏差 warning 也视为阻断；使用 `--require-review` 可强制要求 reviewer JSON，缺失时不会启用本地轻量兜底。

真实 `/story-short-write` 或 `/story-long-write` 流程应优先使用 `.story/workflows/ch_NN/` 下的 `manifest.json`、`brief.json`、`draft.md`、`review.json`、`delta.json` 等固定文件，并提供 reviewer 输出。直接调用 CLI 且不传 `--review-results` 时，默认只执行本地轻量兜底，结果会标记 `review_status=skipped`，commit 会记录 `review_meta.source=fallback`。CLI 的 `agent brief` / `agent extract` 是本地兜底和冒烟验证工具，不替代真实 Agent 输出。

## 审查

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> review \
  1 \
  --review-results <review.json> \
  --chapter-file <正文.md> \
  --report-file <报告.md>
```

推荐使用 `review 1`。`reviewer` 原始 JSON 必须包含 `issues` 数组和 `summary` 字符串；`S1/S2`、`blocking=true` 或 `severity=critical` 会被本地视为阻断。

## 修复与去 AI 味

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> deslop \
  --draft-file <草稿.md> \
  --whitelist-file <项目>/.deslop-whitelist \
  --output-file <工作台>/deslop.json

python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> repair \
  --chapter 1 \
  --review-results <review.json> \
  --draft-file <草稿.md> \
  --output-file <工作台>/repair-plan.json

python3 -X utf8 story-craft/scripts/story_craft.py placeholder-scan <草稿.md>
```

`repair` 根据 severity 数量生成 `complete_rewrite`、`partial_rewrite` 或 `polish_only`。修复后必须重新 reviewer，不得跳过复审。

## 查询与维护

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> rebuild-views
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> rebuild-views --only summary
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query status
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query memory
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query context --chapter 2
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query quality
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query index --text "纸条"
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query semantic --text "监控黑屏" --kind scene
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query impact --chapter 3
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query impact --chapter 3 --format markdown
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query entity-graph
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query ranked-context --chapter 12 --budget 20
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query learning
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query learning-suggestions --min-occurrences 2 --min-chapters 2
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> index
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> backup --label 阶段备份
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> health
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> outline-revision --chapter 6 --note "剧情需要转折"
python3 -X utf8 story-craft/scripts/story_craft.py import --source <外部作品.txt>
```

`rebuild-views` 会从 `.story/commits/` 重放 accepted commits，重建 `state`、`memory`、`summary`、`index`、`vector` 和 `markdown_view`。短篇项目可 lazy 跳过 `index/vector`。

`query semantic` 使用 vector/BM25/RAG 检索；缺少可用 vector 索引时会降级到 memory index，并在 `next_steps` 提示 `rebuild-views --only vector`。

`query impact --chapter N` 只读分析目标章的 commit 真源、角色、伏笔、时间线和后续章节引用，用于改稿前判断需要同步复查的范围。追加 `--format markdown` 可输出面向人工改稿的复查清单。

`health` 输出包含项目状态摘要、RAG 状态和运行时诊断。`deslop`、顶层 `repair` 和 `import` 是确定性工具层；Claude Code 里的交互式 Skill 编排仍需按 CC 验证清单单独验证。
