<div align="center">

# ✍️ CLWriting

**为中文网文作者打造的、全程中文的 AI 创作系统**

长篇 _200 万字不崩、不吃书_ · 短篇集 _单篇情绪爆破、一反转撑全篇_

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Test](https://img.shields.io/badge/tests-1178%20all%20green-4FC08D?logo=vitest&logoColor=white)](#-项目状态)
[![Deps](https://img.shields.io/badge/AI%20provider-Anthropic%20%2B%20OpenAI-e879f9)](#%EF%B8%8F-技术栈)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Status](https://img.shields.io/badge/status-v1.0%20RC%20candidate-orange)](#-项目状态)

**一本书 / 一个短篇集 = 一个 git 仓库**<br>
AI 负责写和审，脚本负责数和记，作者只做三件事：**确认细纲 · 审稿 · 拍创作决策**

</div>

---

## 目录

- [项目定位](#-项目定位)
- [核心能力](#-核心能力)
- [快速开始](#-快速开始)
- [工作流](#-工作流)
- [命令一览](#-命令一览)
- [技术栈](#%EF%B8%8F-技术栈)
- [项目状态](#-项目状态)

---

## 🎯 项目定位

CLWriting 不是通用写作编辑器，而是一套面向中文网文生产的创作操作系统。

它把高风险环节拆成可验证的脚本流程：状态机判断当前该做什么，机检挡住形式问题，三审核对读感、结构和设定，git 在后台保证每章 / 每篇都能回滚。

| 轨道 | 适用对象 | 核心目标 | 落点 |
|---|---|---|---|
| 长篇 | 连载小说、长线剧情、多账本设定 | 200 万字不崩、不吃书 | `定稿/正文/` |
| 短篇集 | 单篇故事、反转故事、情绪爆破型短篇 | 一篇一个闭环，一反转撑全篇 | `篇/<篇号>-<标题>/` |

---

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| **双轨分流** | `kind: long` / `kind: short` 从仓库布局、状态机、机检、三审到定稿全程分轨。 |
| **状态机单入口** | `enter` 进门体检，自动判断续写、审稿、定稿、体检、回滚等状态。 |
| **机检硬闸** | 复读、句式、禁词、文风境界、短篇身体部位词、开头零环境等可量化问题先拦住。 |
| **三审制** | 长篇：读者审 / 编辑审 / 设定校对；短篇：钩子审 / 情绪反转审 / 设定收尾审。 |
| **账本防吃书** | 定稿前核对「声明 vs 正文」，账实不符会阻断定稿。 |
| **自动连写** | `auto` 将长篇多章 / 短篇多篇产出攒进 `待定稿/`，作者回来批量审稿、逐章/逐篇定稿或整批回滚。 |
| **成本与体检报告** | `record-call` 记录大纲 / 草稿调用和 token，`health --metrics` / `--style` / `--report` 汇总成本、审查和文风漂移。 |
| **多书工作目录** | `init` / `use` / `list` / `repair` 支持一个工作目录管理多本书。 |
| **RAG 可选插件** | 纯 `node:sqlite` + 纯 JS 余弦召回；api_key 不进 git。 |
| **导出 / 迁移** | `export` 输出干净正文，长篇按章、短篇集按篇打包；`import` 从 v0.2 正文轻量迁移，长短篇自动分流。 |
| **Studio 桌面应用** | Electron + Vue 3 Obsidian 风格 GUI：三栏工作区、章节树、CodeMirror 编辑器、原生右键菜单、右栏信息/审阅/机检/分析面板、专注模式、可拖拽侧栏、JSON 配置持久化（三级架构，对齐 Obsidian）。 |
| **AI 辅助** | 选段改写（语气/风格调整）、AI 分析（情绪曲线/钩子强度/文风漂移）、上下文速查插入、工作台 AI 写作。 |

---

## 🚀 快速开始

要求 **Node >= 24**。

```bash
npm install

# 桌面应用（GUI 全流程：建书、写作、审稿、定稿）
npm run dev:app
```

开发调试：

```bash
npm run typecheck          # tsc 双检
npm run build:all          # 桌面构建 + 前端(Vite)
npm test                   # 1178 单测
npm run test:e2e           # Playwright e2e（mock 驱动）
npx tsx scripts/dev-api.ts # Studio API :7878（配合 dev:web 前端调试）
```

首次使用：在「设置 → AI」里添加一家 AI 供应商（Anthropic 官方 / Claude 中转 / OpenAI 兼容任选），
点「测试连接」确认能力，启用后即可建书开写。作者全程在 GUI 内操作，无需命令行。

---

## 🔁 工作流

```text
建书（GUI 表单：书名 / 题材 / 长短篇）
  → 设定界：大纲（卷纲 / 章纲 / 总纲）+ 角色 + 世界观 + 物品
  → 写作：编辑器写稿；「全自动写章」= AI 写稿 → 机检 → 报红自动重写 → 全绿交你
  → 三审（读者 / 编辑 / 设定）→ 作者裁决
  → 批量审稿：待定稿逐章/逐篇定稿或整批回滚
  → 下一章
```

短篇集形态：`建书选择短篇集` → 每篇定情绪 + 核心反转 → 五段大纲 + 情绪曲线 + 清单.md →
正文 → 机检 + 三审 → 按篇定稿。

状态机全程只给**人话建议**（进门体检、续写断点、卷末复盘、待审稿提示），对应的执行动作
直接在界面上完成；`book.yaml` 仍可按集调整机检阈值与调用预算：

```yaml
short:
  profile: 悬疑反转
  target_emotions: [惊悚, 后怕, 震惊, 不安]
  target_reversal_types: [死者反转, 真凶反转, 身份反转, 时间/记忆反转]
  target_ending_flavors: [后怕, 反噬, 余寒, 真相落地]
  word_min: 6000
  word_max: 16000
  body_part_threshold: 5
  simile_threshold: 8
  section_count: 5
  opening_env_chars: 220
```

内置推荐覆盖悬疑/怪谈、爽文/打脸、情感/治愈、奇幻/科幻/玄幻等常见短篇题材，并写入 `short.profile`
与目标分布作为平台/栏目画像。`short.strict: true` 可把短篇专属黄项升为硬闸。

调用预算使用同一个 `budget.calls_per_chapter` 字段；长篇解释为每章上限，短篇集解释为每篇上限：

```yaml
budget:
  calls_per_chapter: 8
```

自动连写把多章/多篇草稿攒进 `工作区/待定稿/`，作者在「批量审稿」界面逐章/逐篇定稿或整批回滚。

---

## 📚 作者交互面

作者不需要命令行：全部能力收敛进 **Studio 桌面应用**（Electron + Vue 3）。

| 交互面 | 说明 |
|---|---|
| 状态卡 | 每次进书自动体检、判态，用人话告诉你现在该做什么。 |
| 全自动写章 | 一键：AI 写稿 → 机检 → 报红自动重写 → 全绿才交给你确认。 |
| 编辑器 | CodeMirror 6 三栏工作区；专注模式；选段改写；AI 分析。 |
| 章节树 | 文档滑动（灵感/大纲/设定/写作/待定稿），机检红点逐级冒泡。 |
| 三审 / 批量审稿 | 读者/编辑/设定三视角审稿；待定稿逐章定稿或整批回滚。 |
| 文风系统 | 样章/金句收割、候选箱、形象对照报告。 |

服务端直接调用内核模块（不再 spawn 任何 CLI 子进程）。

---

## 🛠️ 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node >= 24 |
| 语言 | TypeScript strict |
| 前端 | Vue 3 + Pinia + Vite |
| 编辑器 | CodeMirror 6 |
| 桌面壳 | Electron |
| 存储 | `node:sqlite` |
| AI 提供者 | Anthropic / OpenAI 双协议适配器（`@anthropic-ai/sdk` + `openai`，baseURL 可指用户端点） |
| 构建 | tsup（桌面主进程）+ Vite（前端） |
| 测试 | vitest（1178 单测 + e2e） |

设计红线：

- 作者数据不被升级覆盖。
- 书仓库默认安装 `pre-push` 保护，阻止小说正文误推到远端。
- api_key 不进 git（落本地 `.clwriting/rag.secret`，0600）。
- `Dev/` 是本地规划资料，不进入正式发布文件。
- 定稿走原子 commit，失败则回滚定稿区改动。

---

## 📊 项目状态

**v1.0 RC 候选（1.0.0-rc.0）**：Node + TypeScript 从零重写，与 v0.2 Python 版无代码继承关系。

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0-M4 | 已完成 | 格式层、缓存、写章机检、状态机、git 隐身、三审、角色分发、知识层。 |
| M5-M7 | 已完成 | 安装器、多书、自动连写、导出、迁移、RAG 插件。 |
| M8 | 已完成 | 短篇轨：`kind: short` 布局、精简态机、按篇定稿、清单、机检、三审、题材阈值推荐。 |
| M9-M10 | 已完成 | Studio Obsidian 风格前端：三栏工作区、章节树、CodeMirror 编辑器、大纲/设定表单、总览/节奏/关系图视图、专注模式、可拖拽侧栏。 |
| M11 | 已完成 | 质量收口：机检红点树冒泡、E2E 全覆盖、评审瑕疵修复。 |
| M12 | 已完成 | AI 辅助写作线：选段改写、AI 分析（情绪/钩子/文风）、上下文速查、工作台 AI 写作。 |
| W1-W5 | 已完成 | AI 链路重构：provider 双协议抽象、tool_use 契约层、runTask 编排器、review/analysis 直连、**CLI 全退场**。 |
| UI 打磨 | 持续 | dataviz 色盲安全调色板、全局 tooltip、侧栏 Obsidian 化交互、原生右键菜单、JSON 配置持久化、token 系统贯通。 |
| Beta 体检体系 | 已落地，继续校准 | 指标 / 文风 / 综合报告、定稿落账、成本采集。 |

- **145 个测试文件 / 1178 个测试全绿**，`tsc --noEmit` 通过，`build:all` 构建通过。
- 短篇全流程定稿验证已通过；AI 产出经 tool_use 结构化约束，front matter 零漂移。
- 作者侧全程自然语言：设置里添加供应商 → 测试连接 → 全自动写章/编辑器写作/三审/定稿，零命令行。
- 架构红线：**不再 spawn 任何 CLI 子进程**；全部 AI 流量经 provider 直连，确定性操作直接 import 内核模块。

---

## 🙏 致谢

本项目在设计上参考了以下开源项目：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**：架构思想参考；v1 为从零重写。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：长篇写作方法论资料来源。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定方法论参考。

---

## 📄 许可证

[MIT](LICENSE)
