# Agent Note: 文档链落根 docs/

Status: implemented

## 问题

链的位置原本是 `Dev/Docs/`——`Dev/` 是开发侧杂项的容器（第三方参考项目的本地 clone 也在那儿）。skill 的默认形态却是项目根 `docs/`：索引与活账模板按 `docs/README.md`、`docs/00-总览.md` 示例，子树规则模板是 `docs/AGENTS.md`，bootstrap 的文档预算候选面也写 `docs/AGENTS.md`。清单允许声明任意位置，但两套约定并存意味着每个读者、每个外部工具都要先被告知一次「我们不在默认位置」。

## 决策

链住项目根 `docs/`：索引 `docs/README.md`、活账 `docs/00-活账.md`、六个槽位目录与 `Archive/` 同在根下，子树规则薄档 `docs/AGENTS.md`。位置声明 = `scripts/harness/doc-index.manifest.json` 的 `index` 与 `scan`；扫描面 = `scripts/harness/markdown-patterns.json` 的 `docs/**/*.md`；存量硬换行债务随迁（同批重写 35 条路径，零新增、零陈旧，由 `markdown-wrap` 实跑验证）。`Dev/` 只余第三方参考项目一面（gitignore 面）。

## 曾考虑的替代方案

**留在 `Dev/Docs/`，靠清单声明位置。** skill 明确允许——「链的规矩是材料、声明、磁盘三者一致，不是名字具体叫什么」，改造面为零。落选原因：默认形态的价值在可预期；外部工具、新读者与 bootstrap 的模板面都默认 `docs/`，偏离一次就要在每个入口解释一次，而迁移成本只是一次路径重写，且有门自己验证。

## 后果

换来的：链的位置与 skill 默认一致，模板、预算候选面与外部约定不再有第二套；`Dev/` 的语义收窄为「第三方参考项目」一件事。副产物是决策记录活跃树随之纳入扫描面（`markdown-patterns.json` 点名 `.agents/notes/{proposed,implemented,rejected}/**/*.md`），笔记里的相对链接也从「约定」变成「机器校验」。

付出的：一次跨层迁移——所有指向链的活面引用（工具、常驻档、测试注释）要同批改，漏一处由 `markdown-links` 抓；历史记录与 `Archive/` 里的旧称不回改（那是当时的名字）。
