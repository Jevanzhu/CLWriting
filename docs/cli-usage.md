# 终端 CLI 使用说明

终端命令是底层工具入口，主要用于调试、冒烟验证、脚本化运维，或在 Skill 流程中被调用。

## 基本入口

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
python3 -X utf8 story-craft/scripts/story_craft.py preflight --format json
```

本项目不提供独立的 `story-craft <subcommand>` wrapper。

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

## 规划与写作

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo plan --chapter-count 8

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

`write --chapter 1` 仍兼容；推荐使用 `write 1`。
`--result-file` 可选，用于把提交结果保存成 JSON，便于工作台恢复。

## 审查

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> review \
  1 \
  --review-results <review.json> \
  --chapter-file <正文.md> \
  --report-file <报告.md>
```

`review --chapter 1` 仍兼容；推荐使用 `review 1`。

## 查询与维护

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query memory
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query quality
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query ranked-context --chapter 12 --budget 20
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain index
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain backup --label 阶段备份
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> maintain health
```
