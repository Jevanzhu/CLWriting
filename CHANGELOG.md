# 更新日志

本项目所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] - v1.0 重写进行中

v1.0 从零重写（Node + TypeScript），与 v0.2 Python 版无代码继承关系。

### 已完成

- **M0 仓库骨架**：npm 包 + bin 链路、TS 严格、tsup 构建、vitest、Node ≥24 门槛、纯 `node:sqlite` smoke、双平台 CI。
- **M1 格式层与缓存**：账本读写 / 缓存表 / 重建器 / 精准读取 / 文风境界章节 / book.yaml。
- **M2 写章脚本面**：机检规则 / 硬闸 / 输入预算闸 / 自愈打回 / 原子定稿（finalize）/ commit msg 规范。
- **M3 状态机 + git 隐身**（出口验收 9/9 达成）：
  - 状态机单入口（**7 态全落地**：git 体检 / 源文件解析 / 未入账手改 / 工作区未完成 / 卷末 / 体检周期 / 起草新章；判定顺序 + 路由 + 近况复述，含确认复述）；`clwriting enter` 进门体检 → 判态 → 路由。
  - git 隐身层（健康检查 4 异常：半提交 / 合并冲突 / 僵死锁 / 网盘副本残留；命令人话包装；commit msg 规范 + Confirmed trailer）。
  - 回滚「回到第 N 章」（`clwriting revert`）：备份再丢 + reset + 缓存重建 + 工作区清理，**定稿区 / .cache / 工作区三者一致**，可逆。
  - 手改对账：源文件修复确认（补 M1 占位）+ 未入账手改提议补登（已发布正文警示不强制拒）。
  - 影响分析：改设定产「已发布 / 未发布」两份影响清单 + 吃书检测（直接冲突标记）。
  - 体检周期闭环（态 6）：距上次体检 ≥ 30 章则到期提示；`clwriting health` 干净通过即记账消除提示（状态存 `.cache/health-check.json`，独立于 index.db 不受 rebuild 清空）。
  - **确认复述兜底**：进门复述上一章确认留痕；若工作区仍保留细纲则复核哈希并暴露不一致，若细纲已随定稿清理则明确标注「未复核」，不伪装成哈希一致。
  - **159 个测试全绿**（含 7 态端到端、git 异常样本库、三者一致回滚、兜底闭环、体检周期闭环）；运行时零第三方依赖。

### 评审修复（M3 收尾）

- 成长线机检动词错配修正（`跃迁` → 取 `LEAD_VERBS.成长线.resolve`，原硬编码致红项永不触发）。
- finalize 原子性补全：commit 失败时回滚定稿区（`reset` 清暂存 + `ls-tree HEAD` 判跟踪性，已跟踪 checkout / 新建 unlink），落地「失败则定稿区无变化」。
- `addCommit` 路径收窄：finalize 传显式路径避免 `add -A` 误纳工作区无关改动（保证「一 commit = 一章」）。
- `findChapterCommit` 去 `--all` 防备份 ref 误命中；确认哈希复用 `hashFile` 单源；正则与引号覆盖统一；版本号改读 `package.json` 单源；死代码清理。
- 性能基准：200 章 `enter()` 中位 58ms，全量 rebuild 无需优化。

### M4 AI 角色层 + 一级宿主（脚本层 + CC 真模型 smoke 出口达成，Codex smoke 手册就绪待跑）

- 脚本层第一批：补齐 `clwriting confirm` / `clwriting check` / `clwriting finalize` 薄门面，复用既有确认记录、机检、定稿原子 commit 硬闸。
- 每章 AI 调用预算闸落地：工作区 `.ai-calls.json` 记录本章已用次数，续跑继承，超限拒绝并给决策提示；定稿清空工作区时一并清理计数。
- 角色单源分发：`.clwriting/roles/*.md` 生成 Claude / Codex / 通用三套壳，写入壳 manifest，支持 source drift / output drift 检查（含壳部署格式硬闸）。
- 三审脚本契约：生成读者审 / 编辑审 / 设定校对三视角任务书，设定校对承接机检账本变动清单；审查档位支持满审 / 顺序审 / 合审的诚实降级；issue 聚合、证据硬闸与 blockers/warnings 归一化落地；`clwriting review plan` 输出档位与任务书。
- 三审执行落地（脚本编排与宿主执行分离）：`review run` 打包执行包供宿主按视角调模型，`review collect` 回收 issues JSON 归一化写审稿单；finalize 前置闸读作者裁决标记（HTML 注释锚定防误命中）；预算闸串联 review 记账。
- SessionStart 注入：新增 `clwriting session-start`，复用 `enter()` 结构化近况生成有界开场上下文。
- 知识层平移：正式 `知识层/` + `_manifest.json` 可复现清单 + `clwriting knowledge check` 校验入口；平移 oh-story MIT 素材精选速查（题材路由、章节钩子、节奏与升级感、反转设计、质量检查、人物与对话技法，共 6 篇速查 + 许可全文，13 条 manifest）。
- **真模型 smoke（CC 侧）达成**：建书 → 写 1 章 → 满审（降级顺序审，诚实声明）→ 定稿全程跑通；**账本造假（声明揭凶手但正文不写）被设定校对逮住 → 审稿单不成立 → 无裁决 finalize 拒绝 → 作者 override 放行**闭环在真模型下复现。详见 `Dev/Reviews/clwriting-v1-M4-真模型smoke记录-2026-06-18.md`。

### M4 收尾修复（smoke 暴露并修复）

- **tsup 打包致命 bug 修复**：tsup 默认 `nodeProtocolPlugin` 把 `node:sqlite` 改写成 bare `sqlite`（兼容 Node<14.18，见 tsup#1003），导致 dist 产物运行时崩 `Cannot find package 'sqlite'`。199 测试用 tsx 跑源码未暴露，真模型 smoke 才暴露。修复：`tsup.config.ts` 加 `removeNodeProtocol: false`（本项目门槛 Node≥24，原生支持 `node:` 协议）。
- **review 默认草稿路径 DX 修复**：`review run/collect` 原硬编码 `草稿-1.md`，第 N≠1 章必须显式传草稿路径。改为「显式参数 > 按 `--chapter=N` 推导 `草稿-N.md` > 回落 `草稿-1.md`」。

### 待跑（M4 唯一剩余出口）

- **Codex 真模型 smoke**：验证壳兼容（非 CC 专属语法）。手册见 smoke 记录第 6 节，待 Jevan 在 Codex 环境执行。

> **测试**：199 个测试全绿（27 文件）；`tsc --noEmit` 通过；`dependencies: {}` 运行时零第三方依赖。

> v0.2 Python 版（GPL-3.0）冻结为遗产，仅留在 `main` 分支修致命 bug。v1 在 `v1` 分支以 MIT 重新起步。

## [0.2.0] - 2026-06-13

首个公开发布（Python 版，GPL-3.0）。详见 `main` 分支历史。

[Unreleased]: https://github.com/Jevanzhu/CLWriting/tree/v1
[0.2.0]: https://github.com/Jevanzhu/CLWriting/releases/tag/v0.2.0
