---
name: story-long-analyze
description: 长篇项目分析 Skill，汇总进度、伏笔债、Strand 分布、质量趋势和合同覆盖风险。
allowed-tools: Read Grep Bash Agent
---

# story-long-analyze

## 目标

对长篇项目进行只读分析，输出项目级报告：进度、伏笔债、Strand 分布、质量趋势、合同覆盖和下一步风险。

## 充分性闸门

开始前必须满足：

- 项目根目录可定位。
- `.story/contracts/master.json` 存在。
- 至少存在章节合同、commit 或正文之一。

缺少合同或 commit 时仍可输出报告，但必须标记证据不足。

## 流程

1. 查询项目状态：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status
```

2. 查询记忆和质量趋势：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query memory

python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query quality
```

3. 按需查询实体关系和上下文：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query entity-graph

python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query context --chapter "${CHAPTER}"
```

4. 汇总 Strand 分布，并用 `tools.strand_calculator.evaluate_strand_balance` 判断 `quest 60% / fire 20% / constellation 20%` 是否偏离。
5. 输出报告：

- 当前进度和已完成章。
- 未回收伏笔债，按 urgency 分组。
- Strand 分布与诊断。
- 最近 reviewer blockers/warnings 趋势。
- 合同缺口：master、volume、chapter、review。
- 下一章写作风险。

## 写入边界

- 只读，不写 state、memory、commit、合同或正文。
- 不调用写作 Agent。
- 不生成新剧情事实。
- 可调用 `story-explorer` 做只读证据查询。

## 失败处理

- `query status` 失败：返回项目定位失败和下一步。
- `query memory` 失败：继续分析合同和正文，但标记记忆不可用。
- Strand 数据缺失：输出“没有可用叙事线数据”，不编造比例。

## CC 验证清单

- [ ] 能读取长篇合同和 commit。
- [ ] 能输出伏笔债、质量趋势和 Strand 诊断。
- [ ] 只读验证通过，无项目文件变更。

## 完成条件

输出一份只读分析报告，并明确列出“已确认事实 / 推断 / 证据不足”。
