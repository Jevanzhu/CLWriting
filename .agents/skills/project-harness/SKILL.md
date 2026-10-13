---
name: project-harness
description: >-
  Set up and maintain a repository's engineering conventions and quality gates —
  项目管理 / 工程规范 / 代码评审 / 注释卫生 / 门禁 / 质量体系 / AGENTS.md / CLAUDE.md /
  CONTRIBUTING.md / 提交规范 / 测试可靠性. Use when establishing a new repository's
  conventions, deciding which checks run before a push versus in CI, adding a gate
  script, enforcing documentation standards, word budgets, or comment hygiene,
  reviewing a pull request, choosing between merge-forward and rebase, working with
  stacked or dependent PRs, or discussing error-handling and test-flakiness policy.
  Also use when an agent keeps ignoring project rules, when local checks and CI
  disagree about what "passing" means, or when briefing agents — task targets,
  acceptance criteria, what not to read, fan-out limits.
---

# Project Harness

把团队的协作规范变成**可执行的门禁**，而不是靠人记住的约定。当干活的主体是 agent 时，任何没写进文件、没接进检查的规则都等于不存在。

这不是一份清单，而是一套判据。规则会互相冲突（预算 vs 完整性、速度 vs 覆盖），冲突时要靠理由判断，不能靠背条款。

## 四条组织原则

**一、一个事实一个家。** 每条规则、每个事实只在一个文件里定义，其他地方链接过去。重复的规则会分叉，分叉的规则会让人不知道该信哪个。层级划分见 [references/doc-governance.md](references/doc-governance.md)。

**二、本地薄、CI 厚。** 提交钩子只做「立刻能修的小事」——格式化、空白检查、门禁校验。完整的测试矩阵、平台矩阵、覆盖率、构建产物验证交给 CI。理由不是省时间，是**本地全量跑会让开发者学会用 `--no-verify`**。

**三、门禁必须能失败，而且必须证明过它会失败。** 一个从没红过的检查等于装饰。新写任何门禁后，立刻制造一个违规输入确认它真的拒绝——`a guard that passes both ways guards nothing`。

**四、不可机械判定的规则交给评审。** 门禁管「文件在不在、链接通不通、预算超没超」；「这段话是否准确」「这个抽象是否正确」交给人和 agent 的评审。不要为了自动化而假装能判断语义。诚实声明边界的例子：「绿灯意味着在这些确切内容上确认过一致性，不意味着确认本身可靠」。

## 从零建立

```sh
node ~/.agents/skills/project-harness/scripts/bootstrap.ts --target <repo> [--notes-language en|zh] [--dry-run]
```

它会建好 Agent Note 生命周期树与归档清单、按目标仓库实测词数算出文档预算、把校验器复制到 `<target>/scripts/harness/`（**复制而非引用**——CI 和任何 clone 者必须能独立跑门禁），并列出需要你决策的剩余步骤。详细流程见 [references/bootstrap.md](references/bootstrap.md)。

**运行要求：Node ≥ 24**（门禁是 TypeScript 源文件直跑，靠 Node 的类型剥离特性）。版本下限的声明点是 `package.json` 的 `engines`，这里写的是副本。别把版本当成「装的时候对一次」的事：校验器副本不随 skill 自更新，而偏旧的 Node 上有些组合会让门禁**静默退出 0** 而不是报错——判断手上这一套装的是哪一版，看 `scripts/harness/version.json`。见 [references/gates.md](references/gates.md) 的「入口判断与运行版本」。

## 已有项目：别砸红墙

**目标仓库已经有内容时，加 `--adopt`。**

```sh
node ~/.agents/skills/project-harness/scripts/bootstrap.ts --target <repo> --adopt
```

直接把门禁装到一个有历史的仓库上，它会立刻抓到几年积累下来的所有死链、所有折行段落，而它**没有能力区分「历史遗留」和「你这次改坏的」**。一堵第一天就全红的门禁，第二天就会被关掉。

`--adopt` 把当前已存在的违规记进债务台账 `scripts/harness/baseline.json`，门禁从此只拦**新产生**的违规。台账是棘轮，只能变小：默认拒绝扩张（新的违规要显式 `--accept-new` 才能记进去），陈旧条目每次运行都会提示你可以删除。

