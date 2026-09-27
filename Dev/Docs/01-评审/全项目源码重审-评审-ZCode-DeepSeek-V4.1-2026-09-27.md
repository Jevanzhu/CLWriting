# 全项目源码重审（完成质量 / 完成进度 / 简洁优雅度）

- 执行模型：ZCode（模型 new-provider/deepseek-v4.1-flash；两个只读子 agent，同模型）
- 日期：2026-09-27
- 基线：分支 `mac` @ `1bd4a17a`，工作树净（评审前后 `git status --porcelain` 均空）
- 口径：不读 `Dev/Docs` 既有文档与历轮评审报告结论，只以源码、测试与构建配置为据；子 agent 的每条高危结论均由主评审回溯源码复核，**已驳回 3 条**（见 §六）
- 状态：**已收口**（P1×0 / P2×2 / P3×11；P2 办结并全门回归、P3 全数处置〔9 实修 / 2 记理由〕——见 §十；评审当时为纯评审、按指令未改源码，现场记录见 §八）

## 〇、门实测（本机 macOS / darwin arm64）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型（后端） | `npx tsc --noEmit` | 通过（exit 0） |
| 类型（前端） | `npm run typecheck:web-next` | 通过（exit 0） |
| Lint | `npx eslint . --max-warnings 0` | 通过（exit 0，含存量抑制） |
| 格式 | `npx prettier --check .` | 通过（全库已格式化） |
| 单测 | `npx vitest run` | **1286 文件通过 / 8751 例通过 + 8 跳过**，exit 0，164s |
| 覆盖率 | `npx vitest run --coverage` | **exit 1**：`Coverage for branches (87.86%) does not meet "src/rag/**" threshold (88%)`；全库聚合 S 88.53 / B 80.18 / F 87.62 / L 91.25 |
| 计数门 | `npm run check:counts` | 通过（1286 文件 / 8333 单测 / 33 e2e spec / 54 用例） |
| 文档门 | `npm run check:docs` | 通过 |
| 注释门 | `npm run check:comments` | 通过（扫描 579 文件，零批号标签） |
| 打包门 | `npm run check:packaging` | 通过 |
| 知识门 | `npm run check:knowledge` | 通过 |

e2e（playwright）本轮未跑；mac/linux CI 腿未跑。

## 一、总评

### 1.1 完成质量——**高**，达到可发 1.0 的水准

- **未发现 P1**。数据面（原子写、跨进程锁、journal 崩溃恢复、墓碑/回收站、drain 排水段）逐条走通，未见数据丢失路径。
- P2 两条都不是「功能坏了」，而是「同一类防线只修到一处」的第二副本（§三）。
- 八门里七门全绿；唯一红项是本地覆盖率的一条域级分支阈值，与 CI ubuntu 腿校准口径有关，且**本轮复现了上一轮报告的同一数字**（§三 P2-2）。
- 8751 例单测 + 33 个 e2e spec 的实测规模，与 1286 个测试文件的三层结构（直测 / 集成 / 治理）相称，没有明显凑数面。

### 1.2 完成进度——**1.0 首发前的收尾期**，但**治理面已经吃掉了一部分维护余量**

- 产品面的开放项很少（总览第三节：1.0.0 首发 + 余下三个未排期候选），说明功能面基本冻结。
- 但**最近 8 个提交里有 6 个是评审质量债修复批**（批 5/6/7 及其分刀），其中批 7 的第 1~4 刀全是在修**批 6/批 5 自己引入的问题**：注释门自身的五处盲区、注释面被清理器切坏后的复原、抑制台账清退。这是「治理工具自转」的典型信号——投入在涨，而**被治理对象（注释面）的净质量并未同步上升**（§三 P2-1）。
- 结论：功能完成度高、进度接近可发；但**注释/文档这套自建纪律的工具链仍在返工中**，建议在 1.0 首发前把这条链一次收干净，而不是再开第 8 刀。

### 1.3 是否足够简洁优雅——**骨架优雅，注释面是负担，局部有实质重复**

- 优雅的部分是真的：`defineRoute` 的 parse/gate/handler 三段式、`BUSY_MATRIX` 意图×信号矩阵、TtlCache 单源工厂、`createSerialChainMap` 系列链原语、`shared/text` 码点单源、`check` 域的名册判定单源——这些都是「一次抽象、多处受益」的形态，不是摆设。
- 不优雅的部分集中在**注释体量与成分**：源码 121,964 非空行里注释行 36,331，占 **29.8%**；其中含「此前 / 原实现 / 已修 / 事故 / 沿革 / 先例 / 收编 / 口径不变」一类考古词的注释行 2,908 行（**占全部注释的 8.0%**）。这些内容记录的是「哪一批改的、改之前是什么」，**正确归宿是 commit message 与报告正本**——它们混在约束说明里，让「读注释为了知道该怎么做」变成「读注释还得先过滤一段历史」。
- 实质重复：**16 组函数体逐字节相同**的副本对，其中 `saveProvidersOr500`（providers.ts / rag-providers.ts，404 字符）、`readSafe`（draft-pipeline.ts / outline.ts，148 字符）是跨层复制（§四 P3-1）。
- 体量分布健康：574 个源文件、中位数 153 行，8 万行级代码里只有 11 个文件 ≥800 行、6 个函数 ≥300 行，没有「巨型文件」问题。长函数（≥150 行）58 个，其中 16 个 ≥250 行——集中在 api 层 handler 与适配器，属可接受的编排体量，但 `src/studio/server/index.ts:380`（383 行）、`api/analysis.ts:345`（382 行）、`document/service.ts:226`（371 行）值得再拆一刀。

