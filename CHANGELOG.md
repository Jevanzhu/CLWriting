# 更新日志

本项目所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-06-13

首个公开发布。story-craft 是面向 Claude Code 的中文短篇/长篇小说交互式写作系统（1–10 万字起步，可扩展长篇）。

### 新增

**核心架构**
- 事件投影写作架构：写作合同 → `chapter-commit` 落盘真源 → 6 大投影自动重建（state / memory / summary / index / vector / markdown_view），`rebuild-views` 一键重建
- 双轨工作流：短篇与长篇分轨，13 个斜杠命令（短篇 9 / 长篇 12，含共享）、20 个 CLI 子命令
- 5 类写作场景路由：开新书 / 日常续写 / 新卷 / 大改 / 外稿导入
- 17 skills / 9 agents / 6 hooks（由 story-init 自部署）、6 流派包 / 37 流派模板

**检索增强（RAG）**
- 零三方依赖的本地 RAG 栈（embedding / rerank / retriever / vector_store / config），向量 → 语义 → 关键词三级降级，无网络、无依赖亦可运行
- 语义查询、章节影响分析（支持 Markdown 输出）、RAG 健康诊断
- 召回优化：scene 段落级切分、summary 启发式选句

**深层学习闭环**
- 经验自动提炼：从评审历史自动提炼可复用 pattern，写入侧去重合并 + source / importance 字段
- `query learning-suggestions` 候选审阅 + 人工确认回写（严重度优先，blocker 置顶）
- 参考技法接入：`learn --source import` 拆解外部范文技法，纳入 learning 闭环
- 注入防膨胀：importance + 新近度排序 + top-N 截断
- 经验生命周期管理：停用（软删除）
- auto-style 风格漂移自学
- 写作闸门失败附修复指引（next_step）

**质量保障**
- 7-gate deslop 质量门，含 markdown_residue 残留终检
- 正文即成品：正文去 Markdown 标记、章节标题入文件名、段间空行对齐网文口径

**工程**
- filelock 跨进程写锁，防多进程并发写 state 文件丢失更新（lost update）
- CI：compileall + pytest + e2e smoke（无额外 extras）
- Claude Code 插件市场清单（marketplace.json + plugin.json）
- GPL-3.0 许可

### 测试
- 282 项测试全绿

[0.2.0]: https://github.com/Jevanzhu/CLWriting/releases/tag/v0.2.0
