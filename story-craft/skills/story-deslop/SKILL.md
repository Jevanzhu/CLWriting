---
name: story-deslop
description: 独立去 AI 味 Skill，对草稿执行 6-Gate 量化检查，结合 .deslop-whitelist 输出只读诊断和修订建议。
allowed-tools: Read Grep Bash
---

# story-deslop

## 目标

对指定草稿或章节执行去 AI 味检查。Skill 只做诊断和建议，不直接改正文；量化部分复用 `tools.deslop_metrics.analyze_deslop_metrics`，命令入口使用 `deslop --draft-file`。

## 充分性闸门

开始前必须满足：

- `project_root` 明确。
- `draft_file` 或章节正文路径存在且非空。
- 如需项目级豁免，读取项目根目录下的 `.deslop-whitelist`。
- 用户明确要求修改正文时，必须转入 `/story-repair` 或对应写作链，不在本 Skill 内直接写正文。

## 6-Gate

- Gate A 禁用词：检测高频 AI 味词、套话、抽象形容词和项目禁用词。
- Gate B 句式：检测连续排比、同构句、过度总结式句群。
- Gate C 心理外化：检测内心判断外露、直接解释情绪、替读者下结论。
- Gate D 节奏：检测段落过长、平均句数异常、动作与信息密度失衡。
- Gate E 对话：检测对话标签密度、解释性对白、角色声音趋同。
- Gate F 结尾：检测段尾总结、章节尾升华、模板化悬念句。

`.deslop-whitelist` 只允许豁免项目专名、固定术语、角色口癖和刻意重复。白名单不能豁免整类 Gate，也不能用于跳过 reviewer 阻断项。

## 流程

1. 定位草稿文件。优先使用用户给定路径；没有路径时按章节号查找当前草稿或正文。
2. 读取 `.deslop-whitelist` 并执行 6-Gate：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" deslop \
  --draft-file "${DRAFT_FILE}" \
  --whitelist-file "${PROJECT_ROOT}/.deslop-whitelist" \
  --output-file "${WORKFLOW_DIR}/deslop.json"
```

3. 输出 6-Gate 结果：

- `gate`：A-F。
- `level`：none/light/medium/heavy。
- `evidence`：命中的短句或位置。
- `suggestion`：可执行修订建议。
- `whitelisted`：是否被 `.deslop-whitelist` 豁免。

4. 对 heavy 或 medium 项按风险排序，给出最小修订清单。
5. 如用户要求自动修复，转入 `/story-repair`，并把 deslop 结果作为 reviewer JSON 之外的辅助输入。

## 写入边界

- 默认只读。
- 不写 state、memory、commit、合同或正文。
- 不写正文、合同、commit、state、memory 或投影。
- 不调用 Agent。
- 不执行 `chapter-commit` 或 `rebuild-views`。
- 只允许读取 `.deslop-whitelist`；不得自动创建或修改该文件。

## 失败处理

- 草稿缺失或为空：停止并提示有效路径。
- `.deslop-whitelist` 不存在：继续执行，标注未加载项目级豁免。
- 6-Gate 输出异常：停止，不生成伪诊断。
- 命中大量 heavy：建议先 `/story-repair`，再重新 `/story-deslop`。

## CC 验证清单

- [ ] Claude Code 中 `/story-deslop` 能读取用户指定草稿。
- [ ] `.deslop-whitelist` 的豁免能在报告中标注。
- [ ] 6-Gate heavy/medium/light 能正确展示给用户。
- [ ] 用户选择修复时能转入 `/story-repair`，且本 Skill 不直接写正文。

## 完成条件

输出 6-Gate 去 AI 味报告、白名单命中说明、阻断级别和下一步建议：无需处理、人工微调、转入 `/story-repair` 或回到写作链复审。

## 参考加载表

- fallback rubric：`references/shared/review/fallback-rubric.md`
- 核心约束：`references/shared/core-constraints.md`
- 命名语调：`references/shared/naming-and-voice-gaps.md`