## 二、摘要

| 级别 | 条数 | 一句话 |
|---|---|---|
| P1 | 0 | 未发现数据丢失 / 安全 / 主流程不可用 |
| P2 | 2 | 注释面被清理器切坏 48 处且门看不出来；本地覆盖率 rag 分支贴线破门 |
| P3 | 11 | 零引用导出、重复函数体、注释考古密度、类型断言谎言、注释门盲区等 |

**三条子 agent 高危结论已被主评审驳回**（§六），未计入本表：SSE 连接句柄泄漏、`awaitOrchestrationsSettled` 排水段回归、`fallbackToolSeq` 跨 attempt 复用。记录在此，避免后续轮次把已否定项当存量债重复修复。

## 三、P2（2 条）

### P2-1 注释清理器把注释切坏 48 处，且注释门结构上看不出来

**现象。** 全库现有 48 处「已损坏的注释文本」，按形态分四族：

| 族 | 数量 | 形态 | 示例 |
|---|---|---|---|
| 残标签 | 37 | `（-①）` `（-优化` `（-源码）` `（-win适配）`，即括注内容被删空、只留破折号 | `src/ai/pricing.ts:2`：`价格表与金额口径——providers.json 加性扩展（-①）。` |
| 空括号对 | 6 | 跨行 `（` … `）` 之间零字符 | `src/studio/server/api/io.ts:10-11`：`…删 handler 内冗余复核、（` / `）随之删 ctx.token 死字段` |
| 模板注释残片 | 3 | `.vue` 模板注释以 `：` 起首（前半句被切走） | `src/studio/web-next/src/components/workbench/WbDraftCard.vue:65`：`：生成中（genBusy）禁存——半章残稿不得落盘` |
| 纯标点行 | 2 | 整行只剩标点 | `src/studio/web-next/src/composables/useSse.ts:156`：`//。` |

（四族之外另有 11 处「相邻两行尾/首重叠」的重复粘贴残迹，如 `src/format/types.ts:148-150` 的 `原样承载，对齐 LeadMeta` 被复制成两行。其中 3 处的 blame 是 `737352f7`（`format/yaml-patch.ts:25`、`format/types.ts:149`、`format/piece-list-core.ts:130`），属清理器**内容重建**时的副产物；另 8 处来自更早提交（`91fca0ce` / `7eb5b349` / `1600cb0f` / `119d9523` / `6a484f3f` / `63e4c1fc` 等），性质相同但不属本轮归因的清理链——故只在此一并提示，不并入 48 处计数。）

**归因（按「引入该残形的提交」归属，`git log -S <残形串>` 反查，非推理）。** 48 处的分布：`f493f537`（批 5「P3-1 注释考古化」）**43 处**、`737352f7`（批 7 第 2 刀「注释面第二批复原」）**5 处**——即**全部 48 处都产生于「注释清理」这一动作本身**，无一例外。（按 blame 行归属会多出 `f6d028fb` 1 处，那是因该批重排了缩进而继承 blame；按引入提交归属为 0。两口径的差异点 = `src/studio/server/api/task-gate.ts:648`。）父版本对照逐条确认，例如：

```
src/studio/web-next/src/components/shelf/ShelfHeroList.vue:3
  父版: * 书架「继续写作」hero 紧凑单行（list 视图）——R0912-C2-P3-5（2026-09-12 独立重评
  HEAD: * 书架「继续写作」hero 紧凑单行（list 视图）——（
src/studio/server/api/io.ts:10
  父版: * 在路由分派前拦一切 POST——R1010-P3 删 handler 内冗余复核、R0911b-B-P3-2（2026-09…
  HEAD: * 在路由分派前拦一切 POST—— 删 handler 内冗余复核、（
```

**为什么门看不出来（关键，决定修法）。** `scripts/check-comments.mjs` 的判据是「注释里出现批号/评审过程词的**标签形态**」。清理器把标签和它依附的括注一起删掉后，留下的残形**不含任何标签**，因此门判定为干净。实测（直接 import 门的纯函数 `findTagHits`）：

```
未命中  ←  （-deepseek-v4.1-flash ）残形
未命中  ←  （-优化）残形
未命中  ←  空括号对：// 在路由分派前拦一切 POST—— 删 handler 内冗余复核、（
未命中  ←  纯标点行：//。
命中    ←  注释内真正的批号：// …（R0916-6-P3-15）
```

门的这一性质已经在 `f7a0c152`（批 7 第 1 刀）的 commit message 里被作者自己写下：「删正文不产生命中，门对此完全无感」。本轮的贡献是**把这个「无感」量化成 48 处并定位到具体提交与具体行**——批 7 第 1 刀加宽了标签形态表（补二级域号、连字条目号、括注轮次等），但**没有加「切除后残形」这一类判据**。

**影响。** 不影响运行时（注释不参与执行），但影响两件真实的事：(1) 注释作为**约束说明书**的可读性——读者遇到 `（-①）` 无处可查；(2) `CLAUDE.md` 把注释面定为「机器门守护的纪律面」，而门在这条路径上是**结构性失效**的，等于该纪律的宣称强于实际防线。

