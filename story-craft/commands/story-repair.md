---
description: 根据审查结果生成修复方案或执行修复链，完成后必须重新审查。
argument-hint: "<review-results> [draft-file]"
---

# /story-repair

定位当前故事项目，并读取 `project_type` 用于选择短篇或长篇修复边界。缺少审查结果时先提示用户补充。

委托到 `story-craft:story-repair`。该 Skill 负责按 severity 选择 rewrite / partial rewrite / polish，并强制复审。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
