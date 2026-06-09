---
description: 长篇项目只读分析入口，检查伏笔债、Strand 分布、质量和记忆状态。
argument-hint: "[chapter|range|focus]"
---

# /story-long-analyze

先定位当前故事项目，并读取 `master.project_type` 或通过 `story_craft.py where` 确认项目根。

若当前 `project_type=short`，提示“当前为短篇项目，本命令仅适合长篇结构分析”，不要把命令物理隐藏，也不要写入任何状态。若 `project_type=long`，继续委托。

委托到 `story-craft:story-long-analyze`。该 Skill 负责只读分析，不写 state、memory、commit、合同或正文。
