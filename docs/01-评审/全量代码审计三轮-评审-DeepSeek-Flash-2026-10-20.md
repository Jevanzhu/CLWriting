# CLWriting 全量代码审计报告（第三轮）

- 定位：**全量代码审计第三轮（独立）评审档**——只采当前源码、配置、测试与提交记录的独立结论，不读任何既有评审档、归档档与审计工作目录；不属于本档：修复实施（本轮未改一行代码）与分域过程档（住本轮工作目录、未入库，本档正文即全部交付）。
- 执行模型：DeepSeek-Flash（`deepseek-flash`）主控 + 8 个分域子 agent（A：`ai`/`process`；B：`document`/`format`/`check`；C：`studio/server`/`desktop`；D：web-next 逻辑层；E：`events`/`rag`/`knowledge`/`fs`/`state`/`learn`；F：`install`/`update`/`export`/`review`/`metrics`/`cache`/`git`/`log`/`diagnostics`/`driver`/`shared`；G：web-next 组件面；H：`test`/门禁脚本/构建与 CI）；主控对全部 P1 与高优先 P2 独立复核，并对分域档三条「≥P1」结论做出**降级重判**（见 §10）。
- 审计基线：分支 `win`，HEAD `09e08de5`（1,188 提交，2026-05-14 → 2026-10-19）。审计起于 `ad1668f3`；期间新增一笔治理面提交 `09e08de5`（技能副本 0.1.8→0.1.9、新增 `skill-catalog` 门、`AGENTS.md` 与规范档各一处），该笔只触 `.agents/skills/`、`scripts/harness/`、`AGENTS.md` 与一篇规范档，未触 `src/`、`test/`、依赖与构建配置——故全量 `vitest` 读数（在 `ad1668f3` 跑）与分域结论均不受影响，而门禁读数按 `09e08de5` 重跑（`check:harness` 因此由 7 门变 8 门）。
- 依据与边界：仅当前源码、配置、测试与提交记录；`AGENTS.md` 与 `.agents/skills/` 副本只作纪律约束、不作证据；源码注释与文档文案一律先当「宣称」抽查。未 build、未跑 e2e、未联网、未改任何源码/配置/测试（本档是唯一写入）。落链阶段按文档链规范读过 `docs/README.md`（索引）与 `docs/00-活账.md`（活账），二者含前两轮的出口条件行——本档结论未采其判据，P1-01 与前两轮条件无重叠；发现项均先于该次阅读产生（分域报告与探针在落链前已完成）。
- 方法：8 域并行通读 + 主控全量门禁实跑 + 四个独立探针（裸 `db.close()` 堆增长、`PUT /config` 无操作、`patchFlatFm` 注释丢失、UNC 路径脱敏缺口）+ 提交史抽样。
- 证据口径：全部结论以「仓库相对路径 + 行号」锚定（行号含区间时写成「起始行-结束行」）。本档共 129 处锚点，已用脚本逐条核验「文件在位 + 行号在该文件有效范围内」，并对 P1 与全部主控复核级 P2 抽读原文确认行内容与断言一致；分域档给的锚在本档重新核过一遍，凡原锚错位者已按实际源码行号改写。
- 出口：**有条件通过**。条件一条 = P1-01（定稿链补前置落盘）；另有三条 P2 建议同批收口（P2-01 UNC 脱敏缺口、P2-02 `/config` 静默丢弃、P2-03 块标量注释丢失）；其余 P2/P3 排期。

## 0 规模与门禁基线（实测）

| 项 | 实测值 |
|---|---|
| 源档（`src/`，不含 `node_modules`） | 665 档 = `.ts` 545 + `.vue` 120 + 其它 13 |
| `src` 的 `.ts` 行构成 | 115,220 行 = 代码 70,053 / 注释 38,246（**33.2%**）/ 空白 6,921 |
| 测试面 | 1,369 档（`*.test.ts` 1,285 + `*.spec.ts` 36 + 其它 48），244,363 行 |
| 门禁脚本 | `scripts/` 根 32 档 + `scripts/harness/` 副本 29 档，合计 10,336 行；`package.json` scripts 42 条 |
| 服务端路由 | 117 条 `defineRoute` |
| 单测口径 | 静态声明 9,438（`vitest list`）；运行收集 9,928 = **9,851 passed + 77 skipped** |
| e2e | 36 spec / 60 用例 |
| 覆盖率（本机全量产物） | 657 档：lines 92.52 / branches 81.80 / functions 89.46 / statements 89.92 |
| 大档 | >500 行 53 档、>800 行 15 档（最大 `document/service.ts` 1,283 行） |
| 大函数 | 非注释行 >120 的 54 个、>200 的 6 个（最大 `src/studio/web-next/src/stores/doc.ts:68` 465 行） |
| 空 `catch {}` | 195 / 983 个 catch 子句 |
| 类型逃生 | `as any` 0、`@ts-ignore` 0、`@ts-expect-error` 0、`eslint-disable` 1 |
| XSS 面 | `v-html` / `innerHTML=` / `insertAdjacentHTML` = 0 |
| 标记残留 | 源码零 `TODO`/`FIXME`（case-sensitive 3 处命中全为 `\uXXXX` 转义说明与 prompt 文案）；`console.log` 7 处全为日志镜像与 `[CLW_SMOKE]` 冒烟标记 |

门禁实跑（`09e08de5`，用 `node <脚本>` 直跑绕开沙箱下失效的 npx 启动器）：

| 门 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（0 错） |
| `eslint . --max-warnings 0` | 通过（0 error / 0 warning） |
| `prettier --check .` | 通过 |
| `check:counts` / `check:docs` / `check:comments` / `check:suppressions` / `check:packaging` / `check:knowledge` | 全部通过；抑制台账 **315/315 零余量** |
| `check:harness`（text 模式） | 8 门全 PASS（含审计期新增 `skill-catalog`）；`markdown-wrap` 挂 34 条基线债务 |
| `check:harness-copy` / `check:notes` | 通过（副本 0.1.9 与 `version.json` 一致；4 份空判据门申报与实文一致） |
| 全量 `vitest run` | 9,851 passed / 77 skipped / 0 failed，3,791 套件 |

口径差一处：`README.md:5` 徽章写 `tests-9438 all green`，而运行收集 9,928——两数不同源（见 P2-08）。

## 1 实现完成度评估

**总评：功能性完成度高，主干闭环完整；缺口集中在「收尾一致性」与「防御纵深」，不在主链正确性。** 产品已于 `v1.0.0` 首发，8 域通读未发现「宣称完成而实际未接线」的伪装面：`src` 内零 `TODO`/`FIXME`、零 `as any`、零被注释掉的代码块，唯二显式未完成项（`src/studio/web-next/src/stores/review.ts:17` 进度 SSE 未实现、`src/review/run.ts:371-379` 合审按视角判覆盖挂起）均在原位写明。

