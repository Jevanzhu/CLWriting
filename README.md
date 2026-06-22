<div align="center">

# ✍️ CLWriting

**为中文网文作者打造的、全程中文的 AI 创作系统**

长篇 _200 万字不崩、不吃书_ · 短篇集 _单篇情绪爆破、一反转撑全篇_

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Test](https://img.shields.io/badge/tests-557%20all%20green-4FC08D?logo=vitest&logoColor=white)](#-项目状态)
[![Deps](https://img.shields.io/badge/runtime%20deps-0-e879f9)](#%EF%B8%8F-技术栈)
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

---

## 🚀 快速开始

要求 **Node >= 24**。低版本会以人话提示升级并退出。

```bash
# 建工作目录 + 第一本书（长篇）
clwriting init --name 我的世界 --genre 玄幻

# 或建一个短篇集
clwriting init --kind short --name 午夜故事 --genre 悬疑

# 进门体检 → 判态 → 路由
clwriting enter
```

本仓库开发调试：

```bash
npm install
npm run typecheck
npm run build
npm test
node dist/cli.js --help
```

---

## 🔁 工作流

```text
长篇
  enter
    → 起草细纲
    → confirm 细纲
    → 写正文
    → check 机检
    → review 三审
    → 作者裁决
    → finalize 定稿
    → 下一章

短篇集
  init --kind short 建集
    → enter 出下一篇
    → 定情绪 + 核心反转
    → 五段大纲 + 情绪曲线 + 清单.md
    → 正文
    → check + review
    → finalize 按篇定稿
```

`init --kind short` 会按题材写入短篇机检推荐阈值；未命中题材时沿用通用默认。
这些值只是起点，可在 `book.yaml` 按集调整：

```yaml
short:
  word_min: 6000
  word_max: 16000
  body_part_threshold: 5
  simile_threshold: 8
  section_count: 5
  opening_env_chars: 220
```

内置推荐覆盖悬疑/怪谈、爽文/打脸、情感/治愈、奇幻/科幻/玄幻等常见短篇题材；`health --report` 会基于已定稿短篇回灌阈值建议，`short.strict: true` 可把短篇专属黄项升为硬闸。

调用预算仍使用同一个 `budget.calls_per_chapter` 字段；长篇解释为每章上限，短篇集解释为每篇上限：

```yaml
budget:
  calls_per_chapter: 8
```

自动模式会把多章/多篇草稿攒进 `工作区/待定稿/`：

```text
auto 连写一批
  → batch review
  → 逐章/逐篇 finalize
  → enter 回到干净态
```

---

## 📜 命令一览

| 分组 | 命令 | 作用 |
|---|---|---|
| 创作主链 | `enter` | 单入口：进门体检、判态、路由到当前动作。 |
| 创作主链 | `confirm` | 细纲确认留痕，哈希绑定章 / 篇号。 |
| 创作主链 | `record-call` | 记录大纲 / 草稿 AI 调用次数与 token，支持事后回填 token 真值。 |
| 创作主链 | `check` | 机检硬闸，长篇查账本，短篇查清单与专属项；短篇可用 `--strict-short` 把专属黄项升为硬闸。 |
| 创作主链 | `review` | 三审编排：`plan` / `run` / `collect` / `batch`。 |
| 创作主链 | `finalize` | 前置闸通过后原子定稿并提交。 |
| 编排回滚 | `auto` | 长篇/短篇连写一批，支持 `--resume`，坏章/坏篇自动隔离。 |
| 编排回滚 | `revert` | 回到第 N 章 / 篇，备份后回滚并重建缓存。 |
| 编排回滚 | `health` | git、指标、文风和综合报告体检，支持 `--metrics` / `--style` / `--report`；短篇综合报告会提示情绪、反转、结构物件重复风险、阈值回灌和预算校准建议。 |
| 编排回滚 | `session-start` | 输出给宿主 AI 的有界开场上下文。 |
| 书库管理 | `init` | 建工作目录和第一本书，支持 `--kind short`。 |
| 书库管理 | `use` / `list` / `repair` | 换书、列书、自愈登记。 |
| 书库管理 | `update` | 升级插件本体，作者数据只增不覆盖。 |
| 知识插件 | `roles` | 角色单源分发到 Claude / Codex / 通用壳。 |
| 知识插件 | `knowledge` | 知识层素材速查与 manifest 校验。 |
| 知识插件 | `learn` | 文风样章与金句收割入库。 |
| 知识插件 | `enable-rag` | 启用 RAG 可选插件。 |
| 数据流转 | `export` / `import` | 定稿导出（长篇全本 / 短篇全篇集）/ v0.2 正文导入。 |

---

## 🛠️ 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node >= 24 |
| 语言 | TypeScript strict |
| 存储 | `node:sqlite` |
| 构建 | tsup |
| 测试 | vitest |
| 运行时依赖 | 0 个第三方依赖 |

设计红线：

- 作者数据不被 `update` 覆盖。
- 书仓库默认安装 `pre-push` 保护，阻止小说正文误推到远端。
- `health` 会提示书仓库配置的 remote，提醒正文外传风险。
- api_key 不进 git。
- `Dev/` 是本地规划资料，不进入正式发布文件。
- 定稿走原子 commit，失败则回滚定稿区改动。

---

## 📊 项目状态

**v1.0 RC 候选（1.0.0-rc.0）**：Node + TypeScript 从零重写，与 v0.2 Python 版无代码继承关系。

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0-M4 | 已完成 | 格式层、缓存、写章机检、状态机、git 隐身、三审、角色分发、知识层。 |
| M5-M7 | 已完成 | 安装器、多书、自动连写、导出、迁移、RAG 插件。 |
| M8 | 已完成 | 短篇轨：`kind: short`、短篇集布局、精简态机、按篇定稿、清单、机检、三审、导入、题材阈值推荐和样本回灌报告。 |
| Beta 体检体系 | 已落地，继续校准 | `health` 指标 / 文风 / 综合报告、定稿落账、`record-call` 成本采集和 token 字段通道。 |

- **73 个测试文件 / 592 个测试全绿**，`tsc --noEmit` 通过，构建通过；RC 中文路径专项已在 Ubuntu / macOS / Windows CI matrix 通过。
- ZCode（CC 等价宿主）smoke 出口达成：长篇与短篇正反向闭环均已复现。
- 真 Claude Code 短篇 smoke 正负向闭环已复现；真 Codex CLI 短篇正向 smoke 已覆盖角色壳加载、写篇、机检、三审回收与 Codex 自身 `finalize` 定稿。
- 当前 RC 基线：50 章规模验证已完成并回收 D9/E1 修复；`health --metrics` 已接入宿主漏记软提示与预算校准提示，短篇 `health --report` 已追加阈值回灌与每篇预算候选，auto 待定稿记账链路已回归覆盖，`record-call --set-tokens` 已支持 token 真值事后回填；v0.2 实书迁移验证因当前无待迁移数据标记为 N/A。
- RC 能力边界：`auto` 已支持长篇批量连写与短篇集批量连写；AI 产出仍由宿主在编排接缝提供，脚本负责待定稿、批量审稿、逐章/逐篇定稿与回滚。

---

## 🙏 致谢

本项目在设计上参考了以下开源项目：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**：架构思想参考；v1 为从零重写。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：长篇写作方法论资料来源。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定方法论参考。

---

## 📄 许可证

[MIT](LICENSE)