**修复方向（不代为实施）。** 门的判据应补一族**「切除后残形」检测**——纯标点行、跨行空括号对、以破折号/圈号/`源码|优化|适配` 起首的括注内容缺失、模板注释以 `：` 起首。这四类都能写成零误报判据（本轮实测全库这些形态**只命中真伤**：37/6/3/2 里没有一条是合法折行——判据经「父版同文行 + 批号正则」双重确认，未确证的候选已人工逐条核对后剔除）。同时这 48 处需要一次人工复原——父版本已经给出确切原文（`git show <commit>~1:<file>` 逐行可对，例如 `io.ts:10` 的父版是 `* 在路由分派前拦一切 POST——R1010-P3 删 handler 内冗余复核、R0911b-B-P3-2（2026-09-11 全量重评修复批）随之删 ctx.token 死字段`）。

**注：** 该提交链上「注释面复原」这一动作本身已经做了两轮（批 5 一轮、批 7 一轮），本条不建议再起第三轮纯清理——建议**先把残形判据入 CI，再用它一次性清完并验证**，否则第三轮难以避免又制造第四轮的残片。

### P2-2 本地覆盖率 `src/rag/**` 分支破门（87.86% vs 88%），且与上一轮报告同一数字

**现象。** `npx vitest run --coverage` 两次独立运行结果一致：

```
ERROR: Coverage for branches (87.86%) does not meet "src/rag/**" threshold (88%)
```

**定量余量（本轮实测 vs 域级门）：**

| 桶 | 实测 S/B/F/L | 门 S/B/F/L | 余量（S/B/F/L） |
|---|---|---|---|
| `src/rag/**` | 93.55 / **87.86** / 96.70 / 95.39 | 91 / **88** / 94 / 93 | +2.55 / **−0.14** / +2.70 / +2.39 |
| `src/learn/**` | 94.19 / 73.07 / 95.23 / 96.50 | 94 / 71 / 93 / 94 | **+0.19** / +2.07 / +2.23 / +2.50 |
| `src/document/**` | 90.46 / 84.03 / 95.30 / 93.64 | 90 / 83 / 94 / 91 | **+0.46** / +1.03 / +1.30 / +2.64 |
| `src/ai/**` | 93.57 / 87.29 / 95.80 / 95.06 | 91 / 85 / 95 / 93 | +2.57 / +2.29 / **+0.80** / +2.06 |
| `src/events/**` | 95.83 / 92.28 / 99.42 / 96.65 | 92 / 90 / 98 / 95 | +3.83 / +2.28 / +1.42 / +1.65 |

**为什么这不是「简单调阈值」。** `vitest.config.ts:129` 起的大段注释写明：阈值按 **CI ubuntu·24 腿**校准（阶段 43 决策），规则是「绿门只紧不松（floor(实测−2pp) > 现值才升）/ 红门按 floor(实测−2pp) 下调 / 其余维持」。`src/rag/**` 的门 88 就是 ubuntu 实测的 floor 值，本机 mac 实测 87.86 低 0.14pp 属平台差异——上一轮报告 §8.2 P3-7 已按「不调阈值」处置，并留了「后续批触此域先本地跑 coverage 自查」的纪律。本轮**复现同一数字**，说明该纪律没有被遵守（批 5 动了 `src/rag` 8 个源文件 + 38 个测试文件；批 6/7 又动了注释与格式）。

**本轮新增的事实（上一轮报告没有的）。** `src/rag` 在这几批里**被改过**：`5f57a527..HEAD` 区间 `src/rag` 8 个源文件 131 插入 / 112 删除、`test/rag` 38 个文件增删重命名（含三个旧测试文件被并入新文件：`r0911-g-p3-4-close-cache` → `rag-prepared-cache-release`、`r49-probe-row-truncation` + `re2-p3-truncated-boundary` → `probe-row-truncation`，用例标题逐条比对确认**未丢失**）。其中 `119d9523` 是测试资产行为化（P3-5），把 fixture 改成了行为断言——**测试重构之后的实际覆盖率没有人在本机复跑验证**，只跑了 `vitest run`（用例全绿）就收了。

**结论与建议。** 这不是阈值问题，是**「改了覆盖率相关的代码/测试，但没在本地跑 coverage 自查」的流程缺口**。建议：要么在本机补 `src/rag` 那 0.14pp（挑 `embed.ts` 未覆盖的 3 处异常分支补直测，见下），要么按 cfg 既有规则在**拿到 ubuntu 腿实测后**再决定（而不是本机红着收口）。`src/rag/embed.ts` 当前 87.69 S / 71.66 B，未覆盖行集中在 `58-61`（warn 表 FIFO 溢出）、`123-124`（响应条数不匹配）、`168`（超时/网络异常分支）——这三处都是**错误路径**，正是「行为化改造后容易掉出来」的那一类。

## 四、P3（11 条）

### P3-1 两处跨层函数副本逐字节相同

| 函数 | 副本 A | 副本 B | 体量 |
|---|---|---|---|
| `saveProvidersOr500` | `src/studio/server/api/providers.ts:66` | `src/studio/server/api/rag-providers.ts:46` | 404 字符，**逐字节相同** |
| `readSafe` | `src/process/draft-pipeline.ts:343` | `src/studio/server/api/outline.ts:324` | 148 字符，**逐字节相同** |

同批 `f6d028fb`（批 7 第 3 刀「三条第二副本补修」）已经收编了忙闸单源、stopReason、遮罩三处第二副本，**这两处漏在射程外**。另有一族较弱的同体副本（`loadDismissed` / `normalize` / `stripFrontmatter`+`ruleStripFm` / `errMsg`+`rawErrorMessage` / `cancelConsumer` 等，共 16 组函数体逐字节相同），多数是「前后端各留一份小工具」的合理隔离，不必强求合并；但 `saveProvidersOr500` 与 `readSafe` 同属一个域（server/api 与 process/server 同层），合并成本低于维护成本。

