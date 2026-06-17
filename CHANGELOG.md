# 更新日志

本项目所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] - v1.0 重写进行中

v1.0 从零重写（Node + TypeScript），与 v0.2 Python 版无代码继承关系。

### 进行中

- **M0 仓库骨架**：npm 包 + bin 链路、TS 严格、tsup 构建、vitest、Node ≥24 门槛、纯 `node:sqlite` smoke、双平台 CI。
- **M1 格式层与缓存**：账本读写 / 缓存表 / 重建器 / 精准读取 / 文风境界章节 / book.yaml。
- **M2 写章脚本面**：机检规则 / 硬闸 / 输入预算闸 / 自愈打回 / 原子定稿（finalize）/ commit msg 规范。
- **M3 状态机 + git 隐身**：
  - 状态机单入口（7 态判定顺序 + 路由 + 近况复述，含确认复述）；`clwriting enter` 进门体检 → 判态 → 路由。
  - git 隐身层（健康检查 4 异常：半提交 / 合并冲突 / 僵死锁 / 网盘副本残留；命令人话包装；commit msg 规范 + Confirmed trailer）。
  - 回滚「回到第 N 章」（`clwriting revert`）：备份再丢 + reset + 缓存重建 + 工作区清理，**定稿区 / .cache / 工作区三者一致**，可逆。
  - 手改对账：源文件修复确认（补 M1 占位）+ 未入账手改提议补登（已发布正文警示不强制拒）。
  - 影响分析：改设定产「已发布 / 未发布」两份影响清单 + 吃书检测（直接冲突标记）。
  - **兜底闭环**：伪造确认 → 进门复述暴露 → 回滚推翻（第 4.3 节防伪）。
  - 152 个测试全绿（含 7 态端到端、git 异常样本库、三者一致回滚、兜底闭环）；运行时零第三方依赖。
- **M4 AI 角色层 + 一级宿主**（**工单已起草 ⑲，子 spec ⑳㉑㉒㉓㉴ 待拆**）：
  - 三审任务书单源（读者审 / 编辑审 / 设定校对），设定校对**账本清单驱动逐条核对**（不被轻审稀释）。
  - 角色单源 → 三平台壳（Claude Code / Codex / 通用）+ drift check 防漂移。
  - 审查分级（默认轻审 / 风险章重审 ×3 / 过渡一审）+ 每章调用预算闸（`每章AI调用上限`）。
  - SessionStart 真实注入（复用 M3 `enter()` 库形态 + `Recap`）。
  - 知识层平移：v0.2 题材模板 / 追读力 / 爽点 / oh-story 方法论（MIT 署名随平移）。
  - M3 的桩全换真模型：写稿 / 三审 / 顺势圆 / 修复确认 / 复盘体检。
  - 出口：CC + Codex 各跑真模型 smoke（建书 → 写 1 章 → 分级审 → 定稿）；**账本造假被设定校对逮住**。

> v0.2 Python 版（GPL-3.0）冻结为遗产，仅留在 `main` 分支修致命 bug。v1 在 `v1` 分支以 MIT 重新起步。

## [0.2.0] - 2026-06-13

首个公开发布（Python 版，GPL-3.0）。详见 `main` 分支历史。

[Unreleased]: https://github.com/Jevanzhu/CLWriting/tree/v1
[0.2.0]: https://github.com/Jevanzhu/CLWriting/releases/tag/v0.2.0
