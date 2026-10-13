---
name: agent-notes
description: >-
  Record and maintain durable decision records — the "why", the rejected alternatives,
  and the consequences that code and docs cannot carry. Use when the user asks to
  write a decision record / ADR / RFC / design doc / 决策记录 / 设计文档 / 技术方案,
  asks "why did we do it this way" and no record exists, proposes a substantial change
  that needs a proposal, wants to archive or delete old decision documents, or when a
  change reverses an earlier recorded decision. Also use when superseding, auditing,
  or pruning an existing notes corpus, or when a repository has .agents/notes/ and
  needs its format, classification, bilingual pairing, or archive seals verified.
---

# Agent Notes

Agent Notes 是给 agent 写、也给 agent 读的 RFC：它记录一个决策，以及**这个决策击败了什么**。代码能说明「是什么」，注释能说明「这一行为什么」，但只有决策记录能说明「当初还考虑过哪三条路，为什么都没选」。

## 什么时候写、什么时候不写

写：存在**持久的决策理由**——被放弃的备选方案、负面保证、所有权边界、持久化或协议语义、安全规则、重新引入的条件。这些内容无法从代码或测试中还原。

不写：机械改动、局部 UI 调整、拼写修复、格式化、依赖升版。判断标准是「三个月后有人想推翻这个决定，他需不需要看到当初的理由」。不需要，就别写。

同一个决策只允许一个 owner。要记录新决策时，先搜活跃树里有没有覆盖同一机制的旧笔记：有就**在原地更新它**，不要新建一篇重复的。真的推翻了旧结论，才写新笔记并交叉链接。

## 生命周期即路径

