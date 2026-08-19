<div align="center">

# ✍️ CLWriting

**为中文网文作者打造的、全程中文的 AI 创作系统**

长篇 _200 万字不崩、不吃书_ · 短篇集 _单篇情绪爆破、一反转撑全篇_

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Test](https://img.shields.io/badge/tests-2432%20all%20green-4FC08D?logo=vitest&logoColor=white)](#-项目状态)
[![Deps](https://img.shields.io/badge/AI%20provider-Anthropic%20%2B%20OpenAI%20%2B%20Responses-e879f9)](#%EF%B8%8F-技术栈)
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
- [作者交互面](#-作者交互面)
- [本机安全模型](#-本机安全模型)
- [技术栈](#%EF%B8%8F-技术栈)
- [项目状态](#-项目状态)

---

## 🎯 项目定位

CLWriting 不是通用写作编辑器，而是一套面向中文网文生产的创作操作系统。

它把高风险环节拆成可验证的自动化流程：状态机判断当前该做什么，机检挡住形式问题，三审核对读感、结构和设定，git 在后台保证每章 / 每篇都能回滚。作者全程在桌面应用内操作，**零命令行**。

| 轨道 | 适用对象 | 核心目标 | 落点 |
|---|---|---|---|
| 长篇 | 连载小说、长线剧情、多账本设定 | 200 万字不崩、不吃书 | `定稿/正文/` |
| 短篇集 | 单篇故事、反转故事、情绪爆破型短篇 | 一篇一个闭环，一反转撑全篇 | `篇/` + `清单/` |

---

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| **双轨分流** | `kind: long` / `kind: short` 从仓库布局、状态机、机检、三审到定稿全程分轨。 |
| **全自动写章** | 一键：AI 写稿 → 机检 → 报红自动退回重写 → 全绿才交你确认；重试触顶才打扰作者。 |
| **机检硬闸** | 复读、句式、禁词、文风境界、短篇身体部位词、开头零环境等可量化问题先拦住。 |
| **三审制** | 长篇：读者审 / 编辑审 / 设定校对；短篇：钩子审 / 情绪反转审 / 设定收尾审。 |
| **账本防吃书** | 定稿前核对「声明 vs 正文」，账实不符会阻断定稿。 |
| **伏笔追踪** | 设定伏笔从埋设到回收全程足迹扫描 + 风险提示，杜绝「埋了忘收」。 |
| **节奏预测** | 字数曲线 + 规划 vs 已写双轨，长篇节奏失衡提前预警。 |
| **文风系统** | 样章 / 手法 / 反例 / 禁词四类型条目库 + 四源管线（改稿轨迹 / 收割 / 机检 / AI 分析 → 候选箱 → 作者确认 → 条目库）。 |
| **AI 分析** | 选段改写（语气 / 风格调整）、情绪曲线、钩子强度、文风漂移、上下文速查插入。 |
| **凭据安全** | API Key 信封加密落盘（HKDF → AES-GCM），脱敏泄漏面收敛，永不进 git。信封密钥为应用内置混淆存储（防 `strings` 级扫描、不防逆向提取），高敏感环境请使用受限专属 Key。 |
| **回收站** | 工作区软删 + 恢复缓冲，误删可捞回。 |
| **导出 / 全文搜索** | 干净导出定稿（剥 front matter）；全仓范围关键词搜索。 |

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
npm run typecheck          # tsc --noEmit
npm run build:all          # 桌面构建 + 前端构建
npm test                   # 2432 单测
npm run test:e2e           # Playwright e2e（mock 驱动，26 specs / 39 用例）
npm run dev:api            # Studio API :7878（配合 dev:web 前端调试）
npm run dev:web            # Vite HMR :5173（配合 dev:api）
npm run dev:electron       # 构建后起 Electron（非 HMR）
npm run build:desktop      # electron-builder 打包 dmg
```

首次使用：在「设置 → AI」里添加一家 AI 供应商（Anthropic 官方 / Claude 中转 / OpenAI 兼容任选），
点「测试连接」确认能力，启用后即可建书开写。作者全程在 GUI 内操作，无需命令行。

---

## 🔁 工作流

```text
建书（GUI 表单：书名 / 题材 / 长篇 or 短篇集）
  → 设定界：大纲（卷纲 / 章纲 / 总纲）+ 角色 + 世界观 + 物品
  → 写作：编辑器写稿；「全自动写章」= AI 写稿 → 机检 → 报红自动重写 → 全绿交你
  → 三审（读者 / 编辑 / 设定）→ 作者裁决
  → 批量定稿：待定稿逐章/逐篇定稿确认
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

调用预算使用同一个 `budget.calls_per_chapter` 字段；长篇解释为每章上限，短篇集解释为每篇上限：

```yaml
budget:
  calls_per_chapter: 8
```

自动连写把多章/多篇草稿攒进 `工作区/待定稿/`，作者在「批量定稿」中逐章/逐篇确认定稿；需要回退时用章节历史版本恢复。

---

## 📚 作者交互面

作者不需要命令行：全部能力收敛进 **Studio 桌面应用**（Electron + Vue 3）。

| 交互面 | 说明 |
|---|---|
| 书架 / 书库 | 多书库管理、最近书库、切换即重启；新建书选长篇 / 短篇集。 |
| 状态卡 | 每次进书自动体检、判态，用人话告诉你现在该做什么。 |
| 开书对话 | 开书向导：设定基础 / 大纲规划 / 文风校准分组步骤，逐步生成、编辑、落盘。 |
| 全自动写章 | 一键：AI 写稿 → 机检 → 报红自动重写 → 全绿才交给你确认。 |
| 对话助手 | 工作台「对话」tab：Agent 化助手调白名单工具（含确认闸）；对话历史事件化持久化，刷新自动恢复。 |
| 编辑器 | CodeMirror 6 三栏工作区；专注模式（打字机）；选段改写；AI 分析。 |
| 章节树 | 文档滑动（灵感 / 大纲 / 设定 / 写作 / 待定稿），机检红点逐级冒泡。 |
| 三审 / 批量定稿 | 读者 / 编辑 / 设定三视角审稿；待定稿逐章/逐篇定稿（定稿前防吃书闸拦账实不符）。 |
| 文风系统 | 四段式 StyleView：条目库 / 候选箱 / 定标基线 / 铁律；样章与金句收割导入。 |
| 总览 | 进度、节奏、伏笔、文风四区仪表盘。 |
| 关系图 | 角色 / 世界观 / 伏笔径向层次关系图。 |
| 学习视图 | 收割与候选箱的 AI 味学习入口。 |
| 事件审计 | 事件重放与遮蔽差异审计：模型可见 vs 人类可见、sourceSeqs 血缘、工作流链路。 |

服务端直接调用内核模块（不再 spawn 任何 CLI 子进程）。

---

## 🔒 本机安全模型

Studio 桌面应用 = 前端页面 + 一个本机 HTTP 服务。服务只监听**本机回环地址**
（`127.0.0.1`，也接受 `localhost` / `::1`；传入非回环监听地址会直接启动报错），
不对局域网 / 外网开放。对远端网页（跨站脚本、DNS rebinding）的防线：

| 防线 | 机制 |
|---|---|
| 回环监听 | 仅绑定本机回环地址，非回环监听地址启动即拒绝（fail-fast）。 |
| Host 头校验 | 请求 Host 必须精确匹配「本机回环地址 + 实际监听端口」，否则 403——切断 DNS rebinding（攻击域名二次解析到 127.0.0.1 后借同源 GET 读书稿）。 |
| Origin 白名单 | CORS 只放行白名单 Origin（实际监听 origin；开发态 Vite 5173 仅显式设 `CLW_DEV_UI` / `CLW_DEV_CORS` 时注入）；非白名单 Origin 的预检与写请求一律 403。 |
| 写端点令牌 | POST / PUT / DELETE / PATCH 双闸：Origin 校验 + `x-studio-token` 会话令牌（启动时随机生成，恒时比较），跨站伪造写被双拦。 |
| SSE 订阅令牌 | EventSource 不走写拦截，SSE 流单独校验 query `token`，把可订阅面收敛到拿到启动令牌的客户端，防远端网页窃听创作内容。 |

**信任边界**：GET 读路径不校验令牌是设计口径而非遗漏——**本机进程与 Studio 同信任域**
（本机进程 `GET /api/boot` 即可拿到会话令牌），本安全模型不承诺防御本机上的其他进程；
令牌 + Host / Origin 校验防的是远端网页。API Key 的加密存储另见「凭据安全」。

---

## 🛠️ 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node >= 24 |
| 语言 | TypeScript strict |
| 前端 | Vue 3 + Pinia + Vite |
| 编辑器 | CodeMirror 6 |
| 桌面壳 | Electron（electron-builder 打包，macOS dmg） |
| 存储 | `node:sqlite`（RAG 向量库）+ JSON 配置 |
| AI 提供者 | Anthropic / OpenAI Chat / OpenAI Responses 三协议适配器（baseURL 可指用户端点，模型列表自动拉取） |
| AI 编排 | `runTask` 统一编排层：任务档位（创作 / 助手）、韧性重试、首字节超时、计量闸 |
| 凭据 | Vault 信封加密（HKDF-SHA256 → AES-256-GCM）+ 原子写 + 备份 |
| 构建 | tsup（桌面主进程）+ Vite（前端） |
| 测试 | vitest（2432 单测）+ Playwright（26 specs / 39 用例） |

设计红线：

- 作者数据不被升级覆盖。
- 书仓库版本系统内置保护，定稿走原子写入 + 指纹校验，不依赖 git hook。
- api_key 不进 git（Vault 加密落 `userData/providers.json`，0600）。
- 定稿走原子 commit，失败则回滚定稿区改动。
- 应用数据统一在 `userData` 目录（macOS `~/Library/Application Support/CLWriting`），跨 dev / 打包一致。
- 事件保留（2026-08-16 拍板：全量保留 + 手动清理）：对话与工作流事件 append-only 全量落在 `userData/clwriting/session/<书hash>.db`（每书一库，不进书仓库、不进 git）；需要清理时在「事件审计」视图用「清除事件史…」按书手动销毁（两步确认，不可撤销）。

---

## 📊 项目状态

**v1.0 RC 候选（1.0.0-rc.0）**：Node + TypeScript 从零重写，与 v0.2 Python 版无代码继承关系。

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0-M8 | 已完成 | 格式层、缓存、写章机检、状态机、git 隐身、三审、角色分发、知识层、多书、自动连写、导出、迁移、RAG、短篇轨。 |
| M9-M10 | 已完成 | Studio Obsidian 风格前端：三栏工作区、章节树、CodeMirror 编辑器、大纲/设定表单、总览/节奏/关系图视图、专注模式。 |
| M11 | 已完成 | 质量收口：机检红点树冒泡、E2E 全覆盖、评审瑕疵修复。 |
| M12 | 已完成 | AI 辅助写作线：选段改写、AI 分析（情绪 / 钩子 / 文风）、上下文速查、工作台 AI 写作。 |
| W1-W5 | 已完成 | AI 链路重构：provider 双协议抽象、tool_use 契约层、runTask 编排器、review/analysis 直连、**CLI 全退场**。 |
| 强化优化 | 已完成 | 模型解耦 / 韧性重试 / 计量闸 / 任务档位；评审断路三 bug（mockText 守卫 / toolUse 消费 / modelCaps 失效）全修。 |
| 凭据安全 | 已完成 | Vault 信封加密 + 写入健壮性 + 泄漏面收敛。 |
| 文风系统 | 已完成 | 条目模型 + 四源管线，StyleView 四段式。 |
| AI Harness | 已完成 | 内核重整：fake provider + trace + 规则命中统计 + 作者信号 + 自愈闭环。 |

- **265 个测试文件 / 2432 单测全绿 + 26 个 e2e spec / 39 用例**，`tsc --noEmit` 与 `vue-tsc` 双端通过，`build:all` 构建通过。
- 短篇全流程定稿验证已通过；AI 产出经 tool_use 结构化约束，front matter 零漂移。
- 作者侧全程自然语言：设置里添加供应商 → 测试连接 → 全自动写章 / 编辑器写作 / 三审 / 定稿，零命令行。
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