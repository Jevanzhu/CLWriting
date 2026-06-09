---
description: 对草稿执行 6-Gate 去套路化量化检查，默认只读输出问题和建议。
argument-hint: "<draft-file>"
---

# /story-deslop

定位当前故事项目，并读取 `project_type` 作为报告上下文。输入必须指向待检查草稿或正文片段。

委托到 `story-craft:story-deslop`。该 Skill 负责 6-Gate 检查、白名单处理和只读边界。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