### P3-2 注释考古密度 8.0%，且「考古」与「约束」混排

36,331 行注释里 2,908 行（8.0%）在讲「此前如何/原来如何/已修/事故/沿革」。抽样看，这些内容常常和当行真正的约束说明连在一起写，例如 `src/format/yaml-patch.ts:25` 一带（清理前）：

```
* 读改写场景不走 stringifyBookConfig 全量重生成——解析模型只保
* 已知字段，作者的 # 注释、未知段、未知子键会静默丢失。此函数只重写目标段的
```

前半是**约束**（为什么不能全量重生成），后半是**沿革**（这个约束怎么来的）。建议的信息架构是：约束留在源码，沿革进 commit message 或报告正本——这也是 `CLAUDE.md` 已定的口径（「批号与日期正本 = git 历史，blame 一查即得」）。目前的注释门只禁「标签形态」，不禁「沿革叙述」，所以这条纪律实际上靠自律。

### P3-3 注释门的三处残留盲区（除 P2-1 的残形外）

直接 import 门的纯函数实测：

| 盲区 | 实例 | 门判定 |
|---|---|---|
| 小写双字母域号 `（ii-N）` | `src/ai/provider/adapter-errors.ts:125`、`src/studio/web-next/src/components/ui/ModelListEditor.vue:38` | **未命中**（大写 `II-4` 命中，小写漏） |
| 模型名当批号载体 `（-模型名 ）` | 7 处，如 `src/worker-async.ts:2`、`src/studio/web-next/src/composables/useSse.ts:327` | **未命中** |
| 运行时代码串里的批号（**这不是注释**） | `src/desktop/server-manager.ts:500/572/578`、`src/document/manifest.ts:498`、`src/document/service-meta.ts:247/595`、`src/studio/server/api/state.ts:199`、`src/ai/orchestrate/chat/turns-phases.ts:474/490/493` | 不在门的射程内 |

第三类值得单独说：这些批号会**进到作者可见的界面/日志/错误信封**里，例如 `state.ts:199` 的 `'作者确认：接受该次未完成保存的现状，清除崩溃恢复提示（R0912-1b 人工消解）'` 直接是提交给 journal 的文本，`server-manager.ts:572` 的 `'R0916-7-P3-17：在途轮已占，开轮被拒'` 是运行时抛错。门的定位是「注释面零批号」，所以这不是门的 bug，而是**纪律范围与可见面的口径差**——批号写进用户可见文案，作者读到的是一串内部编号。7~11 处，建议随下次触碰这些文件时改成自解释文案（`state.ts:199` 那处已被 `test/state/journal-acknowledge-endpoint.test.ts` 以 `R0912-1b` 为 describe 名锚定，改文案需同步该测试的 claim 方式）。

### P3-4 零引用导出 11 处（全库导出 1,693 个）

仅在自身文件内使用、其余 src/test/scripts 零出现：

`DIR_FP_YIELD_EVERY`（check/tree-issues-cache.ts）、`RELEASES_URL` 与 `UPDATE_CHECK_TIMEOUT_MS`（update/check.ts）、`SAVE_BODY_ENVELOPE_BYTES` 与 `contentByteLength`（web-next/shared/save-limits.ts）、`createTaskGatePort`（ai/orchestrate/task-gate-port.ts）、`endpointHost`（studio/server/api/host-change-guard.ts）、`mergeLeadUpdateEntries`（process/lead-update-draft.ts）、`setDevProxyApplied`（desktop/windows.ts）、`stripFencedLines`（format/section-heading.ts）、`writeSplitUnit`（export/index.ts）。

这 11 个里有 3 个是**故意导出的**（`createTaskGatePort` 是实例化入口、`setDevProxyApplied` 是闭包捕获的写入口、`SAVE_BODY_ENVELOPE_BYTES` 是可调常量），其余 8 个是「拆分/重构后 export 前缀忘了摘」的残留。11/1693 = 0.65%，属轻微卫生问题。

### P3-5 `ttl-cache.ts:170` 的非空断言与它旁边的不变量声明不一致

```ts
let probe: string
if (cached && cached.probeTs !== undefined && now - cached.probeTs < ttl) {
  probe = cached.probe!          // ← 断言 probe 必在
}
```

类型上 `probe?: string` 与 `probeTs?: number` 是两个独立可选字段，断言成立依赖「写 probeTs 时必写 probe」这条隐含不变量。查 `store()`（225-227 行）确认：`probeTs` 非 undefined 时必产 `probe: j.probe`，**且 `judge()` 的 compute 分支恒返回 `probe`**（signature 形态下 `probe` 是 `string` 非可选），所以断言当前成立、非真 bug。但这是**靠调用序维护的类型谎言**：`forgetPrefix`/`clear`/`forget` 之外的任何新写入口（例如将来加「部分失效只清 probe」）都会静默打破它。建议改为显式守卫（`cached.probe ?? probeOf(key)`）或在 `store()` 处用统一形状的判别联合。

### P3-6 `task-gate.ts:210-225` 释放闭包的顺序与它的注释互相矛盾

```ts
return () => {
  if (released) return
  released = true
  try { if (lockRelease) lockRelease() } catch { /* 锁文件残留交 stale 接管 */ }
  state.running.delete(key)
}
```