| 域 | 完成度 | 判据（要点） |
|---|---|---|
| A `ai`/`process` | 高（子域 85–95%） | 三线适配、`gen` 收集层、`runner` 执行壳、chat 六失败出口、self-heal 双闸、双账口径、15 工具风险分级全部闭环；缺口在观测层规模与非标网关形态 |
| B `document`/`format`/`check` | 完整 | 写路径原子性/锁序/journal 三态/版本留底/回收站一致成立；一处有意桩 `src/format/manifest.ts:44 writePieceList`（正文写明「暂不实现」），5 处测试专用导出 |
| C `studio/server`/`desktop` | server 完整 / desktop 基本完整 | 117 路由统一信封、八道入口安全闸、SSE 一次性 ticket、单实例双防线、退出链状态机、自更新全链齐全；OS 钥匙串通道为显式搁置（`src/desktop/os-kek.ts:81`） |
| D web-next 逻辑层 | 主链路完整 | 切书三段守卫、SSE 两段凭据 + 连接纪元、冲刷链、脏镜像、跨窗失效、409 三态均成文；**定稿链缺前置落盘**（P1-01）、契约覆盖仅 7/32 模块 |
| E `events`/`rag`/`knowledge`/`fs`/`state`/`learn` | 完整（六子域皆完整） | 56 档零桩；事件域 5 处开库全经 `closeEventsDb → closeWithPrepared` 并有测试钉源文本；RAG 为 JS 余弦 BLOB 扫描（清单所称 FTS 检索在实现中不存在 → 判不适用） |
| F 基础设施 | 11/12 完整，`shared` 部分 | `books.jsonl` 原子写 + 跨进程锁 + 指纹缓存、更新链规范地址 + sha 锚 + 解压限额、git 数组化 spawn 免注入全在位；`src/shared/tokens.ts:39-44` 系数表空置 → 全模型恒 0.6（登记为待校准） |
| G web-next 组件面 | 成熟 | 120 档零死组件、`v-html` 零、30 处 `addEventListener` 全成对、遮罩/Esc 让渡/焦点圈/在途锁/IME 判据/渲染帽均单源；Beta 面较广且无功能总览 |
| H 测试与门禁 | 高 | 分层清晰（unit/dom 目录路由）、helpers 成体系、e2e 顺序契约 + 快照重拍闸、12 档治理测试守跨域不变量；fail-open 五形态逐门查过均有防线 |

**完成度短板（按影响排序）**：①定稿链不落盘就结算（P1-01）；②前端契约面自持 25/32 模块、已实际漂移（P2-12）；③版本预览 API 全仓零消费（`src/studio/web-next/src/api/snapshots.ts:25`，恢复为破坏性动作却无只读预览）；④`readSnapshot` 类「服务端端点齐备、前端未接线」的账实差一处。

## 2 整体质量

**静态质量线高，且有机器背书**：`tsc` 严格档（`noUncheckedIndexedAccess`/`verbatimModuleSyntax`）零错、`eslint` 零告警、`prettier` 全库一致、覆盖率 lines 92.52%、9,851 用例全绿。结构性约束被写成常驻治理测试而非文档口号：`test/governance/` 12 档共 3,214 行守「运行期 import 无环」「底座不得 import AI 生成层」「抑制只减不增」「book 键缓存登记对账」「测试可见 ⟺ 事件已记录」等不变量；`.agents/skills/` 副本面与 `scripts/harness/` 校验器由 `check:harness-copy` 逐条对账，4 份空判据门的「刻意空置」在文件与门里双处自证。

**风险不在代码而在「门的自述与射程」**——本轮最值得记的不是哪一行写错，而是三处「门说全绿、实测有差」：

1. `check:comments` 输出「src 与 scripts 及根配置注释零批号标签」，但其 23 条判据不含 `阶段 N` 形态：实测 `src` 注释里 **113 行**含「阶段 13/14/24/53/55」一类批号叙事（如 `src/desktop/ipc.ts:42,138,458`、`src/ai/provider/types.ts:38,58`），`审计批8` 形态同样全数通过（P2-07）。
2. `README` 的 9,438 是静态声明数，与运行收集 9,928 不可互校；「全绿」也不含 77 个 skipped（P2-08）。
3. 覆盖率 33 桶中 12 桶余量 <1pp（`learn` statements 仅 0.19pp），与「阈值 = 实测 −2pp」的维护规则已脱节（P2-09）；本地 L2 终门集合又缺 `format:check`/`lint:prune`，与 CI 判据不同集，已有真实红例（commit `d103c7d3`，P2-10）。

**防御纵深的不均衡**是本轮第二个主题：入口闸（Host/Origin/token/SSE ticket/dot-segment 归一化/Electron `contextIsolation`+`sandbox`+CSP+/`will-navigate`+`setWindowOpenHandler`）密度很高且都有红用例；而**出站与落盘的下游判据**明显薄一档——UNC 路径不进脱敏面（P2-01）、解压条目不拒 Windows 保留设备名与 ADS（P2-06）、`safeDocId` 不拦尾点与保留名（P3 表）。包体有 sha256 锚定，故这些当下不可远程利用，属「声明与判据不一致」。

**跨层结构有一处未被门覆盖的倒挂**：`studio/server/cache-registry.ts` 自称「零依赖叶子件」，却被 7 个底座层文件 import（`format` 3、`document`/`fs`/`cache`/`state` 各 1，P2-11）；而 `test/governance/` 的方向锁只锁「底座 → AI 生成层」，不锁「底座 → studio」，故这条倒挂长期不会被门发现。

## 3 简洁优雅程度

**整体 3 / 5**。分域评分 3–4 之间（A 3.5、B 3、C 3、D 4、E 3、F 3.5、G 4、H 3.5），收敛后取 3。

**加分面（做得好且少见）**：单源化执行彻底——`shared/sqlite-prepared.ts`（prepared 缓存 + 静默回滚单点）、`shared/frontmatter-core.ts`（两端共用 fm 切分）、`fs/atomic.ts`（写原语）、`fs/safe-path.ts`（身份键/越根判定）、`format/filename.ts`（章号与净化）、`shared/render-cap.ts`（17 档引用的渲染帽）、`shared/body-writeback.ts`（200ms 回写合并窗）都做到了「一处定义、消费方零副本」；降级纪律统一为「不阻断主路径 + warn 留痕 + 结构化 dropped/reason」；拆分按职责而非按函数堆砌（`store-open`/`store-retention`/`store-selfcheck`、同步壳与异步孪生）。

**扣分面（三项，均有量化）**：
- **注释稀释代码**：`src` 的 `.ts` 注释行 38,246 / 115,220 = **33.2%**，其中修复史与批号叙事占相当比例——「此前」750 行、「不再」798、「收口」477、「历史」358、「本次」146、「本轮」123、「原先」98、「旧版」72、「本批」29、「曾」49（合计约 2,900 行命中），另有 113 行「阶段 N」。按仓内注释纪律（只写作用/约束/语义，修复史归 git），这类内容留在源码里既抬高阅读成本，又会让后来者把「当时的取舍」误读成「现行约束」。最差三处：`src/events/store.ts:1-30`（头注整段沿革 + 审计编号）、`src/state/health.ts:200-330`（判态检查段注释:代码 ≈ 2:1）、`src/rag/store.ts:256-296`（`busy_timeout` 两档长叙事）。
- **文件与函数体量**：>500 行 53 档、>800 行 15 档；非注释行 >120 的函数 54 个、>200 的 6 个。最重的四个都在前端状态层：`src/studio/web-next/src/stores/doc.ts:68`（465 行代码 / 784 物理行的单个闭包）、`src/studio/web-next/src/composables/useRelationGraph.ts:181`（405）、`src/studio/web-next/src/composables/useChapterTreeActions.ts:77`（348）、`src/studio/web-next/src/stores/provider.ts:46`（310）——`eslint` 的 `max-lines-per-function: 200` 由 `eslint-suppressions.json` 的 6 条计数抑制放行，`complexity: 25` 由 50 条抑制放行（全表 140 文件 / 189 条 / 315 次，零余量）。
- **重复实现仍在规模上**：书架页与书架浮层是两份工具栏实现且已漂移（`src/studio/web-next/src/pages/Shelf.vue:129-179` ↔ `src/studio/web-next/src/components/ui/ShelfModal.vue:183-258`，P2-18）；「截断省略提示行」在 10 档各写一份、`.btn` 局部块 15 档；测试夹具跨档逐字重复 112 组 / 314 个函数体（`stubEmbed` 与 `collect` 各 13 份）。