这条设计和文档预算用的是同一个原则——**从实测值起步，而不是从理想值起步**。两者都只保证「只能变好」，不假装「立刻就好」。已装好的仓库也可以随时手工补记：任何带台账的门禁都接受 `--write-baseline`。

## 主体职责

### 门禁图

门禁是数据对象，不是一堆脚本。每个门禁声明 `needs`（前驱失败则跳过）与 `after`（只排序、不阻塞）两种依赖——这个区分解决真实的并发冲突：一个会重写共享产物的测试不该和读它产物的检查并行，但也不该在它失败时被跳过。

聚合模式（`run-gates.ts` 的 `MODES` 表）让分支保护只要求**一个**稳定的检查名，而不是枚举会随版本变化的矩阵腿。运行器在 [scripts/run-gates.ts](scripts/run-gates.ts)，测试在 [scripts/run-gates.spec.ts](scripts/run-gates.spec.ts)。设计与取舍见 [references/gates.md](references/gates.md)。

### 提交前的证据选择

按改动**触及的面**选最小充分证据，不要反射式跑全量：

| 改了什么 | 跑什么 |
|---|---|
| 行为逻辑 | 拥有该行为的那个测试文件（且必须有会因该回归而失败的用例） |
| 文档 / 决策记录 | 文档门禁 |
| 公开导出 / 构建配置 | 构建 + 产物冒烟 |
| 模型或用户可见输出 | 对应的快照 |

推送前**不要**为了「再确认一次」重跑已经通过的检查。反过来，`Do not push and hope CI differs.` 细节见 [references/pre-push.md](references/pre-push.md)。

### 文档层级与预算

每个层级有明确的职责边界和「不属于这里」的清单。字数预算用 `wc -w` 计数、只在超限和文件缺失时失败，超限的处理顺序是**迁移 → 精简 → 提高上限**，且提高上限必须在同一个改动里给出理由。`A too-low ceiling is a budget bug.` 见 [references/doc-governance.md](references/doc-governance.md)。

### 文档链

常驻文档管「事实住哪」；链管「一件事从提出到了结走哪些档」：索引（导航）、活账（未了结事项的唯一清单）、槽位目录（评审／设计／执行／调研／规范）、归档（明说的冻结）。判据包括：活账一行一条、只记「一句结论 + 指针」；评审必须给出通过／有条件通过／退回之一；归档前核验内容与历史一致、未了结的事先立开放项、归档 commit 号留痕。`verify-doc-index.ts` 强制索引与槽位一一对应——契约是仓库数据（`scripts/harness/doc-index.manifest.json`，`{}` 即不带链）。见 [references/doc-lifecycle.md](references/doc-lifecycle.md) 与模板 [templates/ledger.md](templates/ledger.md)、[templates/docs-index.md](templates/docs-index.md)。

### 宣称值对账

文档里写下的数字与清单是**副本**，不会自己更新。`verify-doc-claims.ts` 把每条宣称（数字或清单 + 源头命令）与命令的实测输出对账：`expect: atLeast` 是把「门禁表只增不减」这类下限变成机器可判的形态，`list` 类管「新增了目录而文档没提」。同一事实只在一个地方写数值，别处指过来。这个门禁**有意不挂台账**——改一个错数比记一笔错账便宜。契约是仓库数据（`scripts/harness/doc-claims.manifest.json`，`{}` 即无宣称），见 [references/gates.md](references/gates.md)。

### 注释卫生

注释只写代码作用与需要说明的东西（约束／不变量／语义／平台差／同步关系），**修复史归 git**。机器判据分两族，缺一不可：写进注释的编年史（日期、轮次、批次括注）与**清理后的残形**（括注被切空、只剩破折号）——只做前者时，清理器留下的半痕会被判成干净。**字面量是红线**：扫描器只读注释面，字符串、模板串、正则里的标签样文本永不报告，清理工具不得触碰生产字面量。例外与「被测试钉住的注释」都进 manifest 显式登记——各带理由与钉住它的测试，陈旧时门会催删。扫描面不可信（根缺失、零文件、不可读）时 fail-closed 报红且不入台账。见 [references/comment-hygiene.md](references/comment-hygiene.md)。

