---
name: story-init
description: 初始化 story-craft 中文短篇/中篇小说项目。用于用户要创建新故事、收集故事核/角色/独特优势/世界观/创作约束，并生成 .story/state.json、memory.json、设定集和总纲初稿时。
---

# story-init

## 目标

创建一个可被 story-craft 后续 plan/write/review 使用的故事项目。

## 充分性闸门

执行 `init` 前必须确认：

- 书名、题材、目标字数、一句话梗概、核心冲突完整。
- 主角姓名、主角欲望、主角缺陷完整。
- 独特优势的类型、风格、可见度、代价完整。
- 世界观至少有时代背景、地理范围、1 条核心规则。
- 创作约束包已确定：反套路、至少 2 条硬约束、结局约束、主题句。

信息不足时先继续追问，不要调用脚本。

## 流程

1. 预检项目目录和脚本入口：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" preflight --format json
```

2. 询问灵感来源：原创、参考短篇、作家风格。
3. 如果用户提供参考文本路径或摘录，可调用 `deconstruction-agent`。只采用其可迁移模式，不能复制原作事实。
4. 收集故事基本信息、角色、独特优势、世界观。
5. 生成 2 套创作约束候选，要求用户选择或修改。
6. 展示最终初始化摘要，等待用户确认。
7. 用户确认后执行：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" init "${PROJECT_ROOT}" "${TITLE}" "${GENRE}" \
  --word-count-target "${WORD_COUNT_TARGET}" \
  --sub-genre "${SUB_GENRE}" \
  --synopsis "${SYNOPSIS}" \
  --protagonist-name "${PROTAGONIST_NAME}" \
  --protagonist-desire "${PROTAGONIST_DESIRE}" \
  --protagonist-flaw "${PROTAGONIST_FLAW}" \
  --unique-advantage-type "${UNIQUE_ADVANTAGE_TYPE}" \
  --unique-advantage-desc "${UNIQUE_ADVANTAGE_DESC}" \
  --unique-advantage-style "${UNIQUE_ADVANTAGE_STYLE}" \
  --unique-advantage-visibility "${UNIQUE_ADVANTAGE_VISIBILITY}" \
  --unique-advantage-cost "${UNIQUE_ADVANTAGE_COST}" \
  --golden-finger "${GOLDEN_FINGER}" \
  --antagonist-mirror "${ANTAGONIST_MIRROR}" \
  --world-setting "${WORLD_SETTING}"
```

8. 验证关键文件存在：`.story/state.json`、`.story/memory.json`、`.story/project_learning.json`、`大纲/总纲.md`、`设定集/世界观.md`、`设定集/主角卡.md`、`设定集/独特优势.md`。

## 失败处理

- 关键文件缺失：只重跑 `init` 或补写缺失文件，不删除项目目录。
- 参考分析质量不足：展示风险，不写入 canon。
- 用户未确认最终摘要：停止，不执行初始化。

## 完成条件

输出项目根路径、已生成文件清单、下一步建议 `/story-plan`。