上面三行的注释写「**先删锁文件再清 Set**：反序会让并发 acquire 在文件已删、Set 未清的窗口读到双闸」。但 `released = true` 被提到了最前，而**并发 `acquire` 的判据是 `state.running.has(key)`（199 行）**，不是 `released`。所以窗口确实存在：`released` 置位 → 锁文件删 → Set 未清，这段时间内另一路 `acquireIn` 仍会读到 `state.running.has(key) === true` 并返回 null（409）——即**多拒一次，不会双持**，方向是安全侧的。因此这是一条**注释与实现的措辞失配**（注释描述的风险方向不成立），不是缺陷；但这类「注释声称的时序保证与代码不符」正是本报告 §三 P2-1 想根治的同一类问题，改注释即可。

### P3-7 `src/ai/rules/book-rules.ts:4-6` 头注陈述的是一个已被推翻的结论

头注写：

```
 * 当前状态（前）：readBannedEntryWords 显式排除 AI味标签词
 * （只注入不机检——但实际注入侧也未接线，等于「既不注入也不检验」）。
 * 后：toPrompt 注入词列表 + check 检测命中——两侧都有（黄级）。
```

而现行实现（`src/ai/rules/index.ts:43 ``applicableRules` / `:74 `rulesPromptParts` / `src/ai/tasks/spec.ts:129` 的消费点）注入侧**已经接线**。这段头注在考古时保留了「前」的旧结论却没同步「当前状态」的定性，读者会误判该规则未生效。

### P3-8 前端 store 的 4 条环靠 `KNOWN_CYCLES` 登记维持，不是靠结构消除

复现 `test/governance/webnext-store-import-cycles.test.ts` 的枚举口径，实测存在 9 条环，4 条基环均已在 `KNOWN_CYCLES` 登记：

| 环 | 运行时调用点（已确认非死代码） |
|---|---|
| `prefs → ui → prefs` | `prefs.ts:614/712/718` 调 `useUiStore().toast`；`ui.ts:157` 调 `usePrefsStore().setOverlayDimmed` |
| `doc → tree → doc` | `doc.ts:198/352/357/516/539/565/619` 调 `useTreeStore()`；`tree.ts:161` 调 `useDocStore().syncCleanWithTree()` |
| 其余 2 条基环 | 同类互调 |

这些都是**真实业务耦合**（偏好要弹 toast、文档要刷树、树要同步 clean），不是可由依赖注入消除的假耦合——`useStaleGuard` 已经是这个方向上的正确抽象。登记白名单是合理处置，登记在此仅为记录「这不是已消除，而是已登记」。

### P3-9 `eslint-suppressions.json` 304 条（文件·规则）条目 / 635 计报 / 217 文件

按规则分布：

| 规则 | 计报 | 文件数 |
|---|---|---|
| `@typescript-eslint/no-floating-promises` | 104 | 44 |
| `@typescript-eslint/no-base-to-string` | 87 | 30 |
| `@typescript-eslint/no-misused-promises` | 86 | 38 |
| `@typescript-eslint/no-unnecessary-type-assertion` | 81 | 44 |
| `complexity` | 57 | 53 |
| `@typescript-eslint/no-unsafe-assignment` | 39 | 13 |
| `no-unsafe-member-access` | 34 | 6 |
| `max-depth` | 28 | 8 |
| `restrict-template-expressions` | 26 | 2 |
| 其余 | 93 | — |

前三名（floating / misused promises 合计 **190 计报**）是**异步正确性类**，不是风格类；`no-base-to-string` 87 计报意味着有 87 处在把非字符串对象隐式转成字符串（可能有 `[object Object]` 面）。批 7 第 4 刀刚摘净了 `src/ai/runner.ts` 的一批抑制（11 条），方向正确；建议下一批优先清浮空 Promise 族，因为那类抑制最可能掩盖真实缺陷。单文件最重的三处：`test/ai/provider/store.test.ts`（24 条 floating）、`src/studio/web-next/src/components/workbench/WbAdvanced.vue`（24 条 restrict-template-expressions）、`src/ai/provider/openai-adapter.ts`（15 条 max-depth）。

### P3-10 敏感/风险面自检：默认值安全，两处可加固

- **已做到的：** `safeTokenCompare` 走全链路写闸（`index.ts` isWrite 前置）、跨进程锁使用 `O_EXCL` + payload 校验释放 + 续期、`vault` KEK 有 `VaultOsKeyMissingError` 防降级、`git` 调用已禁 `core.fsmonitor`/hooks（上一轮 P2-2 修复）。
- **可加固 1：** `src/studio/server/api/stream.ts` watchdog 的 `forceRelease`（约 111-130 行）在判定「手动写稿疑似挂起」后**只释放 spawn 闸 + 发 warning，不 abort 在途请求**（代码注释自称「底层任务未中断，迟到结果按既有迟到覆盖口径处理」）。这是有意的设计：宁可让迟到结果覆盖，也不中断在途 LLM 调用（费用已产生）。但要注意它与 `sample` 路径的 `abortLikeUser` 是**两段式**（一段 abort 类用户中止 / 二段强释放），所以行为是「先试 abort，20 分钟后仍无进展才强放闸」——实际风险窗口是「请求无视 abort 信号且持续无进展」，此时闸已释放而请求仍在写。建议把这条加到 §三 P2-1 同类「注释宣称 vs 实现」的复核清单里（当前注释已如实写明，仅提示后续改动别把它当 bug 误修）。
- **可加固 2：** 上文 P3-3 第三类——批号进用户可见文案（7~11 处）。

### P3-11 文档面一致性：`Archive/` 实有 16 篇，`Dev/Docs/README.md` 与总览的表述不一致

`Dev/Docs/README.md` 的 `Archive/` 行写「16 篇」，总览 §1.3 写「Archive 实有 15 篇」。实测 `find Dev/Docs/Archive -name '*.md' | wc -l` = **16**。`check:counts` 只校验根 `README.md` 的对账数字，**不校验 `Dev/Docs` 内的计数**（`check-docs` 只管篇幅与禁语），所以这处不一致不会被门拦住。数量级很小，但属同一类「索引面自称值 ≠ 实测值」问题，建议随下次触碰文档面时对齐（或把该计数纳入 `check:counts` 的校验面）。

## 五、亮点（确证，非客套）

1. **数据面防线是真的。** 删书/改名之前的「五连 drain + 闸后复查」（`books-lifecycle.ts:265-282`：`drainDocumentSaves` → `drainFilePutChainsUnder` → `drainForeshadowSaveChains` → `drainDraftSaveChainsUnder` → `drainStructureChainsUnder`，随后 `busyGate` + `hasBackgroundTasks` 复查）逐条对得上每个孤儿写路径的成因，注释里连「哪条 drain 挡住哪条孤儿写」都写明了死锁核查结论。
2. **「一次抽象、多处受益」的实例密度高。** `defineRoute` 三段式（parse/gate/handler）、`BUSY_MATRIX` 意图×信号矩阵（`task-gate.ts:530` 起，含 spawn/auto-write/chat/generate/structure 五种意图）、`TtlCache` 单源工厂、`createSerialChainMap` 链原语、`shared/text` 码点单源、`check` 域名册判定单源、`capView` 渲染上限单源——不是各有各的写法。
3. **测试资产分层清楚、治理门成体系。** 1,286 个单测文件 / 8,751 例，`test/governance/` 下 10 个常驻治理测试（依赖方向、方向环、stores 环、覆盖率桶 glob 反向守卫、可见性对账、mock 零计费、token 豁免同步等）——这些门的存在让「回潮」有机器成本，是长期可维护性的关键投入。
4. **源码内 `TODO/FIXME/HACK` 为 0。** `grep -rn -E "TODO|FIXME|HACK" src --include='*.ts' --include='*.vue'` 零命中（`src/knowledge/update.ts:138` 的 `'TODO'` 是知识库误报语境的**数据**，不是标记）。在一个 8.5 万行的代码库里这是罕见的一致度。
5. **类型逃逸受控。** `as any` 22 处、`@ts-ignore`/`@ts-expect-error` 16 处、`eslint-disable` 28 处——相对 8.5 万行，密度很低，且 `tsc`/`vue-tsc` 双绿。
6. **平台的实证习惯。** `vitest.config.ts` 的阈值注释把「为什么 win 口径不等于 ubuntu」写成可复算的推演（阶段 43 的两次实测反例），`check-comments.mjs` 头注写明「不靠推理靠批前基线全库实测定位」——这种「结论附复算路径」的写法值得保持。

## 六、已被驳回的子 agent 结论（如实记录，防重复修复）

| 子 agent 结论 | 主评审复核 | 判定 |
|---|---|---|
| SSE 连接句柄在 403 早退路径泄漏，`sseConnections` 计数器只增不减 → DoS | 句柄登记在**全部 early return 之后**（`stream.ts:299-308`：token 校验 403 先 return，`handle` 在 303 行注释「校验通过后才登记」）；另用 Node 脚本复现 `req.on('close')` 在 keep-alive 403 下正常触发 | **驳回**（无泄漏；且设计上有防泄漏注释） |
| `awaitOrchestrationsSettled` 排水段丢失了 settle 后的 running 复查（回归） | `books-lifecycle.ts:265-282` 在 settle await 之后确有 `isChatRunning(name) \|\| isSelfHealRunning(name)` 复查 + `busyGate` + `hasBackgroundTasks` | **驳回**（复查在位） |
| `fallbackToolSeq` 在多次 attempt 间复用会导致序号串号 | 该变量声明在 `for (const attempt of plan.attempts)` **循环体内**（`openai-adapter.ts:372`），每次 attempt 重新初始化 | **驳回**（无跨 attempt 共享） |

另有 1 条被**修正前提**而非驳回：子 agent 称 `snapshots.ts` 的 `versionStatsProbe` 每 3 秒轮询。实测其唯一调用方是 `SettingsBookRetention.vue` 的设置页打开时触发，**不存在 3 秒轮询**。

## 七、优先修复建议（按投入产出排序，本轮均未实施）

1. **给注释门补「切除后残形」判据**（P2-1）。四类判据零误报、易实现；入 CI 后用同一工具清完现存 48 处并自证。**这是本轮唯一建议在 1.0 首发前做的**——因为不补判据，第三轮清理仍会制造第四轮。
2. **在 ubuntu 腿或本机补 `src/rag` 的 0.14pp 分支覆盖**（P2-2），并恢复「触 rag 先本地跑 coverage」的自查纪律。
3. **按 CI 红门规则统一处理覆盖率贴线桶**（P2-2 + §三定量表）：`learn` S 余 0.19pp、`document` S 余 0.46pp、`ai` F 余 0.80pp——这三个域下次被触碰时同样会红，建议一次性在 CI 腿重算基线。
4. **合并 `saveProvidersOr500` / `readSafe` 两处逐字节副本**（P3-1），与批 7 第 3 刀同款做法。
5. **清浮空 Promise 族抑制 104 条中的高价值子集**（P3-9），优先 `test/ai/provider/store.test.ts`（24 条）与 `openai-adapter.ts`（15 条 max-depth）。
6. 其余 P3（零引用导出、ttl-cache 断言、task-gate 注释措辞、book-rules 头注、文档计数、用户可见文案去批号）为常规维护，随触碰处理即可。

## 八、复现路径

本轮全部结论均可复现，命令与预期输出：

```
npx tsc --noEmit                                      # exit 0
npm run typecheck:web-next                            # exit 0
npx eslint . --max-warnings 0                         # exit 0
npx prettier --check .                                # 全库已格式化
npx vitest run                                        # 1286 通过 / 8751 例 + 8 跳过，exit 0
npx vitest run --coverage                             # exit 1：src/rag branches 87.86 < 88
npm run check:counts / check:docs / check:comments / check:packaging / check:knowledge   # 全 0
```

注释面损伤（48 处）复现口径：遍历 `src/**/*.{ts,vue}` 的注释行，判四族形态（残标签 `（[-—]X` 其中 X ∈ 圈号/源码/优化/mac适配/win适配/单字母、跨行空括号对、模板注释以 `：` 起首、整行纯标点），逐行 `git blame -L n,n` 取提交，再 `git show <commit>~1:<file>` 取父版原文对照——48 处全部落在 `f493f537`（43）与 `737352f7`（5）。

度量口径（一次性脚本，未入库）：函数级 ≥150 行 = 58 个（≥250 = 16，≥300 = 6）；文件 ≥800 行 = 11 个；注释行占比 = 36,331 / 121,964 = 29.8%；考古词注释 = 2,908 行（8.0%）；零引用导出 = 11 / 1,693；同体函数组 = 16；`eslint-suppressions.json` = 304 条目 / 635 计报 / 217 文件。

## 九、收口条件

本轮**未收口**（纯评审，按指令不修复）。建议收口条件：P2×2 办结并回归（P2-1 需「残形判据入 CI + 现存 48 处清零 + 门复跑绿」，P2-2 需「CI 腿或本机实测过门」），P3 按 §七 排序分批处置或逐条记理由。收口后方可归档本报告入 `Archive/`。

> **状态更新（2026-09-27）：已收口。** P2×2 办结并全门回归、P3×11 全数处置（9 条实修 / 2 条记理由），逐条形态与门实录见 §十。§八 的 48 处/1286 文件等数字是**评审当时的现场记录**，不改写；收口后的现场见 §十。

## 十、收口记录（2026-09-27；执行模型：ZCode / DeepSeek-V4.1-flash）

**结论：P2×2 全部办结、P3×11 全部处置**（9 条实修，2 条记理由不改代码），§九 收口条件已满足。

### 10.1 P2（2 条）

**P2-1 —— 门补判据 + 现存损伤清零（办结）。**

判据面（`scripts/check-comments.mjs`）从此分两族，缺一不可：

| 族 | 判据 | 回答的问题 |
|---|---|---|
| ① 标签形态（原有 `TAG_PATTERNS`） | 注释里出现批号 / 评审过程词 | 「注释还留着修复史吗」 |
| ② 切除后残形（本轮新增） | 单行七族（`RESIDUE_PATTERNS`）+ 成对两判据（`PAIR_RESIDUE_PATTERNS` 空括注、`孤立闭括` 深度 0 扫描） | 「注释被切坏了吗」 |

AB 标定（判据可信的前提，两版实测）：

| 版本 | ① 标签族命中 | ② 残形族命中 |
|---|---|---|
| 父版 `f493f537~1`（清理前） | 0（口径已收紧，见下） | **0**（零误报） |
| 受损 HEAD `1bd4a17a` | 3 | **102** |

同一份文本上两族命中数差 34 倍，就是 §三 P2-1 说的「结构性盲区」的量化。判据收窄两处都是「宽判据误报 → 窄判据」：

- **行尾悬挂左括**本可直判残形，但中文注释的**正常折行**就是左括在行尾、右括在下一行；父版一测即误报，故改为 **「空括注对 + 深度 0 闭括」** 两判据（dangling 括自动落进这两条）。
- **引用面内的括号是数据**（`timer.refresh()`、「（示例）」、`"((x))"`、正则字面量），先 `maskQuotedParens` **等长抹平**再判配对。早期版本用「删除引用面」的写法，父版误报 2 → 60，已回退为抹平。

门只报红不给机械修法（`main()` 提示语明写「切勿再跑一遍清理脚本」）；`stripTagSpans` 只吃标签族，残形族逐字原样返回——两支形态名不相交，有直测钉住这条设计边界。

损伤清理（74 处，全部注释文本，零运行时影响）：

| 来源 | 处数 | 处置 |
|---|---|---|
| 批 5 `f493f537` / 批 7 `737352f7` 的切除残形 | 25 | 逐处 `git log -L` / `git blame` 反查父版原文按原意复原（含 3 处 `$1` 正则回填残留、2 处 `-③：` 尾巴） |
| 本批早期擦除的**过度删除**（连括注另一半一起删，块内括注失衡） | 49 | 父版逐字回正（仅当删除跨度内无内容字符——纯擦除、不重算注释） |
| 同上，删除跨度跨内容字符 | 6 | 人工按父版原文重写 |

诊断量：注释块全角括号失衡数 **HEAD 76 → 现 74**（父版 28 是作者原态——中文注释跨行 `（`…`）` 本不必同行配对，故失衡只作诊断、不作门）。

**P2-2 —— `src/rag/**` 分支覆盖回绿（办结）。**
补 4 个测试文件 / 10 用例（`test/rag/` 下 `embed-empty-batch-and-timeout-off`、`embed-network-error-degrade`、`embed-response-count-mismatch`、`embed-warn-table-overflow`），覆盖空批、超时关闭、网络错误降级、条数不符、告警表溢出五条错误路径；分支 **87.86% → 91.21%**，`npx vitest run --coverage` **exit 0**。`embed.ts:62` 实测不可达，记理由不追。

### 10.2 P3（11 条）

| 条 | 处置 | 形态 |
|---|---|---|
| P3-1 | 实修 | `saveProvidersOr500` / `readSafe` 两处逐字节副本收编单源（`studio/server/api/provider-save-guard.ts`、`fs/read-safe.ts`），调用点全部改指 |
| P3-3 | 实修 | 门的三处盲区：小写双字母域号（`（ii-1）：`）与模型名载体（`（-deepseek-v4.1-flash ）`）入判据且现存清零；运行时代码串批号 11 处改自解释文案（`state.ts`、`server-manager.ts`、`manifest.ts`、`service-meta.ts`、`turns-phases.ts` 等） |
| P3-4 | 实修 | 8 处「拆分后忘摘 `export`」去 `export`；3 处故意导出（`createTaskGatePort`、`setDevProxyApplied`、`SAVE_BODY_ENVELOPE_BYTES`）保留 |
| P3-5 | 实修 | `ttl-cache.ts` 非空断言改显式守卫（不再靠调用序维持类型谎言） |
| P3-6 | 实修 | `task-gate.ts` 释放闭包的注释与实现对齐（注释描述的风险方向不成立） |
| P3-7 | 实修 | `book-rules.ts` 头注「当前状态」定性同步为现行实现（注入侧已接线） |
| P3-9 | 实修 | `no-floating-promises` 104 处清零（79 处补 `await`、24 处显式 `void`、1 处改 rejection 钩子），**零新增 eslint-disable**；`eslint-suppressions.json` **217 文件 / 304 条目 / 635 计报 → 178 文件 / 260 条目 / 531 计报**（floating 族 0） |
| P3-10 | 实修 | 用户可见文案去批号 11 处（即 P3-3 第三类）；watchdog「不 abort 在途请求」经复核是**有意设计**且注释已如实写明，登记为勿误修项 |
| P3-11 | 实修 | 总览 §1.3 的 15 → 16 对齐；并把 `Dev/Docs/README.md` 的 `Archive/` 篇数纳入 `check:counts`（`archiveCountProblem()`：缺行即红、值不符即红，3 条直测）——「索引面自称值 ≠ 实测值」从此有门拦 |
| P3-2 | 记理由 | 见 §10.4 |
| P3-8 | 记理由 | 见 §10.4 |

清浮空 Promise 时顺手暴露的**两处真问题**（非报告条目，如实记录）：

- `test/studio/webnext/electron-close-flush-delivery.test.ts:66` 的永挂 promise（测试自身缺陷）——已修；
- `src/ai/calls.ts:110,126-130` 的补偿分支**不可达**（`serializedWrite(..., {returnInflight:false})` 恒返回 `undefined`，`inflight !== undefined` 恒假）——**只登记不改**：属死分支而非缺陷，改动会碰写入链行为，留专批。

### 10.3 回归（全门实录，2026-09-27）

```
npx tsc --noEmit                                        exit 0
npm run typecheck:web-next                              exit 0
npx eslint . --max-warnings 0                           exit 0
npx prettier --check .                                  全库已格式化
npx vitest run                                          1290 文件通过 / 8781 通过 + 8 跳过，exit 0
npx vitest run --coverage                               exit 0（src/rag branches 91.21%）
npm run check:comments                                  exit 0（581 文件，两族判据零命中）
npm run check:counts                                    exit 0（1290 文件 / 8356 单测；33 e2e spec / 54 用例；Archive 16 篇）
npm run check:docs / check:packaging / check:knowledge   exit 0
```

README 对账数字 8333 / 1286 → **8356 单测 / 1290 文件**。口径说明：`check:counts` 用 `vitest list --json` 的**静态枚举**（`it.each` 按调用点计 1），与运行时总数（8781 + 8 跳过）差在 `it.each` 展开——README 取静态口径，两者不可混用（本批曾误取运行时数写成 8348，已回退）。

### 10.4 记理由不修的两条

- **P3-2 注释考古密度。** 标签形态已由门机器守护（全库 0 命中）；散文形态本轮以**门自己的注释面**为口径复测（581 文件 / 38,182 注释行；词表 = 复审｜重审｜重评｜作废｜此前｜原先｜曾经｜历史口径｜沿革｜回正｜误删｜上一轮｜前一轮｜旧版｜旧实现｜曾把｜一度｜修复批｜批内）实测 **1,527 行 / 4.00%**（§四 P3-2 的 8.0% 出自另一套词表，两数不同轴、不作对比）。**不做机械重写**：本报告 P2-1 的 74 处损伤正是两轮机械清理的产物，第三次机械改写会制造第四批残片；散文形态若设机械门必然误报，故改由「新增注释不写修复史 + 评审期抽查」的纪律面承接。
- **P3-8 前端 store 环。** 4 条基环（`prefs↔ui`、`doc↔tree` 等）是真实业务耦合（偏好要弹 toast、文档要刷树），不是可注入消除的假耦合；`useStaleGuard` 已是该方向的正确抽象。**处置 = 维持 `KNOWN_CYCLES` 登记**，此处记录「这是已登记，不是已消除」；环名与登记数以 `test/governance/webnext-store-import-cycles.test.ts` 为准。