### 散文标准

编辑文档、注释、JSDoc、提示词、面向用户的字符串时的标准。核心是**保留完整命题**：删字之前先逐条识别 actor/action、条件与时序、情态（must/may/never）、负面保证与例外、所有权与副作用、失败模式。`A smaller word count alone is not an improvement.` 见 [references/prose-standard.md](references/prose-standard.md) 与 [references/prose-examples.md](references/prose-examples.md)。

### 错误处理

类型化失败、处理归属、围堵范围、可见报告。三条最常被违反的：`Logging alone is not recovery`、`Catching limits exception propagation, not mutations`（只有受影响状态的所有者才能确立安全续行）、`Never claim success, rollback, or safe retry without guarantees`。见 [references/error-handling.md](references/error-handling.md)。

### 代码评审

评审的目标排序是正确性、生命周期、安全、必需行为**先于**风格。`一条有据可依的阻断项胜过一串 nit`。关键的一条流程要求：先核实 PR 的真实 base 与 head，再看 diff。见 [references/review.md](references/review.md)。

### 测试可靠性

并发下非确定性失败的根因分类与修法。核心是**拒绝掩盖型修复**——加长超时、加重试、跳过的测试不是修好了，只是不再报告问题。两条配套纪律：**先判该不该写**（一条改动 = 一条回退即变红的用例；断言只锚对外可观察面），**表面绿而覆盖消失是门禁的事**（`.only` 一律红，无条件 `.skip` 红，条件式环境门合法——`verify-test-hygiene.ts`）。见 [references/test-reliability.md](references/test-reliability.md)。

### Agent 工作纪律

派活与动手的判据，多数以文字存在而不是门禁（能机器判定的部分已落到别处）。**任务书三件**——靶点、验收判据、不读面，缺件先问再动：agent 的真实成本不是输入贵，而是范围无界。**先定位后阅读**：检索定靶 → 只读命中文件与一跳调用方，结论锚 `file:line`，不写阅读流水账；确需通读先报范围与理由。**通读即专项**：只在作者明示的审计任务下成立，审计只产报告、修复另开靶向任务。**子 agent 单波 ≤4**：上限跟复核能力绑定，不跟核数绑定。**一个批一个主题**：挂账项与待拍板各自成批，夹带的另开批。**提交与对外文案**不引作者指令原文，决策以结论转述。见 [references/agent-work.md](references/agent-work.md)。

### 历史与归档

PR 历史怎么组织、堆叠 PR 怎么落地、什么时候 merge-forward 什么时候 rebase、重写历史的纪律。最硬的一条：`Raw --force is never allowed`，改写必须用带 lease 的形式并在远端移动时中止。见 [references/history.md](references/history.md)。

### 治理模型（团队化时可自建的部分）

加权审批、Issue 看板状态机、发布序列、双语配对——这些机制在上游项目里运作良好，但都依赖组织级基础设施（GitHub App、Projects v2、Python + Pygments、多发布序列）。它们**没有**随本 skill 提供可运行代码。若你将来团队化，[references/governance-model.md](references/governance-model.md) 讲清了每个机制解决什么问题、核心算法是什么、按什么顺序自建最划算。

## 模板

[ templates/](templates/) 下有起步用的骨架：`AGENTS.md`（standing orders 层）、`docs-AGENTS.md`（文档层级与预算表）、`ledger.md`（活账）、`docs-index.md`（索引）、`lefthook.yml`（薄提交钩子）。

## 责任边界

本 skill 拥有**文档层级与文档链、注释卫生、门禁、评审、错误处理、测试可靠性、历史与发布纪律、agent 派发与阅读纪律**。

决策记录的格式、生命周期与归档属于 `agent-notes` skill。两者都涉及 `.agents/` 下的内容：写决策记录时用 `agent-notes`，制定「规则住在哪个文件」时用本 skill。

仓库自己的技术栈（包管理器、测试框架、语言）不在此 skill 的管辖范围——模板与示例只给判据，具体命令由你在 `run-gates.ts` 的门禁表里填。