**另两处结构性债**：①web-next 的 Pinia store 仍有 2 个运行期环（`doc`/`tree`/`workspace`/`words` 与 `prefs`/`ui`），被治理测试的 `FROZEN_CYCLES` 冻结承认（`test/governance/runtime-import-cycles.test.ts:273-281`）——架构债被制度化而非消除；②`vitest.coverage-buckets.ts` 的 `{pages,views}` 桶登记 `lines:0,branches:0`（注释「e2e 自管」），大 UI 面实际只在名单式桶里被部分覆盖。

## 4 问题清单：P0 / P1

### P0（数据损坏 / 凭据泄漏 / 主链能力失效）

**无。** 逐条排除过三处高危候选：事件库事务边界（deferred `BEGIN` 的读→写升级在本域不成立——所有事务体写先于读，且写锁路径显式用 `BEGIN IMMEDIATE`）、`books.jsonl` 并发写（原子写 + 跨进程 O_EXCL 锁 + `(mtimeNs,size)` 指纹）、更新链（规范地址逐字比对 + sha256 锚 + `.part` 原子改名 + 解压条数与字节上限）。写稿链的「半截正文落稿」面有三处独立防线（适配器无终止值 → 可重试 error；`gen` 截断 → `MAX_TOKENS` 不可重试；`self-heal` 仅 `status==='ok'` 才落盘），确认成立。

### P1（用户可感、确定、须修）

**P1-01 定稿链缺「先落盘」前置：定稿版本可缺最后一段编辑，且定稿态会被随后的 autosave 静默降级**（主控复核确认）

- 证据：`src/studio/web-next/src/stores/doc.ts:671-676`——`finalize()` 直接发请求，函数内无任何冲刷前置：
  ```ts
  async function finalize(docId: string): Promise<boolean> {
    if (!bookName.value) return false
    const book = bookName.value
    try {
      const r = await finalizeDoc(book, docId)
  ```
  三个入口同样不冲刷：`src/studio/web-next/src/components/editor/EditorDocHead.vue:136-140`（`onFinalize` 直接 `await doc.finalize`）、同档 `:308` 按钮 `:disabled="finalizing || entry?.saving"`——**不判 `dirty`**、`src/studio/web-next/src/composables/useChapterTreeActions.ts:192-193`（树菜单）与 `:221-225`（批量定稿）同样直接发 `batchFinalizeDocs`。
- 结算口径在服务端按**盘上字节**：`src/document/finalize.ts:183-188` 锁内 `readFileSync` 取 `hashBytes(fileBytes)` 作定稿基线，落 `finalizedRevision`（`:268`）；状态推导 `src/document/status.ts:48-51`——`finRev !== currentRevision ⇒ 'revision'`。
- 影响：编辑器正文回写有 200ms 合并窗（`src/studio/web-next/src/shared/body-writeback.ts:38`），脏内容最久可等一个 autosave 节拍（`src/studio/web-next/src/composables/useAutosave.ts:28`，默认 ≥30s）。此窗内点定稿 → 提交的是缺末段的旧文件，随后 autosave 写入新内容 → 章状态静默 `final → revision`：作者收到「已定稿」toast，树里却回到待定稿。这与仓内既有口径直接冲突——合并/拆分/删除都先走 `src/studio/web-next/src/composables/useChapterTreeStructure.ts:61-76` 的 `flushUnsaved`（注释即写「脏内容不落盘就动结构会『合并了半章』」），定稿同样是「按盘上内容结算」的动作却漏了这一步；`src/studio/web-next/src/shared/body-writeback.ts:14-17` 的不变量 2b 亦明写「先读 dirty 再决定落不落盘的决策点，读之前必须 flush」，定稿是这类决策点。
- 建议：`finalize()` 顶部补与 `flushUnsaved` 同款前置——`flushBodyWriteback()` → `await waitInflightSave(docId)` → `dirty && !conflict` 则 `save(docId,'autosave')`，落不下去（仍 dirty / 冲突）即 toast 中止；`doBatchFinalize` 对在缓存中的 `docIds` 逐个前置冲刷后再发批量请求。补一条「脏内容点定稿 → 定稿版本含末段」的回退即红用例（当前无此用例，属缺失覆盖）。

## 5 问题清单：P2（有据可改进）

> 每条标确认来源：**主控复核** = 本轮由主控探针或实读复核；**分域确认** = 分域审计确认、主控未独立复现。

