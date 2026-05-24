# 终端 CLI 使用说明

终端命令是底层工具入口，主要用于调试、冒烟验证、脚本化运维，或在 Skill 流程中被调用。

## 基本入口

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
python3 -X utf8 story-craft/scripts/story_craft.py preflight --format json
```

本项目不提供独立的 `story-craft <subcommand>` wrapper。
全局参数 `--project-root` 必须放在子命令前，例如：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query status
```

## 子命令一览

| 子命令 | 用途 |
|--------|------|
| `where` | 打印当前解析到的故事项目根目录 |
| `preflight` | 检查 CLI、插件目录和项目定位状态 |
| `use` | 把当前 Claude 工作区绑定到指定故事项目 |
| `init` | 初始化一个故事项目 |
| `plan` | 生成或刷新故事总纲 |
| `write N` | 验收一章草稿并更新故事记忆 |
| `agent` | 生成 Agent 所需的任务书、修复计划、润色计划或兜底 delta |
| `review N` | 把 reviewer JSON 转为 Markdown 审查报告 |
| `learn` | 记录可复用写作经验 |
| `query` | 查询状态、上下文、记忆、学习记录、索引、实体图和质量趋势 |
| `maintain` | 运行索引、备份、健康检查等维护任务 |

## 创建调试项目

```bash
python3 -X utf8 story-craft/scripts/story_craft.py init /tmp/story-demo 暗室来信 悬疑 \
  --word-count-target 30000 \
  --sub-genre 都市悬疑 \
  --synopsis "法医收到亡友留下的空白来信，追查旧楼暗室真相。" \
  --protagonist-name 林墨 \
  --protagonist-desire "查清亡友死因" \
  --unique-advantage-desc "法医病理学和现场痕迹阅读" \
  --world-setting "近现代城市，线索必须能由物证、证词或行动记录回溯。"
```

## 绑定工作区

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo use
```

## 规划与写作

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo plan --chapter-count 8

python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent workflow \
  --chapter 1 \
  --output-file /tmp/story-demo/.story/workflow-ch1.json

python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent brief \
  --chapter 1 \
  --output-file /tmp/story-demo/.story/brief-ch1.json

python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo agent extract \
  --chapter 1 \
  --chapter-file /tmp/story-demo/.story/draft-ch1.md \
  --output-file /tmp/story-demo/.story/delta-ch1.json

python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo write \
  1 \
  --draft-file /tmp/story-demo/.story/draft-ch1.md \
  --review-results /tmp/story-demo/.story/review-ch1.json \
  --delta-file /tmp/story-demo/.story/delta-ch1.json \
  --result-file /tmp/story-demo/.story/write-result-ch1.json
```

`write --chapter 1` 仍兼容；推荐使用 `write 1`。`--result-file` 可选，用于把验收结果保存成 JSON，便于工作台恢复。使用 `--strict-warnings` 可把字数偏差警告也视为阻断。

真实 `/story-write` 流程应优先使用 `.story/workflows/ch_NN/` 下的 `manifest.json`、`brief.json`、`draft.md`、`review.json`、`delta.json` 等固定文件；CLI 的 `agent brief` / `agent extract` 是本地兜底和冒烟验证工具，不替代真实 Agent 输出。

## 审查

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> review \
  1 \
  --review-results <review.json> \
  --chapter-file <正文.md> \
  --report-file <报告.md>
```

`review --chapter 1` 仍兼容；推荐使用 `review 1`。
`reviewer` 原始 JSON 必须包含 `issues` 数组和 `summary` 字符串；`blocking=true` 或 `severity=critical` 会被本地视为阻断。

## 记录经验

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> learn \
  --chapter 1 \
  --pattern-type hook \
  --description "开篇异常进入得更快" \
  --instruction "后续章节前300字内必须出现行动或异常"
```

查询已有经验：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query learning
```

## 查询与维护

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query status
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query memory
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query context --chapter 2
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query quality
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query index --text "纸条"
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query entity-graph
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query ranked-context --chapter 12 --budget 20
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query learning
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain index
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain backup --label 阶段备份
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain health
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain outline-revision --chapter 6 --note "剧情需要转折"
```

`maintain health` 输出包含项目状态摘要和运行时诊断（Python 版本、平台、可选依赖可用性）。
