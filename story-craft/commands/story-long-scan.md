---
description: 长篇项目只读一致性扫描入口，执行 placeholder、grep-first 和健康检查。
argument-hint: "[target-file-or-range]"
---

# /story-long-scan

先定位当前故事项目，并读取 `master.project_type` 或通过 `story_craft.py where` 确认项目根。

若当前 `project_type=short`，提示“当前为短篇项目，本命令仅适合长篇一致性扫描；请使用 `/story-review` 或 `/story-deslop`”，不要把命令物理隐藏。若 `project_type=long`，继续委托。

委托到 `story-craft:story-long-scan`。该 Skill 负责默认只读扫描；若用户要求修复，转入长篇写作修订流程。
