---
description: 将用户确认的写作模式、反模式或项目经验写入学习记录。
argument-hint: "<pattern-type> <内容>"
---

# /story-learn

定位当前故事项目，并读取 `project_type` 判断学习记录适用轨道：短篇、长篇或 shared。缺少明确适用范围时先追问。

委托到 `story-craft:story-learn`。该 Skill 负责只写 `.story/project_learning.json`，不改正文或合同。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
