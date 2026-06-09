---
description: 长篇项目规划入口，生成 master、volume、chapter 合同和长篇大纲。
argument-hint: "[卷号|章节范围|规划目标]"
---

# /story-long-plan

先定位当前故事项目，并读取 `master.project_type` 或通过 `story_craft.py where` 确认项目根。

若当前 `project_type=short`，提示“当前为短篇项目，不需要长篇卷/章规划；请使用 `/story-short-write` 或先重新 `/story-init`”，不要把命令物理隐藏。若 `project_type=long`，继续委托。

委托到 `story-craft:story-long-plan`。该 Skill 负责 story-architect、character-designer 和合同写入前确认。
