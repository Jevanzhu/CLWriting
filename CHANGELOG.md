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
  - **兜底闭环**：伪造确认 → 进门复述暴露 → 回滚推翻（第 4.3 节防伪）。
  - **159 个测试全绿**（含 7 态端到端、git 异常样本库、三者一致回滚、兜底闭环、体检周期闭环）；运行时零第三方依赖。

### 评审修复（M3 收尾）

- 成长线机检动词错配修正（`跃迁` → 取 `LEAD_VERBS.成长线.resolve`，原硬编码致红项永不触发）。
- finalize 原子性补全：commit 失败时回滚定稿区（`reset` 清暂存 + `ls-tree HEAD` 判跟踪性，已跟踪 checkout / 新建 unlink），落地「失败则定稿区无变化」。
- `addCommit` 路径收窄：finalize 传显式路径避免 `add -A` 误纳工作区无关改动（保证「一 commit = 一章」）。
- `findChapterCommit` 去 `--all` 防备份 ref 误命中；确认哈希复用 `hashFile` 单源；正则与引号覆盖统一；版本号改读 `package.json` 单源；死代码清理。
- 性能基准：200 章 `enter()` 中位 58ms，全量 rebuild 无需优化。

### 进行中

- **M4 AI 角色层 + 一级宿主**（**工单 #19 及子 spec #20-#24 已全部起草，待评审 / 待施工**）：
  - 脚本层第一批已启动：补齐 `clwriting confirm` / `clwriting check` / `clwriting finalize` 薄门面，复用既有确认记录、机检、定稿原子 commit 硬闸。
  - 每章 AI 调用预算闸基础落地：工作区 `.ai-calls.json` 记录本章已用次数，续跑继承，超限拒绝并给决策提示；定稿清空工作区时一并清理计数。
  - 角色单源分发脚本层启动：`.clwriting/roles/*.md` 可生成 Claude / Codex / 通用三套壳，写入壳 manifest，并支持 source drift / output drift 检查。
  - 三审脚本契约启动：生成读者审 / 编辑审 / 设定校对三视角任务书，设定校对承接机检账本变动清单；审查档位支持满审 / 顺序审 / 合审的诚实降级；issue 聚合、证据硬闸与 blockers/warnings 归一化落地；新增 `clwriting review plan` 薄门面输出本章审查档位与任务书。
  - SessionStart 注入脚本层启动：新增 `clwriting session-start`，复用 `enter()` 结构化近况生成给 AI 的有界开场上下文，包含当前态、路由、确认复述与本章调用余量；角色壳生成器同步提示 hook/无 hook 等价入口。
  - 知识层 manifest 骨架启动：新增正式 `知识层/` 最小目录、`_manifest.json` 可复现清单和 `clwriting knowledge check` 校验入口，检查素材存在、sha256、source/license 元信息与路径边界；第一批平移 oh-story MIT 素材速查（章节钩子、质量检查）与许可证说明。
  - 三审任务书单源（读者审 / 编辑审 / 设定校对），设定校对**账本清单驱动逐条核对**（不被降级稀释）。
  - 角色单源 → 三平台壳（Claude Code / Codex / 通用）+ drift check 防漂移。
  - 审查规格阶梯（默认满审三视角各独立 / 按宿主能力降级并诚实声明）+ 每章调用预算闸（`每章AI调用上限`）。
  - SessionStart 真实注入（复用 M3 `enter()` 库形态 + `Recap`）。
  - 知识层平移：v0.2 题材模板 / 追读力 / 爽点 / oh-story 方法论（MIT 署名随平移）。
  - M3 的桩全换真模型：写稿 / 三审 / 顺势圆 / 修复确认 / 复盘体检。
  - 出口：CC + Codex 各跑真模型 smoke（建书 → 写 1 章 → 分级审 → 定稿）；**账本造假被设定校对逮住**。

> v0.2 Python 版（GPL-3.0）冻结为遗产，仅留在 `main` 分支修致命 bug。v1 在 `v1` 分支以 MIT 重新起步。

## [0.2.0] - 2026-06-13

首个公开发布（Python 版，GPL-3.0）。详见 `main` 分支历史。

[Unreleased]: https://github.com/Jevanzhu/CLWriting/tree/v1
[0.2.0]: https://github.com/Jevanzhu/CLWriting/releases/tag/v0.2.0
