# 快速开始

这篇带你用 story-craft 写出第一章——从建项目到正文落地。**全程在 Claude Code 对话里输入 `/story-*` 命令**，用大白话描述需求即可，不用碰终端。

story-craft 支持两条写作轨道：

- **短篇**：1-10 万字的短篇/中篇，流程轻，上手快。
- **长篇**：多卷连载，多一步"规划"，适配长线的人物与伏笔管理。

建项目时选定轨道，后面命令会自动适配；走错轨道的命令不会消失，而是提示你该用哪个。

## 第一步：建项目

```text
/story-init
```

它会和你确认书名、题材、目标字数、主角（欲望/缺陷）、核心卖点、硬约束，以及这是短篇还是长篇。聊清楚后，story-craft 把这些固化成项目的"设定真源"（`.story/contracts/master.json`）——之后所有写作都以它为准，保证越写越不跑偏。

## 短篇：写第一章

确认是短篇项目后，最顺的链路是：

```text
/story-preflight 1  →  /story-short-write 1  →  /story-review 1
```

- **`/story-preflight 1`**：动笔前的体检。确认这一章该有的设定都齐了，并告诉你推荐用哪个命令。
- **`/story-short-write 1`**：写第 1 章正文。story-craft 会先读全前文设定，再起草，写完自动过一轮审查。
- **`/story-review 1`**：对这一章做审查，列出逻辑、节奏、人物、AI 味等方面的问题。

如果审查发现问题：

```text
/story-repair      根据审查结果修复（按严重度选重写/局部改/润色），修完强制复审
/story-deslop 正文/第1章.md    单独跑一遍"去 AI 味"检查
```

短篇没有独立的结构分析命令——想检查质量和一致性，用 `/story-review` 和 `/story-deslop` 即可，再配合 `/story-query` 看状态。

## 长篇：先规划，再逐章写

长篇比短篇多一步规划：

```text
/story-init  →  /story-long-plan  →  /story-preflight 1  →  /story-long-write 1
```

- **`/story-long-plan`**：规划全书。生成卷、章合同和长篇大纲，并帮你设计人物档案与关系。这是长篇的地基。
- **`/story-long-write 1`**：写第 1 章。story-craft 会**按当前情境智能选择写法**（比如日常推进、重大转折、开新卷、开篇、导入既有素材等场景），用合适的节奏来写。

长篇专属的两个**只读复盘命令**：

```text
/story-long-scan       一致性扫描：占位符、前后矛盾、健康检查
/story-long-analyze    结构分析：伏笔债、人物线分布、质量与记忆状态
```

它们只看不改，随时可跑。

## 写到一半中断了怎么办

不用担心。每章写作的中间产物都会留在 `.story/workflows/ch_NN/` 下（草稿、审查结果等）。下次接着写时，story-craft 会从缺失的那一步继续，不用从头来过。

## 沉淀你的写作经验

写着写着，你会发现一些反复出现的问题或想固定下来的写法。这时：

```text
/story-query learning-suggestions   看系统从审查历史自动提炼的经验候选
/story-learn                        把你认可的经验入库
```

入库的经验会自动注入后续章节的写作要求里——越写，story-craft 越懂你的偏好。详见 `/story-learn` 命令说明。

## 随时复盘

`/story-query` 是你的项目仪表盘，只读不改：

```text
/story-query status        项目进度、已写章节
/story-query memory        人物、设定、已发生事件
/story-query context 2     第 2 章能用到的上下文
/story-query learning      已沉淀的写作经验
```

## 下一步

- 想看全部命令、Skill 和 Agent：`docs/claude-code-usage.md`
- 遇到问题排错：`docs/troubleshooting.md`
- 底层 CLI（高级/运维用，日常写作用不到）：`docs/cli-usage.md`

不确定该干什么时，`/story-preflight` 永远能告诉你下一步。
