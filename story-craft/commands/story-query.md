---
description: 只读查询故事状态、合同、记忆、学习记录、题材资料或质量信息。
argument-hint: "<status|context|memory|learning|genres|quality> [参数]"
---

# /story-query

定位当前故事项目，并读取 `project_type` 作为查询上下文。查询命令不得写入 state、memory、commit、合同或正文。

委托到 `story-craft:story-query`。该 Skill 负责 ContractStore、CommitStore、memory、learning 和 references 只读查询。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
