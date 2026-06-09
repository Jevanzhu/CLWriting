---
description: 导入外部 txt、md、docx 或既有作品材料，重建可用合同和投影。
argument-hint: "<source-file-or-dir>"
---

# /story-import

定位当前故事项目，并读取 `project_type` 决定导入后的合同重建口径。未初始化时，提示先执行 `/story-init` 或明确允许补建基础合同。

委托到 `story-craft:story-import`。该 Skill 负责只采用抽象技法和可迁移结构，不复制原作事实。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
