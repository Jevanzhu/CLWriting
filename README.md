<div align="center">

# ✍️ CLWriting

**为中文网文作者打造的、全程中文的 AI 创作系统**

长篇 _200 万字不崩、不吃书_ ／ 短篇集 _单篇情绪爆破、一反转撑全篇_

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Test](https://img.shields.io/badge/tests-401%20all%20green-4FC08D?logo=vitest&logoColor=white)](#-项目状态)
[![Deps](https://img.shields.io/badge/runtime%20deps-0-e879f9)](#%EF%B8%8F-技术栈)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Status](https://img.shields.io/badge/status-v1.0%20重写中-orange)](#-项目状态)

</div>

> **一本书 / 一个短篇集 = 一个 git 仓库**。
> AI 负责写和审，脚本负责数和记，作者只做三件事：**确认细纲 · 审稿 · 拍创作决策**。

---

## ✨ 核心特性

| | 特性 | 说明 |
|:---:|---|---|
| 🎯 | **双轨分流** | `kind: long` 长篇 ／ `kind: short` 短篇集——从仓库布局、状态机到机检、三审、定稿全程分轨，而非打补丁 |
| 🧠 | **状态机单入口** | `enter` 一条命令进门体检 → 判态 → 路由：长篇 8 态、短篇精简态，作者永远知道「现在该干啥」 |
| 🔒 | **机检硬闸** | 复读 / 句式 / 禁词 / 文风境界 / 身体部位词 / 开头零环境等可量化项，定稿前一道道闸过 |
| 👁️ | **三审制** | 长篇：读者审 / 编辑审 / 设定校对；短篇：钩子审 / 情绪反转审 / 设定收尾审——满审 / 顺序审 / 合审诚实降级 |
| 📒 | **账本防吃书** | 定稿前核对「声明 vs 正文」一致性——账实不符（如揭凶手但正文不写）被设定校对逮住、定稿拒绝 |
| 🤖 | **自动连写** | `auto` 串联单章八阶段，产出攒进 `待定稿/`，作者回来批量审稿 → 逐章定稿 / 整批回滚 |
| 🗂️ | **多书工作目录** | 一条命令装工作目录 + 多本书并管：`use` 换书、`list` 列书、`repair` 自愈登记 |
| 🔌 | **RAG 可选插件** | 零依赖 RAG：纯 `node:sqlite` + 纯 JS 余弦，召回喂进写章备料；api_key 绝不进 git |
| 📤 | **导出 / 迁移** | `export` 定稿正文干净导出（单文件 / 分章）；`import` 从 v0.2 轻量导入，长短篇按 length-routing 自动分流 |

---

## 🚀 快速开始

```bash
# 建工作目录 + 第一本书（长篇）
clwriting init --name 我的世界 --genre 玄幻

# 或建一个短篇集
clwriting init --kind short --name 午夜故事 --genre 悬疑

# 进门体检 → 判态 → 路由（作者永远从这里进门）
clwriting enter
```

> 要求 **Node ≥ 24**（`node:sqlite` 开箱即用）。低于此版本 bin 会以人话提示升级并退出。

---

## 🔁 工作流

```
长篇 ──┐  enter → 起草 → confirm 细纲 → 写正文 → check 机检
       │                          ↓
       │              review 三审 → 作者裁决 → finalize 定稿 → 下一章
       │              └ auto 连写一批攒进 待定稿/ 批量审 ┘
       │
短篇 ──┘  init --kind short 建集 → enter 落态 7 出「篇」
                    ↓
          单篇走 P1–P4（定情绪+反转 → 五段大纲+清单 → 正文 → 三审定稿）
          一篇一独立闭环，整集共享文风库
```

---

## 📜 命令一览

| 命令 | 作用 |
|---|---|
| **创作主链** | |
| `enter` | **单入口**：进门体检 → 判态 → 路由到当前该做的事 |
| `confirm` | 细纲确认留痕（哈希绑定章 / 篇号） |
| `check` | 机检硬闸（长篇形式三检 ／ 短篇专属项 + 清单形式检） |
| `review` | 三审编排：`plan` ／ `run` ／ `collect` ／ `batch` |
| `finalize` | 原子定稿（前置闸 → commit → 清工作区） |
| **编排 / 回滚** | |
| `auto` | 连写一批：`--resume` 续跑，坏章自动隔离 |
| `revert` | 回到第 N 章 ／ 篇（备份 + reset + 缓存重建） |
| `health` | git ／ 源文件 ／ 账本体检 |
| `session-start` | 注入有界开场上下文 |
| **书库管理** | |
| `init` | 建工作目录 + 第一本书（`--kind short` 建短篇集） |
| `use` ／ `list` ／ `repair` | 换书 ／ 列书 ／ 自愈登记 |
| `update` | 升级插件本体（作者数据只增不覆盖） |
| **知识 / 文风 / 插件** | |
| `roles` | 角色单源分发（Claude ／ Codex ／ 通用三套壳） |
| `knowledge` | 知识层素材速查与校验 |
| `learn` | 文风样章 ／ 金句收割入库 |
| `enable-rag` | 启用 RAG 可选插件 |
| **数据流转** | |
| `export` ／ `import` | 定稿导出 ／ v0.2 导入 |

---

## 🛠️ 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node ≥ 24 |
| 语言 | TypeScript（strict） |
| 存储 | 纯 `node:sqlite` |
| 构建 | tsup |
| 测试 | vitest |
| **运行时依赖** | **零第三方依赖**（`dependencies: {}`） |

### 本仓库开发者

```bash
npm install          # 安装 devDependencies
npm run typecheck    # tsc --noEmit 类型检查
npm run build        # tsup 构建（src → dist）
npm test             # vitest 运行测试
node dist/cli.js     # 直接运行 bin
```

---

## 📊 项目状态

**v1.0 重写进行中**（`main` 主线，从零重写，与 v0.2 Python 版无代码继承关系）。

| 里程碑 | 内容 |
|---|---|
| M0–M4 | 格式层 ／ 缓存 ／ 写章机检 ／ 状态机 ／ git 隐身 ／ 三审 ／ 角色分发 ／ 知识层 |
| M5–M7 | 安装器（多书）+ 自动连写 + 导出 ／ 迁移 ／ RAG 插件 |
| **M8 短篇轨** | 双轨第二轨——`kind: short` 分流 + 短篇集布局 + 精简态机 + 按篇定稿 + 单篇清单 + 短篇专属机检 + 短篇三审 + 短篇导入 |

- ✅ **401 个测试全绿** · `tsc --noEmit` 通过 · 运行时零第三方依赖
- 🟡 ZCode（CC 等价宿主）smoke 出口达成——长篇与短篇正反向闭环均真模型复现；真 CC / Codex CLI smoke 待 beta 环境跑

---

## 🙏 致谢

本项目在设计上参考了以下开源项目：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**：架构思想参考；v1 为从零重写。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：长篇写作方法论资料来源。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定方法论参考。

---

## 📄 许可证

[MIT](LICENSE)