格式是 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`，两个维度都编码在路径里，日期取**该主题首次被提出的那天**（查 git 历史，不是写文件的今天）。

目录名（英文语料 / 中文语料）：

| lifecycle | 含义 |
|---|---|
| `proposed/` · `提案中/` | 已评审但尚未落地（或只落了一部分）。可以用将来时态、写迁移计划。 |
| `implemented/` · `已实施/` | 决策已交付。必须用现在时描述**已存在的事实**。 |
| `rejected/` · `已否决/` | 考虑过并否决了。只在它的理由能防止一个诱人的错误时保留。 |

**声明一次，拼写全树**：语料的主语言（`.agents/notes/harness.json`）同时决定骨架标题和目录名——中文语料从 lifecycle 到文件名主干一路中文，两种拼写不混住一棵树。拼错了门禁会点名期望的名字。

class 是决策的种类，取值封闭：`feature`/`功能`（新的用户或模型可见能力）、`bug-fix`/`缺陷修复`、`simplification`/`简化`（删代码或表面积、不加能力）、`architecture`/`架构`（**交付源码**的结构决策）、`process`/`流程`（**围绕代码**的工具链与工作流）、`testing`/`测试`。

`architecture` 与 `process` 的分界线：架构管我们交付的源码，流程管外围的工具与工作流。`refactor` 被刻意排除——「可观察行为是否改变」这个判据已经被 `simplification` 覆盖。归类判断见 [references/classification.md](references/classification.md)。

## 骨架是强制的

每个 lifecycle 有固定的 section，门禁逐条校验：

- **proposed/**：`## Problem`（必须第一个且脱离解法也能独立成立）→ `## Proposal` → 可插入自定义技术小节 → `## Alternatives considered` → `## Acceptance criteria` → `## Risks`
- **implemented/**：`## Problem` → `## Decision`（现在时）→ 自定义小节 → `## Alternatives considered` → `## Consequences`（代价**和**收获都要写）。**禁止**出现 `## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria`——那是提案期的措辞，门禁会直接报错。
- **rejected/**：保留提案期的结构，判决写在 `Status:` 行上。

`## Alternatives considered` 一篇都不能少。没记录「击败了什么」的决策会反复招来重开争论——这正是决策记录存在的意义。每条备选一段，粗体起头。

头部三行同样是强制的，门禁逐行比对：第 1 行 `# Agent Note: <标题>`、第 2 行空行、第 3 行 `Status: <状态>`、第 4 行空行。`Status:` 全文件只能出现一次，且必须与所在目录一致；`rejected` 必须在破折号后给出理由。

脚手架在 [templates/](templates/) 下每种语言三份——`implemented.en.md` / `implemented.zh.md`、`proposed.*`、`rejected.*`——按你要写的语言各取一份。格式细则见 [references/format.md](references/format.md)。

## 双语：按需启用

缺省是单语：**没有对照文件、没有一致性记录，门禁不施加任何双语要求**。要用中文主语言或维护中英配对时才启用——

- 主语言声明在 `.agents/notes/harness.json`（`{ "primaryLanguage": "zh" }`，缺省 `en`）；它一次定下三件事：正文件 `foo.md` 的语言、每个文件的骨架标题、目录名与文件名主干。**怎么选**：语料语言跟仓库自己的散文走——常驻档、`docs/`、提交信息是中文就选 `zh`，否则留缺省 `en`；上游语料是英文，所以缺省是 `en`。换语言是显式动作：声明改了，整棵树（三个 lifecycle 目录、六个 class 目录、归档容器、文件名主干）跟着移，门禁按声明逐条点名拼写不符的目录。
- 配对一旦存在就按「一对即三个文件」走：正文件、对照文件、`foo.i18n.yaml` 分节一致性记录；门禁按**文件存在**启用切换行、逐节镜像、记录校验三组规则。
- 改完任一侧（含改标题），同一改动里更新对侧并重录：`node scripts/verify-agent-note-format.ts --write`；它只重录结构已过关的配对。

完整契约（各语言骨架与中文标题别名表、切换行形状、镜像规则、记录文法、归档转换）见 [references/bilingual.md](references/bilingual.md)——只在真要写对照文件时读。

## 「事实新鲜」与「决策冻结」的双面约束

这是整套机制的核心张力，两个方向都必须守住：

- **事实必须永远新鲜**（[references/format.md](references/format.md)）：路径、包名、默认值、机制变了，**必须在同一个改动里原地改写笔记**去匹配现实。不许追加变更历史，不许写「原先是……现在改成……」。
- **决策永远冻结**：改事实不是改结论的许可证。推翻决策必须新写一篇并交叉链接，或者按合并规则把旧笔记彻底并进来再删。绝不能悄悄把旧笔记改写成相反的意思，也不能拿 git 历史当作理由的唯一副本。

## 归档

活跃树会无限增长，所以有 `archived/`（中文语料为 `归档/`）。归档的判据是**语义**，不是字数或年龄——上游语料的校准例子里，533 词的局部 UI 笔记被删掉了，248 词的 event-sourced sessions 笔记被留下了。

流程与纪律见 [references/archiving.md](references/archiving.md)。最要紧的一条：**封存之后不可变**。归档树由一份 append-only 的 `manifest.json` 内容哈希清单钉死，任何对已封存字节的改写——哪怕只是重排格式——都会被门禁拒绝。这不是保守，是因为归档笔记一旦可以被悄悄编辑，「历史没被改写」就不再有任何保证。

## 门禁

脚本在 [scripts/](scripts/) 下，纯 Node 直跑，无任何 npm 依赖：

```sh
node scripts/verify-agent-note-classification.ts   # 路径、目录、文件名
node scripts/verify-agent-note-format.ts           # 头部、Status、必需与禁止的 section、双语配对
node scripts/verify-agent-note-format.ts --write    # 重录配对的一致性记录（只盖结构过关的配对）
node scripts/verify-archived-agent-notes.ts        # 归档三件套、封存哈希、基线比对
node scripts/verify-archived-agent-notes.ts --write # 封存新增归档（只追加）
```

全部支持 `--root <path>`，不带参数时从 cwd 向上寻找含 `.git` 或 `.agents/notes` 的祖先目录。主语言与是否要求配对由 `.agents/notes/harness.json` 声明（字段 `primaryLanguage`、`pairedDocuments`）。新仓库的脚手架和门禁安装用 `project-harness` skill 的 `bootstrap.ts`。

CI 里请用 `HARNESS_ARCHIVE_BASE_REF` 传入受信的基线提交（PR 的 base SHA），否则复用 runner 的浅检出可能让基线比对失效。

## 责任边界

这个 skill 拥有**决策记录的格式与生命周期**。文档的字数预算、层级归属、散文风格属于 `project-harness`。两者冲突时，格式与生命周期以本 skill 为准。
