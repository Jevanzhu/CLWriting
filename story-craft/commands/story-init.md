---
description: 初始化或刷新 story-craft 项目，写入 project_type 合同并部署 Claude Code 运行时资产。
argument-hint: "[short|long] [项目路径]"
---

# /story-init

定位当前故事项目；如未初始化，则按用户确认的信息创建项目并写入 `master.project_type`。

委托到 `story-craft:story-init`。该 Skill 负责充分性追问、`init` CLI 调用、自部署、升级重部署和多项目 `use` / `where` 收口。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
