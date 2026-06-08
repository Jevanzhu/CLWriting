---
name: story-short-analyze
description: 短篇分析 Skill，只读分析短篇结构、情绪曲线、反转链、AI 味和结尾回响。
allowed-tools: Read Grep Bash Agent
---

# story-short-analyze

## 目标

对短篇项目或短篇草稿做只读分析，输出结构压缩、情绪曲线、反转链、读者牵引、AI 味和结尾回响报告。

## 充分性闸门

开始前必须满足：

- 项目或目标文本可读。
- 目标范围明确：全篇、某章、草稿或导入文本。
- 若是项目分析，优先确认 `project_type=short`。

范围不明确时先询问。

## 流程

1. 读取短篇合同和正文：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status

python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query memory
```

2. 分析结构：

- 开篇问题。
- 铺垫信息。
- 升级压力。
- 反转/揭示。
- 收束和余韵。

3. 分析情绪曲线：情绪起点、压迫点、爆点、转折点、结尾回响。
4. 检查反转链：线索公平性、误导合法性、回收是否成立。
5. 使用 `tools.deslop_metrics.analyze_deslop_metrics` 读取 6-Gate AI 味指标。
6. 输出短篇分析报告，并明确“已确认事实 / 推断 / 证据不足”。

## 写入边界

- 只读，不写 state、memory、commit、合同或正文。
- 不生成新剧情事实。
- 不调用 `narrative-writer`。
- 若用户要求修复，转入 `/story-short-write` repair loop 或后续 `story-repair`。

## 失败处理

- 项目不可定位：返回定位失败和下一步。
- 正文缺失：只分析合同和草稿，标记证据不足。
- 6-Gate 不可用：继续结构分析，并标记 AI 味量化未完成。

## CC 验证清单

- [ ] 能分析短篇项目。
- [ ] 能分析单篇草稿。
- [ ] 输出含结构、情绪、反转、AI 味和结尾回响。
- [ ] 全程只读。

## 完成条件

输出短篇分析报告，列出 blocker、warning 和可选优化项。