**P2-01 UNC / `\\?\` 绝对路径不在路径脱敏面（确认，主控复核）**
- 证据：`src/log/path-scrub.ts:41-43` 两层正则只认「首段拉丁 POSIX」与「`[A-Za-z]:\` 盘符」。探针：`\\NAS-SERVER\共享盘\我的书库\写作\正文\0001.md` 原样输出；`\\?\D:\书库\…` 只剥成 `\\?\<路径>`（前缀留残）。
- 影响：日志行（`src/log/index.ts:333-343`）、API 错误信封（`src/studio/server/http.ts:90`）、诊断包（`src/diagnostics/index.ts:307-308`）三处均保留服务器名与共享名；诊断包是**会外发给开发者**的文件，与模块头注「其余绝对路径一律替换」的红线声明不符。
- 建议：`ABS_WIN_RE` 前加 UNC 形态（`\\\\[^\\/\s"']+\\…`）与 `\\?\`/`\\?\UNC\` 前缀剥除后复用盘符层；补一条 UNC 用例（`test/log` 现仅覆盖 `C:\` 形态）。

**P2-02 `PUT /config` 改 `budget.chat_max_calls` 返回 `ok:true` 但盘上不变（确认，主控复核）**
- 证据：`src/format/yaml-spec.ts:407-413` 该键刻意无 `get`（注释「不入 PATCH 白名单」）；补丁叶由 `get` 派生 `src/format/yaml-patch.ts:261-265`；而 `src/studio/server/api/config.ts:130` 把它列入数值校验、`:158` 无条件回 `{ok:true, revision}`。探针（原文 `chat_max_calls: 20` → 提交 99）：对照组 `calls_per_chapter` 3→7 落盘成功，`chat_max_calls` 仍为 20。
- 影响：契约面静默失败——前端/第三方 API 客户端改该键得到成功响应却不生效，属最难排查的一类；若前端将来接该键即为用户可感。
- 建议：二选一收口——拒收该键（400 + 「请手编 book.yaml」），或补 `get` 入白名单并同步 `yaml-schema-snapshot` 清单锁；补一条「PUT 补丁路径改该键」用例。

**P2-03 `patchFlatFm` 更新块标量键时删除该键段内的作者注释与空行（确认，主控复核）**
- 证据：`src/format/frontmatter.ts:411`（块标量键的 span 重建不含段内注释/空行）。探针：`摘要: |` 段后跟一行作者注释 `# 作者手写的注释` 与一个空行，改 `摘要` 为单行后输出为 `摘要: 新的单行摘要` 直接接 `下一键: 值`——注释与空行双丢，`下一键` 保留。
- 影响：作者手写注释被静默删除，与同档「其余行逐字节保留」的承诺相反；触发面是「作者在 fm 里给块标量键写了注释」这一非常态但合法写法，一旦触发不可察觉（无 toast、无 journal）。
- 建议：span 重建改为「保留键段内非缩进内容行」或在改块标量时把注释行上移到段后；补「块标量键更新后注释/空行保留」用例（`test/format/frontmatter.test.ts:205-212` 现只锚键值与下一键）。

**P2-04 三处生产代码裸 `db.close()`，把 `prepared()` 语句缓存永久留在堆上（确认，主控实测）**
- 证据：`src/state/state.ts:216-218`、`src/state/recap.ts:115-122`、`src/ai/tools/status.ts:40-45` 三处 `db.close()`；契约单源 `src/shared/sqlite-prepared.ts:12-16,48-51`（「凡有 prepared 调用面的连接，关库一律走 `closeWithPrepared`，不得裸 `db.close`」——裸关断不开 ephemeron 环）。被缓存的语句来自 `src/process/assemble.ts:97,103,125,152` 与 `src/format/read.ts:19,38`。
- 实测（主控探针，Node 26.8.1，5 条语句 × 2 万轮开/关，跑两轮交替取净增）：裸 `db.close()` 每 2 万轮堆 **+13.08 MB / +12.73 MB**（四轮严格线性）；改 `closeWithPrepared` 同轮次 **−0.01 MB / 0.00 MB**。量级 ≈0.65 KB/轮。
- 影响：`/api/state` 与 `/api/overview` 每次都经 `detectState` 开一次缓存库（`studio/server/api/state.ts` 的计算体），`chapter_status` 工具同面；长开的应用进程堆单调上涨且**无任何信号**（句柄已关，只在内存账上体现）。增长速度与调用频度成正比——分域档给出的「≈10MB/天」按实测单轮成本推算需每秒级轮询才成立，实际前端为进页/切书/生成结束触发（无固定轮询），故**该数量级不成立，只保留「确定性泄漏、随频度单调增长」结论**。
- 建议：三处改 `closeWithPrepared(db)`；把「域内零裸 `db.close()`」的源文本静态守护从 events/rag/check 三域扩到 `state`/`ai`/`tools`（同型测试，三行改动）。

**P2-05 应用内更新下载的「单飞」判据在 `await` 之后才置位，双击窗内可并发两路写同一 `.part`（确认机制，主控复核）**
- 证据：`src/desktop/update-controller.ts:140` 先判 `if (activeDownload)`，而占位 `activeDownload = controller` 直到 `:173` 才赋值（释放走 `:195-197` 的 `finally`）；中间隔着 `:143` `await resolveLatestRelease(...)` 与 `:159` `await sha256OfFile(...)` 两个真实异步窗。`.part` 名固定由资产名派生（`src/update/download.ts:262-263` `${zipPath}.part`，无进程/随机后缀），`:293` 起手 `dropPart()` 后由 `:305` `pumpBodyToPart` 打开写入。
- 影响：①同进程双击（或快捷键重入）在发布信息 RTT 窗内 → 两路并发 `open(part,'w')` 写同一路径，交错写入必致 sha 失配，或一路先 `rename` 而另一路仍在写；②多实例共享同一缓存根时同面可达（跨进程无锁）。失败面是可见的「校验不匹配」，不损坏已有文件。
- 建议：占位改成同步预置（进函数即置「下载中」标记，失败路径 finally 释放），或先取 `release` 再判重；`.part` 名加 pid + 随机后缀，跨进程用 `O_EXCL` 锁文件。

**P2-06 解压条目名判据缺 Windows 形态（保留设备名 / 尾点尾空格 / NTFS 备用数据流）（确认缺项，主控复核）**
- 证据：`src/update/extract.ts:62-71` 只判空名、`..` 段、首段盘符、归一化后越界（`:70`）：
  ```ts
  if (/^[A-Za-z]:/.test(parts[0]!)) return null
  const abs = resolve(root, ...parts)
  ```
- 影响：条目名 `NUL`/`CON`/`COM1`（写设备而非文件）、`a.txt:stream`（NTFS ADS，盘上看不见但被写入）、`name.`/`name `（落盘被 FS 归一后与 `name` 撞名）均通过判据。包体须过 sha256 锚定（同源发布者），故当下不可利用；属「模块头注宣称自持判据、实际只覆盖穿越与符号链接」的声明落差。
- 建议：`resolveEntryPath` 追加段级判据（含 `:`、尾点、尾空格、保留设备名），口径复用 `src/format/filename.ts` 的 winCompat 家族；与 P3 表 `safeDocId` 同族，宜同批。

**P2-07 `check:comments` 判据盲区：门自报「零批号标签」，实测 113 行批号叙事通过（确认，主控复核）**
- 证据：`scripts/check-comments.mjs:410-560` 共 23 条判据（`R系批号`/`质量债ID`/`单字母域号`/`轮次`/`日期戳`/`评审过程词` 等），不含 `阶段 N` 形态；探针用其自身 `TAG_PATTERNS` 跑样例：`// 阶段 24 起的旁路，审计批8 复核` → 零命中，`// R62-58 批号形态` → 命中。门输出原话「check:comments 通过：src 与 scripts 及根配置注释零批号标签、零切除残形（扫描 690 个文件）」，通过实跑复现。
- 影响：`src` 注释里 113 行含「阶段 13/14/24/53/55」（`src/desktop/ipc.ts:42,138,458,460`、`src/ai/provider/types.ts:38,58`、`src/check/leads.ts:178`、`src/ai/orchestrate/self-heal-generate.ts:151` 等）与 `审计批8` 形态全部放行；再叠加约 2,900 行修复史叙事词（「此前/不再/收口/本次/本轮」等，按行首注释统计）——注释纪律的红线只被机器覆盖了「批号标签」这一小片形态，门的存在反而给「注释面已清白」提供了背书。
- 建议：判据表补两条（`阶段\s*\d+`、`(?:审计|修复|收口|清理)批\s*[\dA-Za-z]+`）并先跑一遍存量计数决定「一次性清理 vs 挂基线台账」；空 `catch {}` 若要管，建议按位置白名单（现有 195 处多为「尽力而为」语义），不宜一刀切。

**P2-08 README「9438 单测全绿」是静态声明数，与运行收集 9,928 不可互校（确认，主控实测）**
- 证据：`README.md:5` 徽章 `tests-9438 all green`、`:92`（「1285 个测试文件 / 9438 单测全绿是合入门槛」）；`scripts/check-counts.mjs:10-13` 明写口径 = `vitest list --json` 静态抽取、「模板标题不求值、循环产用例按调用点计 1」；实测 `vitest list` = 9,438，全量运行收集 = 9,928（9,851 passed + 77 skipped），差 490 由 `.each` 表行展开与循环内声明解释。
- 影响：非 fail-open（门与自身同源、掉档会红），但「9438 单测全绿」会被读成「执行了 9438 个用例且全绿」；跨轮审计与外部读者无法用 vitest 汇总行互校，且「全绿」天然不含 77 个 skipped。
- 建议：README 标注口径（「静态声明 9,438 / 运行收集约 9,900」）或徽章改 `1285 files / 9438 declarations`；`check:counts` 输出里显式写「静态声明口径」。

**P2-09 覆盖率阈值余量接近耗尽：33 桶中 12 桶余量 <1pp（分域确认，coverage 工件推算）**
- 证据：`vitest.coverage-buckets.ts:59`（`src/learn/**` statements 94）、`:76`（`src/studio/web-next/src/*.vue` lines 96）等；`coverage/coverage-summary.json` 实测 `src/learn` statements 94.19（余 **0.19pp**）、web-next `src/*.vue` lines 96.30（余 0.30pp）、`src/process` functions 97.55、`src/format` branches 92.56、`src/events` functions 98.68 等；`vitest.config.ts:118` 注释里的基线快照已过期。
- 影响：与「阈值 = 实测基线 −2pp 向下取整」的维护规则不符——任一小重构即打红 CI；也有反向激励「补测凑到过门」。`{pages,views}` 桶登记 `lines:0,branches:0`（注释「e2e 自管」），大 UI 面实际只在名单式桶里部分覆盖。
- 建议：对余量 <1pp 的桶按规则重新取实测重基线并留痕；`{pages,views}` 改「除已登记豁免外全部」的否定式分割，或让守护测试对「匹配 0/0 桶且文件数 >0」直接红。

**P2-10 本地 L2 终门集合缺 `format:check` 与 `lint:prune` 的 diff 断言，与 CI 判据不同集（确认，有提交实证）**
- 证据：`AGENTS.md` 的 L2 条目只列「vitest 全量 + tsc/vue-tsc + eslint + 八 check」；`.github/workflows/ci.yml:119-134` 另有 `npm run lint:prune` 后 `git diff --exit-code -- eslint-suppressions.json` 与 `prettier --check` 两门。实证：commit `d103c7d3`「style: prettier --check 归一化 45 档（审计期改动漏跑格式化门，CI 五腿红在同一步）」。
- 影响：本地「终门全绿」与 CI 判据不是同一集合，纯机械红要走一趟 CI 才发现；CI 五分钟腿被格式门整批拦下，信号价值低。
- 建议：L2 条目补 `npm run format:check` 与 `lint:prune` 后 diff 空；或合成一个 `check:format` 让正本与 CI 同引一个名字。

**P2-11 分层倒挂：7 个底座层文件 import `studio/server/cache-registry.js`，治理门只锁「底座 → AI」不锁「底座 → studio」（确认，主控实测）**
- 证据：`src/format/chapters.ts:17`、`src/format/iron-rules.ts:18`、`src/format/style-entry.ts:20`、`src/document/version.ts:30`、`src/fs/md-text-cache.ts:26`、`src/cache/rebuild.ts:33`、`src/state/health.ts:60`（均 `import { registerBookKeyedCache } from '../studio/server/cache-registry.js'`）；该模块头注自称「零依赖叶子件…位置取舍：按『零依赖、避免环』定位在 server 层」。`test/governance/dependency-direction.test.ts:26-40` 的 `EDITOR_BASE` 只禁 `AI_LAYER`，不含 `studio`。
- 影响：底座层（`format`/`fs`/`document`/`state`/`cache`）编译期依赖组合根所在的 server 层，方向反了；当前无运行期环（`cache-registry` 零依赖），但这条边把「server 可被整体替换」的边界打破，且新增同类边不会被门拦下。同一现状在 `src/state/health.ts:60` 与 `src/ai` 侧「不能自登记」注释里被承认过。
- 建议：把 `cache-registry.ts` 下移到 `src/shared/`（零依赖叶子件本就不该住 server 层），或反向成端口注入；随后在方向锁里补一条「`EDITOR_BASE` 不得 import `studio/`」。

**P2-12 前端 `BookConfig` 契约自持一份且已实际漂移，靠索引签名掩盖（分域确认）**
- 证据：`src/studio/web-next/src/api/books.ts:16-25`（前端 interface）vs 服务端权威 `src/format/types.ts:232-263`——服务端 `spec_version: number`、`leads: { enabled: string[]; thresholds? }` 为必选，前端完全不声明并把 `book` 设为可选，仅以 `[k: string]: unknown` 兜住；消费处只能断言逃生（`src/studio/web-next/src/views/OnboardView.vue:200`）。
- 影响：字段改名/改型无编译期红；「读到 `{}` 也算合法配置」可通过类型检查。32 个 `api/*` 模块中仅 7 个走 `src/shared/contract/*` + conformance 探针，配置域是明确遗漏。
- 建议：`BookConfig` 提到 `src/shared/contract/`（或镜像 `format/types.ts`）并入 `api/web-api.conformance.ts`，先补 `spec_version`/`leads`/预算键，再改断言点。

**P2-13 设置「本书覆盖组」乐观写无回滚，且写入闭包在 `await` 之后才读活 ref（分域确认；跨书半为疑似）**
- 证据：`src/studio/web-next/src/components/ui/SettingsModal.vue:122-137`——`const name = ws.bookName` 在调用时捕获，`mutate(cfg)` 在 `await getConfigWithRevision(name)` 之后执行；失败分支只 `ui.toast` 不外抛，调用方全部 `void saveConfig(...)` 且本地 ref 已先行置位；同型 14 处（`src/studio/web-next/src/components/ui/SettingsBookAnalysis.vue:186-188,191,201,211,224,231,244,250,260,266,275,280,287,299`、`src/studio/web-next/src/components/ui/SettingsBookWriting.vue:111-117`）。
- 影响：①写失败后界面已置位、`book.yaml` 未变，UI 与服务端长期不一致（无回滚、无重试、无「未保存」标记）；②`mutate` 闭包读的是组件活 ref（如 `effShortStrict.value`），切书后这些 ref 已反映**新书**生效值，而 `name` 仍是旧书 → 把新书的值写进旧书配置。②需「切换发生在 GET 在途窗内」才成立，标疑似。
- 建议：`mutate` 改为以「点击时快照值」入参（把 `eff*` 读在 `await` 之前并随闭包传入）；失败分支回滚本地 ref 或置「未保存」态；补一条「写失败 → UI 复位」用例。

**P2-14 同一 `task:'chat'` 键同时承载「正常轮发送」与「历史压缩摘要」，共吃 `chat_max_calls` 配额（分域确认）**
- 证据：`src/ai/orchestrate/chat/finish.ts:136`（压缩摘要）与 `src/ai/orchestrate/chat/turns-phases.ts:361`（正常轮发送）同值；闸判据 `src/ai/runner.ts:762`；`src/ai/token-calibration.ts:39` 因「chat 的 chars 只记末条消息」整类剔除 chat，而摘要那条恰恰记全量 chars（`src/ai/orchestrate/chat/finish.ts:118-120`），被一并误剔。
- 影响：作者把 `budget.chat_max_calls` 设小（如 20）时，压缩摘要与超窗收缩/换网等额外发送都吃同一配额，拦截文案无法指向真实消耗源；校准样本因此少一类。
- 建议：压缩摘要改用独立 task 名（如 `chat_compact`），校准只剔多轮轮次发送；或至少在闸拦截文案里区分两类消耗。

**P2-15 机检正文 markdown 检测面窄于文案宣称（分域确认）**
- 证据：`src/check/body-format.ts:40` 正则只含 `\*\*`、`__`、反引号，且列表/引用项以 `\n` 为前缀锚；同档 `:73` 文案宣称「加粗/斜体/行内代码/列表/引用/表格」。
- 影响：AI 输出 `*他笑了*`、`_他笑了_` 这类斜体，或正文首行即 `- 项` / `> 引用` 时漏报（黄项漏检向，不阻断，但机检面板失明）。现有用例只覆盖 `**`/反引号/带 `\n` 前缀的列表。
- 建议：单星/单下划线对纳入检测（排除段落分隔的裸 `*`），列表/引用锚改 `(?:^|\n)`；补首行形态用例。

**P2-16 对话裁剪在客户端侧静默削头，无任何可见标记（分域确认）**
- 证据：`src/studio/web-next/src/stores/chat-dispatch.ts:476-479`（`trimMessages` 从头部 `splice`）与 `:493-504`（正文总量闸同样削头）；可见面只绑定服务端字段 `src/studio/web-next/src/stores/chat.ts:315-316`，`src/studio/web-next/src/components/panels/chat/ChatMessages.vue:262` 只读 `historyTruncated`。
- 影响：长会话第 201 条起、正文超 1M 码点后，最旧气泡被静默丢弃——「对话就这么多」与「更早的被丢掉」不可区分，恰是同档 `:57-61` 红线注禁止的形态（服务端侧有提示，客户端侧没有）。
- 建议：削头时累加「本地已隐藏 N 条」标志，与 `historyTruncated` 合并渲染。

**P2-17 版本预览 API 全仓零消费：恢复是破坏性动作却无只读预览（分域确认）**
- 证据：`src/studio/web-next/src/api/snapshots.ts:25-28` `readSnapshot` 全仓唯一引用即其定义；同模块 `listSnapshots`/`restoreSnapshot` 有消费（`src/studio/web-next/src/components/panels/HistoryPanel.vue:9,79`），服务端 GET 预览端点已注册（`src/studio/server/api/snapshots.ts` 路由族）。
- 影响：账实不符——要么 API 是未接线的半成品，要么服务端多了无消费端点；作者只能按时间/来源/字数差盲选版本后恢复。
- 建议：把 `readSnapshot` 接到 `HistoryPanel` 的只读预览；若产品明确不做，删函数并在服务端端点标注「无前端消费」。

**P2-18 设置覆盖组与「全局/本书」两组 UI 在同构面上重复实现（分域确认，含已漂移一处）**
- 证据：`src/studio/web-next/src/pages/Shelf.vue:129-179` ↔ `src/studio/web-next/src/components/ui/ShelfModal.vue:183-258`（工具栏/批量条两份实现，浮层有「全选含上限之外」提示、页版同等 render-cap 却无）；`src/studio/web-next/src/components/ui/SettingsAnalysis.vue:64-219` ↔ `src/studio/web-next/src/components/ui/SettingsBookAnalysis.vue:473-620` 四组覆盖 UI ×2 处同构；「截断省略提示行」10 档各写一份且字号/内距已漂移。
- 影响：同一交互两处维护，漂移已发生（提示缺失即功能差）；新增同类面只会继续复制。
- 建议：书架工具栏抽成共享件；覆盖组按「一组一份组件 + 配置表驱动」收口；省略提示行与 `.btn` 上收到 `ui/` 共享样式。

## 6 问题清单：P3（记录项，不建议本批修）

分域档共列 P3 级 53 项，主控按主题归并并保留代表锚（`[A]`…`[H]` 为域标）；逐条细节住分域过程档，本表保留可行动的最小信息。

| 编号 | 主题 | 代表锚与结论 |
|---|---|---|
| P3-01 | Win 平台纵深（同名族） | `src/fs/safe-path.ts:130-132` `safeDocId` 不拦 win 保留设备名与尾点 → 清单被手改时该文档保存恒 WRITE_ERROR；与 P2-06 同族，宜同批 [B/F] |
| P3-02 | 单星斜体/边界判定码元 | `src/check/count-dialogue.ts:47-57` 按 UTF-16 码元取邻字符 + `HANZI_CHAR_RE` 仅 BMP → 增补平面汉字邻接的禁词误判为边界命中（红项误报，概率低） [B] |
| P3-03 | 版本留底热路径 | `src/document/version.ts:367,501` 每写必 prune + 每次头读新分配 64KB buffer → 批量软删/批量定稿叠加几十 ms 级尾延迟（未实测） [B] |
| P3-04 | `writeBookConfig` 无锁 / 段尾注释丢失 | `src/format/yaml.ts:350-354` 裸 `atomicWriteFile`；`src/format/yaml-patch.ts:92-119` 段尾缩进注释随整段替换丢失——现生产消费面窄 [B] |
| P3-05 | 跨卷 rename 未入降级集合 | `src/fs/atomic.ts:338-351` 只对 `EPERM/ENOSYS/EACCES` 降级，`EXDEV` 原样上抛 → 跨卷书库（junction/挂载点）结构操作 WRITE_ERROR，失败可见不损数据（疑似） [B] |
| P3-06 | 版本 fm 字数 0 被丢 | `src/document/version.ts:449-450` `words > 0` 守卫 → 空正文留底版本无字数，读侧回退整读（多一次全读） [B] |
| P3-07 | 观测层规模 | `src/ai/trace-stats.ts:61-62,66,85,107` 注释称「峰值只与桶规模相关」，实际每事件压一个 number 并整体排序（实测 30 万条 = 3.05MB / 55ms；服务进程为 `utilityProcess` 而非主进程，影响限于服务端事件循环，重书统计页刷新时可感）；同批 `cost-stats` 已流式化而此处漏改 [A] |
| P3-08 | 断流防御缺口 | `src/ai/gen.ts:241-245` 未收 `done` 只 warn 仍返回成功 + `src/ai/runner.ts:1250-1252` `unknown → completed` → 半截产出可被当完整首稿（适配器结构上不可达，属防御缺口） [A] |
| P3-09 | 预算闸快照读透出 | `src/studio/server/api/review.ts:212` 把锁外快照读的产物直接作为 `remaining_calls` 进 UI（交互文案可偏低/偏高）；计价归属按「当前启用 provider」而非本次实际发送者（`src/ai/pricing.ts:108-111`，双 provider 同 model id 不同价时可记错价） [A] |
| P3-10 | 事件写全同步 | `src/events/store-open.ts:101` `busy_timeout=5000` + `src/events/store.ts:594-613` 同步 `INSERT…RETURNING` → GUI 与 CLI 双写争用时单条语句可阻塞至 5s，期间 SSE 心跳与其余请求停摆 [E] |
| P3-11 | 知识语料编码不校验 | `src/knowledge/corpus.ts:49` 无 BOM/U+FFFD 判定；唯一抽查面 `:181` 只覆盖随包根、默认 4 篇、前 4KB → GBK/UTF-16 或被同步盘半写的书级语料乱码整段进 prompt（作者零感知） [E] |
| P3-12 | RAG 增强面反噬主链 | `src/rag/config.ts:107-108` → `src/rag/resolve.ts:60` → `src/process/materials.ts:248` 裸调用不在 try 内 → secrets 不可读时写稿链 500，违反同档「RAG 失败不阻断主路径」 [E] |
| P3-13 | 增强面契约穿透 | `src/fs/resources.ts:20-22` `resourcesRoot()` 找不到即 throw，知识装配链首步无 try → 打包布局变更/部分检出时 chat prompt 装配与写稿链一并异常 [E] |
| P3-14 | 存储与清理 | `src/rag/store.ts:339-372` 无 `auto_vacuum`/`VACUUM`/checkpoint → 重建/换模型后磁盘高水位不回落（稳态债）；`src/events/store.ts:248-250` `repairOrphanSessions` 每次首开全索引扫（实测 `SCAN events USING idx_events_session`） [E] |
| P3-15 | 更新链时序 | `src/update/download.ts:305→318` 期望校验值在整包下载之后才解析 → `SHA256SUMS.txt` 缺失/不可达时用户白下 ≈300MB 才失败（digest 优先是头注明写口径，非自相矛盾） [F] |
| P3-16 | 登记静默项 | `src/install/books.ts:248-249` `removeBookEntryLocked` 读失败静默 return 零留痕（同函数写失败/锁超时都有 warn）；`src/install/books-repair.ts:207` 用 `existsSync` 分诊 missing → EACCES 也报「目录已不在」 [F] |
| P3-17 | 单源破例 | `src/update/check.ts:39,177` 发布仓 slug 三处字面量（单源常量在 `src/update/download.ts:37`）→ 换仓漏改即恒 404；契约头注引用不存在的 conformance 档 7 处（实际只在 `api/web-api.conformance.ts` 落点） [F] |
| P3-18 | 诊断包与内容门 | `src/diagnostics/index.ts` 多卷写入中途失败留前几卷不清理、同秒重复生成覆盖旧包；内容门依赖「载荷必须在分隔符之后」的纯约定无运行期兜底（设计取舍，风险登记） [F] |
| P3-19 | 卸载守卫不一致 | `src/studio/web-next/src/views/OverviewView.vue:148` 缺存活守卫（对照 `src/studio/web-next/src/views/AuditView.vue:75-78` 有）；`src/studio/web-next/src/components/shell/WorkspaceShell.vue:58` 直写 `wb.warning`；`src/studio/web-next/src/components/ui/SettingsBook.vue:44-73` 直写 prefs 内部 ref [G] |
| P3-20 | 桌面端不渲染的自绘菜单 | `components/shell/ContextMenu.vue`（591 行）四处使用点均 `v-if="!isNative"` → Electron 下整件不渲染，只服务浏览器/dev 回退，却压着 3 个 dom 测试档的维护成本 [G] |
| P3-21 | 列表 key / 可访问性 / 确认 | `src/studio/web-next/src/components/editor/EditorDocHead.vue:259` 与 `src/studio/web-next/src/components/panels/ChapterTreePanel.vue:227` 非静态列表用下标作 `:key`；`src/studio/web-next/src/components/ui/BetaBadge.vue:2` 只有 `title` 无 aria 语义（19 处模板标注 / 12 档导入）；`src/studio/web-next/src/views/AuditView.vue:234-248` 清除事件史用内联两段确认未走统一 `ui.ask` [G] |
| P3-22 | 标题提交无护栏 | `src/studio/web-next/src/components/editor/EditorDocHead.vue:264-272` 标题 blur 即改名：无二次确认、无 `maxlength`、空值静默变「未命名」 [G] |
| P3-23 | 树首开直写 store | `src/studio/web-next/src/components/panels/ChapterTreePanel.vue:152` 直写 `ws.treeExpanded` 绕过 `setTreeExpanded` 的 `treeExpandedTouched` 守卫（`src/studio/web-next/src/stores/workspace.ts:156,543-545`）→ 迟到的 `loadBookPrefs` 可覆盖「首次默认展开」（疑似，未实测时序） [G] |
| P3-24 | 计时器/存储无兜底 | `src/studio/web-next/src/stores/update.ts:81,93-101` 与 `src/studio/web-next/src/stores/ui.ts:61-99` 模块级计时器无 dispose（测试隔离与热重载面）；`src/studio/web-next/src/composables/useUnloadFlush.ts:78,102` 裸 `sessionStorage` 无 try/catch（存储被禁时刷新链断在半路） [D] |
| P3-25 | 总览 loading 早撤 | `src/studio/web-next/src/views/OverviewView.vue:93-98` 整页 loading 早于三个次级加载器结束（窗口极短） [D] |
| P3-26 | 副本采用面 | `check:harness-copy` 不校验「副本里的 `verify-*` 是否都在被跑的模式里」→ 上游新增校验器可静默不接线；4 份空判据门中 3 份 `{}` 无自证文（`doc-claims` 用 `{"claims":[]}` 有） [H] |
| P3-27 | 抑制台账双基线 | `scripts/check-suppressions.mjs:18` = 315 与 `test/governance/eslint-suppression-budget.test.ts:64` = 317 两份真源数值不一致（严格侧 315 零余量先兜住，故非 fail-open，但只改一处即静默漂移）；逐规则 ceiling 有 4 处冗余（如 `max-lines-per-function` 11 vs 实测 6） [H] |
| P3-28 | CI 重跑判据 | `.github/actions/win-vitest-retry/action.yml:37-46` 判据一要求输出含 `FAIL … .test.ts`，而 vitest 对未处理异常/拒绝只打 `Unhandled Errors` 段 → 这类**真失败**会被判成收尾竞态重跑一次 [H] |
| P3-29 | 测试面残留 | 定长实睡 150 处（28 处 ≥100ms）、2 处墙钟 `retry:2`、跨档重复夹具 112 组 / 314 个函数体（`stubEmbed` 与 `collect` 各 13 份、chat `setup` 11 份等）；`check-comments` 1,478 行 + `check-counts` 897 行占 `scripts` 根 42% 行数 [H] |
| P3-30 | 跨平台语义未验 | 79 处 `skipIf` 中 69 处是 `process.platform === 'win32'` → win 腿不跑 69 条（由 CI ubuntu/mac 腿覆盖）；win 本机无法验证目录 fsync / rename 覆盖 / Unicode 归一化组合 [B/E] |

## 7 无法判断项

1. **跨平台真实语义**：macOS/Linux 的目录 fsync、rename 覆盖、APFS/HFS 大小写与 Unicode 归一化组合（`platformCaseFold` 的实际效果）只能靠 CI 三腿或真机日志，本机（win）测不了；69 条 `skipIf(win32)` 用例的真实覆盖质量同理。
2. **双进程真实争用的停顿分布**：`busy_timeout=5000`、跨进程写锁、书键缓存失效广播在 GUI + CLI 并发时的实际等待/超时率，需真实并发压测（本环境禁 e2e/electron）。
3. **性能型 P2 的实际量级**：`version.ts` 的每写 prune 与 64KB 头读（P3-03）、`trace-stats` 的排序阻塞（P3-07）、`document`/`studio/server/api` 的同步 FS 调用面，需要真实书库规模与埋点才敢定量；本轮只做静态判断与微基准（30 万条 3.05MB/55ms、2 万轮堆增长两项有实测）。
4. **大书真实 RAG 延迟与召回质量**：RAG 为 JS 余弦 BLOB 全扫描，200 万字书（约 3.5 万块）的查询 P95 与「降级回落精准读取」的实际触发率需真机样本。
5. **上游模型端点形态**：非 Anthropic/OpenAI 标准形态的聚合网关（多模态块、非标准终止值、限流头缺失）对适配器的影响只能按现有代码推断，无真实端点多例样本。
6. **恢复/续传类语义**：回收站与清单被同步盘半写后的恢复、「同尺寸同 mtime 改写」的检测精度（已用 ns 精度 + 低精度卷降级覆盖但无法在本环境复现同步盘时序）；更新包续传一致性（当前实现明确不做）。
7. **`chat_max_calls` 的真实消费面**：`web-next` 全库无该键（仅服务端 `src/studio/server/api/config.ts:130` 校验与 AI 预算闸消费）→ 若确定只经手编 `book.yaml`/第三方 API 客户端出现，P2-02 的实际用户可感度应下调；需产品口径确认设置面板是否计划接该键。
8. **更新链的信任根是否需再上一层**：`src/update/` 全目录无签名/公钥校验路径（grep `signature|pubkey|ed25519|verifySignature` 零命中），实质信任根是「TLS + GitHub 账号 + sha256 清单（清单与包同仓储发布）」。是否需要发布方签名锚属发行决策，本轮只读源码无法判断其验收底线；`verify:responses` 打包态实连亦未跑（无凭据/无实例）。

## 8 建议修复顺序（Top 5）

1. **P1-01 定稿前置落盘**——唯一 P1，直接决定「定稿版本」这个产品承诺是否成立；改动局部（一个函数 + 两个入口）且可加回退即红用例。
2. **P2-01 UNC 脱敏**——外发诊断包会带服务器名/共享名，是唯一「数据出仓」的泄漏面；一个正则族 + 一条用例即可。
3. **P2-02 / P2-03 两处静默吞掉内容**——同属「作者数据被无声丢弃」族（配置改了不生效、fm 注释被删），各配一条用例；与 P1-01 同批做，论点一致。
4. **P2-04 三处裸 `db.close()`**——契约违反且主控已复现泄漏，三行改动 + 把静态守护扩到 state/ai，收益确定。
5. **P2-07 注释门补判据（并决定存量处置）**——不修则 113 行批号叙事与约 2,900 行修复史叙事会继续增长，且门会继续输出「零批号标签」这一强背书；补判据后先跑存量计数再定「一次清理 vs 挂台账」。

顺带建议：P2-10（L2 补 `format:check`/`lint:prune`）与 P2-09（覆盖率重基线）属「门自身维护」，改动成本低，可与任一批搭车；P2-11（`cache-registry` 下移 `shared/`）建议单独一批，因为它会动 7 个文件的 import 面。

## 9 出口

**有条件通过。**

- 代码完成度与工程质量都在可发布水准之上：主链闭环、静态门全绿、9,851 用例通过、无 P0、无凭据泄漏、无数据不可恢复路径。
- 条件一条：**P1-01 修复（定稿链补前置落盘）+ 一条回退即红用例**。理由：该缺陷直接否定「定稿 = 定稿版本」的产品语义，且修复面小、可完全回归。
- 建议同批收口三条 P2（P2-01 / P2-02 / P2-03，均为「声明与实现不一致且静默」）；其余 P2 与 P3 按 §8 与 §6 排期，不构成本次通过的条件。
- 本条与本轮其余结论相互独立；对照第一、二轮的条件与结论不在本档引用面内（按要求未读既有评审档）。

## 10 与分域结论的判定差异（主控重判记录）

分域审计共给出 3 条「P1 级」与 28 条 P2 结论；主控对全部 P1 与 6 条高优先 P2 做了独立复核，结果：**P1 下调 2 条、维持 1 条；P2 调档 2 条、改判据 1 条**。差异逐条记此以便复核者对齐：

| 分域原判 | 重判 | 理由 |
|---|---|---|
| A 域 P1：`trace-stats` 耗时数组「阻塞 Electron 主进程」 | 降为 **P3-07** | ①路由只经 `src/studio/server/api/trace-stats.ts:69` 调用，而 studio server 跑在 `utilityProcess.fork`（`src/desktop/server-manager.ts:410`），阻塞的是服务进程事件循环，不是主进程；②实测 30 万条 = 3.05MB / 55ms，真实书库 `llm/call` 事件量为千级，性能影响可忽略；③保留的有效结论是「注释与实现相反」+「同批 `cost-stats` 已流式化而此处漏改」 |
| E 域 P1：裸 `db.close()` 泄漏 | 降为 **P2-04** | 泄漏本身主控已复现（+13MB/2 万轮 vs 0.00MB），但分域档「≈10MB/天」的数量级不成立——前端无固定轮询（`src/studio/web-next/src/views/WorkbenchView.vue:100-143` 只在进页/切书/生成结束时拉 `/state`），按实测单轮 ≈0.65KB 推算实际日增量远低于该数；结论改为「确定性泄漏、随调用频度单调增长」 |
| D 域 P1：定稿链缺前置落盘 | **维持 P1-01** | 主控逐链复核成立：服务端按盘上字节结算（`src/document/finalize.ts:183-188` + `src/document/status.ts:48-51`），三个入口均不冲刷，脏窗最久等于 autosave 节拍（默认 ≥30s），与 `src/studio/web-next/src/shared/body-writeback.ts:14-17` 的不变量 2b 直接冲突 |
| F 域 P2：「头注声明与 digest 优先自相矛盾」 | 收窄为 **P3-15** | `src/update/download.ts:7-9` 明写「校验值优先用资产 `digest`，缺失时回落 `SHA256SUMS.txt`」，digest 优先是已声明口径；`src/desktop/update-controller.ts:183-184` 的注释说的是「清单地址不取响应」，两处不矛盾。保留的有效结论只有「期望值在整包下载之后才解析，未 fail-fast」 |
| C 域 P2：「下载单飞跨进程共写」 | 维持 **P2-05** 但改判据 | 主控复核确认单飞占位确实在 `await` 之后（`:140` 判、`:173` 置），同进程双击窗与跨进程共享缓存两路都成立；分域档「跨进程/跨 await」措辞保留，但补充 `.part` 无 pid/随机后缀这一直接成因 |
| H 域 P2：「抑制台账双基线 315 vs 317」 | 降为 **P3-27** | 两处数值确不一致，但严格侧（脚本 315、零余量）先兜住，任何新增都会在脚本门红，故非 fail-open；性质是维护隐患而非当前缺陷 |

另：`check:harness` 的采用面在审计期内由 7 门变 8 门（新增 `skill-catalog`，副本 0.1.8→0.1.9），该门在 `09e08de5` 实跑 PASS 且 manifest 有实文；「4 份空判据门」为刻意空置且由 `check:harness-copy` 对账，不属欠账（P3-26 保留的只是「空置无自证文」与「副本新增校验器不接线」两点）。

---

审计结论一句话：**这是一套「主链可信、门禁自觉、注释过载」的代码库——本轮真正需要动手的只有一件（定稿落盘），真正需要警惕的是「门说全绿、实测有差」的那三处（注释门射程、计数口径、覆盖率余量）。**
