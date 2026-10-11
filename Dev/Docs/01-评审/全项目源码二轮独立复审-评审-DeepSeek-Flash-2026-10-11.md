# 全项目源码二轮独立复审报告

- 执行模型：DeepSeek-Flash
- 评审对象：`1.0.0-rc.4` 工作树（commit `b4001a07`），全库源码 + 测试 + 工程门 + CI
- 评审范围：`src/`（972 档 / 328,788 行，另 web-next 前端 296 档 / 60,384 行）+ `test/`（1,375 档 / 226,026 行）+ `scripts/` + 工程配置与 CI
- 评审方式：5 个分域独立深读（① AI 链与写作流水线 ② 服务端与 API ③ 前端 web-next ④ 基础设施与持久化 ⑤ 测试工程与工程门）+ 评审人亲自复核关键锚点 + 全量测试与门的实测
- 前置声明：本次评审独立于既有报告，不读 `Dev/Docs` 中任何既有评审/方案结论（作者要求「忽略现有文档」），所有结论只依据源码、配置与可执行证据
- 修复状态：**已收口**——P0×1 + P1×20 + P2×18 共 39 条全部处置（实修 36 / 登记 3），逐组处置与全门实录见 §七

---

## 〇、结论速览

**四问直答**

1. **完成进度**：功能面已齐备，处于「RC 收口」阶段而非「骨架 + 半成品」形态。全库 `TODO/FIXME` 实质命中 0 条（唯一 `TODO` 字样在 `src/knowledge/update.ts:138` 是作者模板占位，非开发遗留）；无假接线模块、无空壳占位。版本 `1.0.0-rc.4`，5 个月 1,030 次提交。各域完成度：AI 链 ~88%、服务端 ~90%、前端 ~92%、基础设施与持久化 ~95%、测试工程 ~90%——整体 **~91%**。剩余 9% 不是功能缺口，而是三类欠账：①启动健壮性（前端启动链可白屏 ~50 秒，见 P0-1）；②跨域重复实现（同名逻辑 2-4 份并存，约 20 处，见 §二 P1/P2）；③工程收尾（覆盖率数值无守护、SFC 视图层零单测门、书库迁移链无版本锚）。
2. **完成质量**：**显著高于同规模个人项目**。三类硬证据：①全库零 `any`、零 `@ts-ignore`、零 `eslint-disable`（实测 `src/` 全量扫描）；②全量测试 1,304 档 / 9,090 用例通过（163 秒，本机实测）、`tsc --noEmit` 零错、`check:counts` 与 README 数字一致；③最难的三条正确性线——跨进程锁 stale 接管、书改名事务性迁移、sqlite 版本阶梯——均有工业级实现与回归锚定（见 §五亮点）。但存在 **1 条 P0 + 20 条 P1**，其中前端启动白屏与「客户端断开不中止长 AI 任务」两条直接影响用户体验与成本。
3. **简洁优雅**：**结构 B+、简洁 C**。分层与单源收口在线协议级做得扎实（表驱动 provider 注册、统一 runTask 编排、错误信封单出口、缓存登记制 + 机器门）；但被三样东西压住简洁度：①**注释占比极高**——后端域 30%-41%（全库约 3.4 万注释行），大量为变更史与批号考古，前端 17%（相对健康）；②**跨域双实现**——TokenUsage 累加、金额取整、章号定位、stat 指纹、isUtf8 等通用逻辑各 2-4 份复制；③**测试量 1.37 倍文件 / 0.7 倍行数**于源码，治理成本开始显性化（批号密度：用例标题 8.4%、注释 6.1%）。
4. **优化空间**：立即可做的低风险项 12 条（§四 A 层：去重 + 常量单源 + 启动预算，合计约 2 周内工作面）；需拍板的 4 条（B 层）；架构级欠账 5 条（C 层）。第一优先是 **修启动白屏**（用户第一触点，修法明确）；第二是 **收敛 20 处跨域重复**（风险最低、收益面最广）；第三是 **给覆盖率数值与 SFC 视图层补机器门**。

**一句话总评**：这是一个「正确性已被工程化到高水位、简洁性被工程化牺牲」的代码库——核心链路（并发写、迁移、预算、审计）的可靠性设计超过其对标项目一个身位，主要风险不在「写错」，而在「同一件事写了多份」（漂移面）与「用户第一触点的边界处理欠预算」（白屏面）。

---

## 一、客观画像（本机实测）

### 1.1 规模与构成

| 面 | 实测 |
|---|---|
| 主源码 `src/`（不含 web-next） | 972 档 / 328,788 行（其中 `test/` 不重复计） |
| 前端 `src/studio/web-next/src` | 296 档 / 60,384 行（TS + Vue SFC） |
| 测试 `test/` | 1,375 档 / 226,026 行（单测 1,304 档 + e2e 34 spec + 治理档） |
| scripts / CI | 16 个 Node/TS 脚本 + 2 个 workflow（三 OS × 双 Node 矩阵） |
| 模块 TOP（行数） | `studio/server` 15.7k · `ai` 16.0k · `document` 10.0k · `desktop` 7.1k · `format` 7.0k · `check` 5.2k · `process` 4.8k · `events` 3.6k |
| 最长源档 TOP5 | `document/service.ts` 1,289 · `ai/runner.ts` 1,235 · `desktop/server-manager.ts` 1,146 · `events/store.ts` 1,054 · `web-next/stores/prefs.ts` 1,015 |

### 1.2 工程门状态（本次亲自实测）

| 门 | 结果 |
|---|---|
| `vitest run`（全量） | **1,304 档全过 / 9,090 通过 + 8 条件跳过 / 163 秒**，0 失败 |
| `tsc --noEmit` | 零错 |
| `check:counts` | 通过（README 声称 1,304 档 / 8,618 静态用例与实测一致；动态执行数 9,090 含参数化展开） |
| `src/` 全量扫描 | `any`：0；`@ts-ignore` / `@ts-expect-error` / `eslint-disable`：0（仅 1 处注释性提及） |
| `TODO/FIXME/HACK` | 实质 0（1 处为业务模板占位） |
| eslint 抑制表 | 509 条 / 177 档（计数式冻结，新违规即红）——结构见 §3.5 |
| 注释密度 | 后端域 30%（format）- 41%（fs）、check 37.7%、desktop 37.5%、document 35.8%、ai 33.9%、server 33.1%；前端 17% |

### 1.3 测试与 CI 体系

- vitest 双项目分桶（node 1,089 档 / happy-dom 215 档），31 个覆盖率阈值桶，覆盖率基线按「实测 −2pp 向下取整」逐桶收紧；
- CI 三 OS × Node 24/26 五腿矩阵 + 独立 e2e job；audit ≥high、typecheck、vue-tsc、lint（含抑制表 prune 后 diff 空校验）、packaging、四类 check、覆盖率单腿门全部接线；
- 发布链 fail-closed：`desktop.yml` 发布前轮询「同 commit ci.yml 全绿」，120 秒无运行即判红（防 CI 被停用静默放行）；
- `check-counts` 是「门中门」：AST 级检出 `.only` / 无条件 `.skip`、零断言档、README 数字对账、e2e spec 顺序快照五合一。

---

## 二、问题清单

### 2.1 P0（1 条，均经评审人亲自复核）

#### P0-1 前端启动双 `await` 可致白屏约 50 秒（用户第一触点）

- **事实**：`web-next/src/main.ts:29` 与 `:35` 两个 top-level await 阻塞挂载。`boot()`（`api/client.ts:26-63`）为 5 秒超时 × 4 次尝试（3 次重试 + 指数退避），最坏 ≈21.3 秒；随后 `usePrefsStore().init()`（`stores/prefs.ts:234-238`）调 `getGlobalPrefs()`（`api/prefs.ts:105`，未传 timeout）走 `apiJson` 默认 **30 秒** 超时（`client.ts:188`）。两段串联，本地服务「接受连接但不响应」时，界面白屏可达 ≈51 秒且无任何本地渲染兜底。
- **影响**：用户在服务端异常（罕见但真实：渲染进程先起、server 迁移卡顿、磁盘慢）时看到长白屏，会误判为应用损坏；正是 README 面向作者的「开箱即用」承诺的反面。
- **修法**：给启动链设总预算（如 6 秒），到期即离线态挂载并后台补齐；`prefs.init` 超时降为短档（如 3 秒）且不阻塞首帧，init 完成后 re-apply。

### 2.2 P1（20 条）

| # | 问题 | 证据 | 修法要点 |
|---|---|---|---|
| P1-1 | **备料链外层 catch 静默**：`resolveTier`（可抛——`loadProviders` 解析 providers.json）在 try 之外；`prepareMaterials` 整体抛错时调用方 `catch {}` 零留痕，备料全丢无告警 | `src/process/materials.ts:228`；`src/ai/orchestrate/self-heal.ts:475-485` | 外层 catch 补 `log.warn(errMsg(e))`；`resolveTier` 包 try 降级 undefined |
| P1-2 | **观测层「读失败」与「无数据」不可区分**：事件库读失败静默返回空壳，UI 将读失败渲染为「零成本 / 未配置价格」 | `src/ai/cost-stats.ts:100-108`；`src/ai/trace-stats.ts:89-90`；`src/ai/llm-call-read.ts:64-65`、`:108-109` | 空壳加 `degraded:true` 或 log.warn 留痕，前端区分两态 |
| P1-3 | **TokenUsage 累加 4 份独立实现** + estimated 粘性标记重复 | `src/ai/runner.ts:1136-1155`；`src/ai/calls.ts:510-528`；`calls.ts:614-630`；`src/ai/orchestrate/self-heal-generate.ts:94-108` | 抽 `addUsage(acc,u)` 单源 |
| P1-4 | **金额 1e-10 取整散 4 处**，精度口径靠复制维持 | `src/ai/pricing.ts:133`；`src/ai/calls.ts:526`；`src/ai/cost-stats.ts:52`、`:95` | 合并 `roundCost(x)` 单源 |
| P1-5 | **「按章号定位正文」三套实现**（全树 walk / 两层扫描 / 异步 walk），新特性需三处同改 | `src/format/chapter-lookup.ts:70-77`；`src/process/prepare.ts:45-86`；`src/process/materials.ts:92-132` | 至少收敛一个「两层优先 + walk 兜底」公共原语 |
| P1-6 | **章号解析口径分裂**：`Number()` 宽松（`'5.0'`→5、`'0x10'`→16 可过）与 format 严格整数正则不一致，结构操作闸可能放行畸形 fm | `src/document/structure-core.ts:102-103`、`:229-231` vs `src/format/chapters.ts:117-157` | 抽 `parseChapterNo` 单源（format 层），三处消费 |
| P1-7 | **三处手写 `replaceAll('\\','/')`** 绕过 `normalizeWinSeparators` 单源：posix 上会扭曲含字面反斜杠的合法文件名身份键 | `src/document/structure-core.ts:218`；`src/document/structure.ts:90`；`src/document/structure-split.ts:254` vs `src/fs/safe-path.ts:153-155` | 改委托单源函数 |
| P1-8 | **默认值双源**：输入预算 80000（prepare vs format/yaml）；场景兜底 prepare 缺省 `'战斗'` vs 写稿链 `['通用']` | `src/process/prepare.ts:489` vs `src/format/yaml.ts:58`；`src/process/prepare.ts:165` vs `src/process/draft-pipeline.ts:472` | 读同一常量/默认配置对象；prepare 缺省对齐 `['通用']` |
| P1-9 | **常量/归一化重复**：16_384 输出上限双份（适配器 + quirks 表）；Anthropic baseUrl 归一化私有副本 | `src/ai/provider/anthropic-adapter.ts:78` vs `model-quirks.ts:217`；`anthropic-adapter.ts:70-72` vs `models.ts:21-24` | 删适配器副本，统一走 quirks/协议兜底链 |
| P1-10 | **`CLWRITING_DRIVER` 环境变量短路 5 处**，驱动选择靠环境变量散布判断 | `src/driver/index.ts:20`；`src/ai/mock-tool.ts:60`；`src/ai/provider/models.ts:68`；`provider/probe.ts:35`；`src/ai/runner.ts:274-281` | 统一由 driver 选择结果注入 |
| P1-11 | **客户端断开不中止长 AI 任务**：analyze/review/rewrite/chat 非 SSE 面在途时断连，runSpec 继续烧钱并写死 socket | `src/studio/server/api/task-gate.ts:6-7`（自认不在闸范围） | `runGatedGenerationIn` 挂 `req.once('close')` → `ctrl.abort()`，SSE 保留后台继续语义做 opt-out |
| P1-12 | **输入校验双轨**：26 处 handler 内联 readJson + 手工校验 vs 24 处 `parse` 声明 | `server/api/schema.ts:11-12` 自认；例 `documents-crud.ts:47`、`documents-save.ts:86` | 无错误优先级依赖者机械迁移 |
| P1-13 | **错误码 → HTTP 状态映射两套**：同一 `WRITE_ERROR` 在 structStatus→409、snapshots 内联→400 | `server/api/documents-core.ts:315-354` vs `server/api/snapshots.ts:501-504` | 统一走 `structStatus` |
| P1-14 | **prefs 写入无键白名单/类型收敛**：任意键与任意 JSON 值直接合并落盘 | `server/api/prefs.ts:121-134`（book）、`:209-224`（library） | 键白名单 + 值类型校验（对齐 config.ts numericChecks 模式） |
| P1-15 | **写侧缓存失效覆盖不均**：PUT /file 后 /state 缓存不失效（≤5s 旧值）；trace-stats/cost-stats 完全无缓存，每次全量聚合 | `server/api/state.ts:40-44`、`:63-67`；`server/api/files.ts:238`；`trace-stats.ts:32-36`；`cost-stats.ts:24-27` | 建「高频写面 → 缓存失效点」清单 |
| P1-16 | **观测面水位不齐**：`maskSelfCheckData` close 前全表扫（自认）；`store-migrate.ts` 头部 JSDoc 复制粘贴残留（嵌套 `/**`） | `src/events/store.ts:726-735`（自认）；`src/events/store-migrate.ts:1-8` | 索引随 v2 阶梯步下发或降 debug 开关；删重复注释块 |
| P1-17 | **书库 layout 迁移链无版本锚**：每启动全量重跑幂等迁移，顺序是隐式契约，新迁移易插错位 | `src/studio/server/index.ts:461-496`（顺序依赖注释 `:485-492`） | 引入书级 `layout_version` 或集中迁移编排表 |
| P1-18 | **机检缓存代次手工 bump**：`CHECKER_GENERATION='a1-v2'` 字面量，检查器语义演进若漏 bump，旧结果按章指纹命中复用（红黄项静默陈旧） | `src/check/tree-issues-cache.ts:33-37` | 生成值并入各检查器导出常量或规则表哈希，测试锚定 |
| P1-19 | **覆盖率数值阈值零机器守护**：governance 只锁 glob 键不锁数值，31 桶 × 4 指标可被静默下调；已出现两处注释-配置漂移 | `test/governance/coverage-threshold-globs.test.ts:120-144`；`vitest.config.ts:172 vs :173`、`:251 vs :261` | 阈值快照入 governance（读配置文本断言全表） |
| P1-20 | **test/ 异步卫生规则被抑制表预冻结**：`no-misused-promises` 86 条中 77 条在 test/（30 档），测试面仅剩的机器卫生闸被大比例预占；计数式抑制有「修一换一」松弛 | `eslint-suppressions.json` 统计；`eslint.config.js:25-27`、`:179-181` | 精确化 `checksVoidReturn` 降噪后清表 |

### 2.3 P2（精选，域内其余见附录）

| # | 问题 | 证据 | 修法要点 |
|---|---|---|---|
| P2-1 | 前端 `prefs.ts` 1,015 行混四职责（默认值锚 / 33 键表 / 持久化单飞 / 409 恢复） | `web-next/src/stores/prefs.ts:44-138`、`:612-786`、`:842-1015` | 拆 persist 与 rows 两件 |
| P2-2 | `ChatMessages.vue` 735 行；模板对每张工具卡把 `toolSummary()` 调两遍 | `web-next/src/components/panels/chat/ChatMessages.vue:349-350` | 按卡算一次 + 拆子件 |
| P2-3 | 切书样板双轨：18 处手写 watch + Book.vue `:key` 重建并存 | `web-next/src/views/WorkbenchView.vue:111-131` 等；`pages/Book.vue:71-84` | 统一 `useBookScoped(name,{load,reset})` |
| P2-4 | 章节树每目录封顶 100 行，第 101+ 章只能靠搜索——2,000 章书不可顺序浏览 | `web-next/src/components/panels/ChapterTreeItem.vue:56`、`:294-301` | 尾部加「再显示 100 项」增量窗口 |
| P2-5 | 静默降级面过宽：对话历史/分支拉取失败全静默，界面空白无提示 | `web-next/src/stores/chat.ts:258`、`:311-313` | 对用户可感知缺失补合并 toast |
| P2-6 | `style-harvest` 同步/异步孪生 ~90% 逐行复制（同步版零生产调用） | `src/process/style-harvest.ts:102-153` vs `:156-218` | 抽共享内核 |
| P2-7 | 指纹缓存对低精度 mtime FS（FAT/exFAT/部分 SMB）存在同尺寸写陈旧窗（注释自认） | `src/document/manifest.ts:70-75`；`src/install/books-store.ts:43-53` | 低精度 FS 降级不缓存 |
| P2-8 | `isUtf8` 第 4 份实现；`sha256` 内联 30+ 处；stat 指纹 `${mtimeNs}:${size}` 手抄 ≥5 份 | `src/export/index.ts:38-47`；`src/fs/hash.ts:12-20`；`src/document/manifest.ts:76-83` 等 | 下沉 shared 三形态单源 |
| P2-9 | 探测指纹双份实现（`fieldsChanged` vs `probeFingerprint`，注释自认「两处将来须同步演进」） | `server/api/providers.ts:266-270` vs `:516-519` | 抽同一函数 |
| P2-10 | 导出并发闸是模块级全局状态，同进程多 server 实例互相影响 | `server/api/io.ts:57-58`、`:66-118` | 随组装根实例化（对齐 TaskGate 模式） |
| P2-11 | 大响应分页不均：audit 有 limit≤500、chat-history 有尾窗，overview/tree/foreshadows 全量返回 | `server/api/audit.ts:204-218`；`chat-history.ts:44-83`；`overview.ts` 等 | 量级增长前补 cursor |
| P2-12 | 启动双字重（前端字体枚举 + 后端检索索引）与诊断 zip 无 zip64（>4GiB 抛错） | `src/diagnostics/zip.ts:12-16`（自认） | 超限改多包/截断并提示 |
| P2-13 | eslint `complexity` 54 条 / 51 档、`max-depth` 13、`max-lines-per-function` 13 贴线抑制；热点档 `EditorView.vue` 31 条、`WbAdvanced.vue` 30 条 | `eslint-suppressions.json` 明细 | 贴线函数拆解与类型补强纳入批计划 |
| P2-14 | 前端模块级 window 监听不清理（注释声明「页面寿命」但测试/热更新环境累积）；`useRelationGraph.ts` 719 行混合布局/交互 | `web-next/src/composables/useShelf.ts:113-121`；`useRelationGraph.ts:554-640` | 导出 dispose；拆交互 hook |
| P2-15 | 测试批号密度：用例标题 914/10,836（8.4%）、注释 1,481/24,106（6.1%）、53.3% 档含批号，且 test/ 豁免于注释门 | `scripts/check-comments.mjs:12`；统计 | 新档标题禁批号，旧档随改随清 |
| P2-16 | SFC 视图层零单测覆盖门（pages/views 桶 0/0）；单测对 views 恒 mock，真实视图只有 e2e 且不回流 v8 | `vitest.config.ts:253-260` | 机器化回收条件或接 playwright coverage |
| P2-17 | 治理测试 ecma 大档 40 档 >500 行（max 1,146 行）；`check-counts` 零断言门只到文件粒度（档内空洞不拦） | `test/governance/studio-token-exempt-sync.test.ts`；`scripts/check-counts.mjs:264` | 拆档 + 断言门下沉到用例粒度 |
| P2-18 | `format/manifest.ts`（章纲清单）与 `document/manifest.ts`（文档清单）同名不同物，头注互不指认，新人易误判重复 | `src/format/manifest.ts:1-8` vs `src/document/manifest.ts:1-8` | 改名或头注互指 |

> 附录（域内其余 P2/P3，各域报告原样保留在评审人工作记录中）：AI 域 8 条（probe 超时硬编码、九参位置参数、sort 非空断言、知识层模板 TODO 字样等）；server 域 6 条（缓存旗标不一致固化、占闸三连样板 11 处、请求体排空双份、错误码字面量 56 处等）；前端域 10 条（视图注册表、EmptyState 覆盖、settings-shared.css 813 行全局装载、409 恢复链两套等）；基础设施域 14 条（脱敏双词表、同步/异步开库壳重复、纯 re-export 垫片多层、tmp 清扫深递归护栏等）。合计 P2/P3 约 60 条，均带 file:line 证据，随批按域认领。

---

## 三、简洁优雅评估（直答）

### 3.1 结构与分层：B+（在线协议级）

- 服务端 router → 端点档 → 领域服务三层清晰，116 条路由全部接线无死端点；`schema.ts` 的 gate→parse→handler→cleanup 执行序单点；错误信封单出口（264 处 `replyError` 统一 `{code,error}` + 脱敏）。
- 前端 pages→shell→views→panels/components 分层清晰，104 个组件全部有引用（无孤儿），31 个 API 客户端模块全被消费。
- AI 链「契约→任务声明→统一执行器→provider 适配→观测」职责单一，11 条链路的五件套已声明化收敛（`src/ai/tasks/specs.ts`），单点入口 `runSpec → runTask`。
- 亮点级设计：provider 三协议表驱动注册、`createStreamFinalizer` 三适配器共享流尾收口、跨进程锁「原子改名认领」、书改名事务性迁移、sqlite `user_version` 阶梯 + `assertLadder`。

### 3.2 简洁性：C（被三样东西拖住）

1. **注释即变更日志**。后端域注释占比 30%-41%（`fs` 41.4% 最高，`check` 37.7%），生产源码中批号标记（`R0911-`、`dd-`、`W-P2-`、阶段号）实测 97 处；单函数 39 行注释配 60 行代码（`runner.ts:289-314`）。注释本身质量高（记录决策与不变量），但**历史沿革与辩论记录沉淀在生产代码里**，等于把 git 历史搬进源文件。前端 17% 相对健康。
2. **跨域双实现**。约 20 处（§二 P1/P2 已列）：TokenUsage 4 份、金额取整 4 份、章号定位 3 套、isUtf8 4 份、stat 指纹 5 份、sha256 入口散 10+ 处、输入预算默认值 2 源、场景兜底 2 套、Anthropic 归一化 2 份、16_384 2 份。每处单看都有理由（如「避免拉依赖图」），合看是漂移面——一处改、他处忘。
3. **测试量对冲复杂度**。测试 1,375 档 / 0.7 倍源码行数 / 1.37 倍文件数，治理成本已显性化（批号密度、38 档 >500 行的大档、53% 档注释含批号）。断言质量抽查良好（0 空档、0 无条件 skip、`not.toThrow` 几乎均与状态断言配对），但「用大量文本对冲」的工程风格与简洁目标存在张力。

### 3.3 抽象选择：判断正确

- 抽象层级大多单层合理（薄门面 + 纯函数 + 表驱动），未见过度设计的洋葱层；
- 少数刻意取舍有登记（`check/run.ts` 只许 re-export 以断环、`document/structure.ts` 桥接为去 import 环），属「拆细保无环」的自觉选择；
- 反例少数：`orchestrate/chat.ts` 兼容 re-export 桥、`format/words.ts` 纯垫片、`events/store.ts` 四组桥——多层跳转增导航成本，1.0 后可 codemod 收口。

### 3.4 完成度的「形状」

剩余 ~9% 的分布很有意思——**核心正确性资产（并发、迁移、审计、预算）完成度最高（95-96%），用户触点边界（启动白屏、章节树浏览上限、断连中止）与工程收尾（覆盖率守护、迁移锚）反而欠账**。这是典型的「内核优先于外壳」的演进顺序，代码库已到「内核够硬、外壳该补」的阶段。

---

## 四、优化建议（按收益 ÷ 成本分层）

### A. 可立即做（低风险，建议下一批集中处理）

1. **启动预算**（P0-1）：boot + prefs.init 总预算 ≤6 秒，超时离线态挂载，prefs 后台补齐。约 0.5 天。
2. **跨域去重**（P1-3/4/8/9）：`addUsage`、`roundCost`、输入预算常量、16_384 单源。约 1 天，机械改。
3. **备料与观测留痕**（P1-1/2）：外层 catch 补 warn；观测空壳加 `degraded` 标记。约 0.5 天。
4. **断连中止**（P1-11）：`runGatedGenerationIn` 挂 close→abort。约 0.5 天。
5. **错误映射与校验统一**（P1-12/13/14）：structStatus 收口、prefs 白名单。约 1 天。
6. **常量单源剩余项**（P1-5/6/7/10）：parseChapterNo、normalizeWinSeparators 委托、driver 选择注入。约 1.5 天。

### B. 需拍板（产品/口径决策）

1. **覆盖率数值守护形态**（P1-19）：阈值快照入 governance vs 单源 JSON 生成。
2. **SFC 视图层单测策略**（P1-20 相关）：机器门回收条件 vs playwright coverage 回流。
3. **注释精简口径**：是否启动「生产注释只留不变量、历史沿革移 docs」的批量整顿（涉及全库 3.4 万注释行，需定迁移规则）。
4. **书库迁移版本锚**（P1-17）：书级 `layout_version` 落点（`.clwriting/` vs books.jsonl）。

### C. 架构级欠账（需设计决策）

1. **前端超长档拆分**（prefs.ts / ChatMessages / EditorDocHead / useRelationGraph）：按「编排壳 + 子件」模式，逐档评审后动。
2. **测试批号清理**：test/ 注释门豁免撤销 + 新档禁批号 lint，存量随改随清。
3. **re-export 垫片/桥收口**：1.0 后全库 codemod 直引实现件。
4. **章节树大书 UX**：增量窗口或虚拟滚动（2,000 章级）。
5. **服务端端点样板收口**：TTL 缓存工厂、占闸三连 helper、错误码 `as const` 枚举表。

---

## 五、亮点（值得保留的资产）

1. **跨进程锁 stale 接管竞态真正闭合**：从「判 stale→删共享名」改为「原子改名认领」，release 前逐字节核验锁内容；`file-identity.ts` 用 bigint dev+ino 规避 2^53 塌缩假阳性（`src/fs/cross-process-lock.ts:15-24`、`:281-303`）。
2. **书改名事件库迁移是全仓最完整的事务性文件迁移**：WAL checkpoint → 墓碑前置写 → 逐侧车 rename → 钥匙同事务改写 → 失败逆序回滚且保留 fail-closed 墓碑（`src/events/store.ts:940-1048`）。
3. **草稿保存协议与编辑器同款并发纪律**：per-doc 跨进程锁 + journal pending/settled + 锁内双向认领复核 + 非 UTF-8 fail-closed，降级理由逐条写入注释（`src/process/draft-pipeline.ts:74-107`、`:188-353`）。
4. **预算账本工程化**：损坏保守阻断而非归零放行；预算闸 check-then-act 竞态有官方记档（`src/ai/calls.ts:77-211`、`:355-363`）。
5. **「模型可见 ⟺ 已记录」有闭环**：注入面登记（promptFiles/tools/meta hash）+ 运行期抽查 + 「未收到 done 显式留痕」（`src/ai/tasks/spec.ts:122-171`、`turns-visibility.ts:29-58`）。
6. **SSE 生命周期工业级**：一次性 ticket、预检不烧票、背压字节+次数双判死、20 分钟静默挂死兜底（`server/api/stream-ticket.ts:49-94`、`stream-sse-writer.ts:101-127`、`stream-watchdog.ts:26-30`）。
7. **安全面收口**：Host 精确匹配防 DNS rebinding、SHA-256 恒定时间 token 比较、双 realpath 路径闸、回收站清单前缀校验（`server/index.ts:575-587`、`server/http.ts:102-107`、`fs/safe-path.ts:54-89`）。
8. **诊断包隐私红线名副其实**：逐行 `redactSecret` + 路径占位 + 「书稿正文永不入包」的显式声明（`src/diagnostics/index.ts:200-215`、`:229-239`）——与 rc.4 前复审指出的旧缺口形成对照，此面已修好。

---

## 六、评审方法与证据

### 6.1 分域与预算

| 域 | 覆盖 | 精读量 |
|---|---|---|
| ① AI 链与写作流水线 | `src/ai`、`process`、`driver`、`review`、`knowledge`、`learn` | 精读 15-30 档 |
| ② 服务端与 API | `src/studio/server`（69 档 / 15.7k 行） | 精读 28 档 |
| ③ 前端 web-next | `src/studio/web-next/src`（296 档 / 60k 行） | 精读 25-40 档 |
| ④ 基础设施与持久化 | `fs`、`install`、`state`、`log`、`events`、`cache`、`rag`、`document`、`format`、`check`、`desktop` | 精读 30-45 档 |
| ⑤ 测试工程与工程门 | `test/`、`scripts/`、`vitest/playwright/eslint` 配置、CI | 精读 20-30 档 |

### 6.2 本机实测命令与结果

```
npx vitest run --reporter=dot      → 1,304 档全过 / 9,090 通过 / 8 跳过 / 163s / exit 0
npm run typecheck                   → tsc --noEmit 零错
npm run check:counts                → 通过（README 声称 1,304 档 / 8,618 用例与实测一致）
src/ 全量 grep（any/@ts-ignore/TODO） → 0 / 0 / 1（模板占位）
注释密度逐域统计（本机脚本）          → 后端 30-41%，前端 17%
eslint-suppressions.json 结构分析    → 509 条 / 177 档（complexity 54 / max-depth 13 / misused-promises 86）
```

### 6.3 效力边界

- 未跑：Playwright e2e 34 spec（本次未动前端，按项目纪律 e2e 仅当批动前端时跑）、coverage 全量（CI 单腿门下）、electron 出包链、soak。
- 未读：`Dev/Docs` 既有评审（按作者要求独立重读）、`Dev/参考项目` 第三方仓库。
- P1-11 的「断连中止」面、P0-1 的白屏 51 秒为代码路径推演（超时常量 + 串行 await 均为实读），未做故障注入实测；P1 各条均经至少两域交叉或评审人亲自复核。

---

## 七、收口实录（修复实施与验收）

> 作者口令「全部修复」→ §二 全部 39 条（P0×1 / P1×20 / P2×18）按域分四波实施，主控统一收批。逐条处置与回归锚如下；改动明细见代码本身，此处只记处置与证据。

### 7.1 P0（1/1 办结）

| # | 处置 | 回归锚 |
|---|---|---|
| P0-1 | 启动总预算 6s：`shared/startup-budget.ts` 的 `awaitStartupWithBudget`（**合计**预算按剩余额度逐段扣减，非逐段各给 6s）；boot + prefs.init 两段串联改单点预算包装，到期即离线态挂载、两段后台跑完自行落位（不取消——boot 落 token / init re-apply CSS 变量，不刷新自愈）；createPinia/setActivePinia 提到包装前（组件外取 store 的前置条件不依赖 boot 完成）；同步抛错/拒绝按已落定继续，不阻断挂载 | `test/studio/webnext/startup-budget.test.ts`（5 例：正常序 / 首段挂死仍调次段 / 总预算封顶（非逐段独立）/ 同步抛错不阻断 / main.ts 接线漂移断言）。**回退验证**：撤预算包装 → 3 例转红 |

### 7.2 P1（20/20 办结）

| # | 处置 | 回归锚 |
|---|---|---|
| P1-1 | 备料链外层 catch 补 `log.warn` 留痕；`resolveTier` 包 try 降级 undefined（token 系数回落全局默认，不上抛） | `test/process/` 域内既有档扩例（降级路径断言 warn 通道 + 返回值；见该域档注释） |
| P1-2 | 观测层「读失败」与「无数据」两态分离：`streamLlmCallRows` 返回 `degraded`，`aggregateTrace` / `aggregateCost` 空壳标 `degraded:true` + warn 留痕；前端 WbUsageCard 分「统计暂不可用」与「暂无调用记录」两文案 | `test/metrics/trace-stats.test.ts`（预埋垃圾库 → degraded:true，对照空数据无 degraded 键）；`test/studio/webnext/dom/usage-card.test.ts`（两态文案分派） |
| P1-3 | TokenUsage 累加收 `addUsage` 单源（`ai/calls.ts` 导出；estimated 粘性置位随迁）；runner / calls 双站点 / self-heal-generate 四处改调（self-heal 数值单字段累加口径不同，注释明记不走单源的理由） | `test/ai/` 既有用例全绿 + 单源函数直测（四消费站点由治理门「单源对账」覆盖） |
| P1-4 | 金额 1e-10 取整收 `roundCost` 单源（`ai/pricing.ts` 导出），calls / cost-stats 四处改调 | 同上（pricing 域既有用例 + 消费点断言） |
| P1-5 | 章号定位收 `chapterPathByNumber` 单源（`format/chapter-lookup.ts`）：两层优先 + walk 兜底 + 命名归一，prepare / materials 两处改调 | `test/format/` 与 `test/process/` 域内档（find 语义等价断言） |
| P1-6 | 章号解析收 `parseChapterNo` 单源（format 层严格整数口径：仅认纯十进制整数 + 安全整数 + ≥1）；structure-core 三处 `Number()` 宽松解析改调 | `test/format/chapter-no-parse.test.ts`（畸形值 `'5.0'`/`'0x10'`/`'1e3'` 全拒）；`test/document/chapter-no-mismatch-gate.test.ts`（闸口径对齐） |
| P1-7 | 三处手写 `replaceAll('\\','/')` 改委托 `normalizeWinSeparators` 单源（posix 上不再扭曲含字面反斜杠的文件名身份键） | `test/document/` 域内档（posix 反斜杠文件名身份键断言） |
| P1-8 | 输入预算 80000 双源合一（yaml 读侧兜底与 prepare 裁剪同源）；场景兜底 `DEFAULT_CHAPTER_SCENES = ['通用']` 单源（`draft-pipeline.ts` 导出，prepare 缺省对齐） | `test/process/prepare-*` 与 `draft-*` 域内档（缺省值断言） |
| P1-9 | 16_384 双份合一（`CLAUDE_SAFE_MAX_OUTPUT_TOKENS` 单源，适配器删副本改 import）；Anthropic baseUrl 归一删私有副本改走 `models.normalizeBaseUrl` 单源 | `test/ai/provider/` 域内档（常量单源 + 归一行为等价） |
| P1-10 | `CLWRITING_DRIVER` 环境变量收「全仓唯一读取点」= `driver/index.ts` 的 `driverKind()`；选择结果经 `DriverHost.kind` 注入，mock-tool / models / probe / runner 四处自读全删 | `test/governance/` 与 `test/ai/` 域内档（`host.kind` 注入面断言；自读点静态扫描） |
| P1-11 | 非 SSE 生成长任务挂 `res.once('close')` → `ctrl.abort()`（`attachClientGoneAbort`，判据 `!res.writableEnded` 区分「正常写完」与「连接中断」）；任务落定在 finally 卸载监听（不再 abort） | `test/studio/api/gated-generation-interrupt-channel.test.ts` 扩 3 例（close+未完成→abort 且监听卸载 / close+已完成→不 abort / 落定后 close→不 abort）。**回退验证**：撤 abort → 1 例转红 |
| P1-12 | 输入校验双轨收敛：documents-crud / documents-save 等 handler 内联 readJson 迁 `defineRoute` 的 gate（404/409 前置门）+ parse（body 400）声明式两段；响应序逐位保留（gate 先于读体，docId 解析仍在读体前）；有错误优先级依赖的端点只收 readJson 一半（注释明记） | `test/studio/api/` 域内档扩例（响应序断言：404 找书 → 404 文档 → 400 body → 链内 409） |
| P1-13 | 错误码 → HTTP 映射收 `structStatus` 单源，snapshots 内联映射（WRITE_ERROR→400 与 structStatus→409 分裂）改调单源 | 同上域档（同码同状态断言） |
| P1-14 | prefs 写入面加键白名单 + 值类型校验（书级 8 键 / 全局 33 键两表，对照前端写面逐键登记）；白名单内类型不符 → 400，白名单外键丢弃不落盘 + warn 留痕（200 语义不变——防写花收敛面，不窄化契约面） | `test/studio/api/prefs-*` 域内档（越界键丢弃 + 类型不符 400 + 响应语义不变） |
| P1-15 | 写侧缓存失效清单补齐：PUT /file 后挂 `forgetStateCache`（/state 判态聚合即刻失效，不再 ≤5s 读旧判态）；trace-stats / cost-stats 从「每请求全量聚合」挂 5s TTL **+ 数据源探针**（见 7.5 复检发现） | `test/studio/server/api-endpoints.test.ts`（写源指纹不变 → 二次 GET 命中；**写源变化即刻失效**：种 llm/call 事件 → TTL 窗内 GET 重算。回退验证：撤探针 → 该例转红）。`test/studio/api/` files 档（写后 /state 失效） |
| P1-16 | `maskSelfCheckData` 全表扫降为 debug 开关（`CLWRITING_EVENTS_SELF_CHECK=1` 启用，缺省跳过；不建索引的理由——开库期 schema 变更风险不抵诊断面收益——注释如实登记）；`store-migrate.ts` 头注释重复块删（嵌套 `/**` 残形） | `test/events/` 域内档（开关缺省跳过 / 开启返回全量两态） |
| P1-17 | 书库 layout 迁移收编排表单源：`install/layout-migrations.ts` 的 `LAYOUT_MIGRATIONS` 数组序 = 执行序（表序即依赖声明），原启动段逐行硬编码删除；不引入 layout_version 锚（幂等步判定成本低，理由入注释） | `test/install/migrate-foreshadow-before-finalize.test.ts`（表序契约 + 逐步执行断言） |
| P1-18 | 机检缓存代次改**规则表哈希自动生成**（`check/checker-generation.ts`：各检查器模块导出常量/规则表机械哈希；手写字面量 `'a1-v2'` 删除——检查器演进必改代次，漏 bump 面消灭） | `test/check/tree-issues-cache.test.ts`（代次随规则表变、同表稳定） |
| P1-19 | 覆盖率阈值**数值**全表快照入 governance：31 桶 × 4 指标逐值锁定，vitest.config.ts 文本逐值互锁（静默下调/漏改快照即红）；配置内两处数值漂移同批修正 | `test/governance/coverage-threshold-globs.test.ts`（全表快照比对 + 缺项/多项分支） |
| P1-20 | test/ 异步卫生：`no-misused-promises` 的 `checksVoidReturn: { arguments: false }` 精确化降噪后清表——抑制表该规则 86 → 10 条（余量在 src 面真实违规） | `npm run lint` exit 0（抑制表 prune 后 diff 空校验由 CI 门保障） |

### 7.3 P2（18/18 处置：15 实修 / 3 登记）

| # | 处置 | 回归锚 / 登记理由 |
|---|---|---|
| P2-1 | `stores/prefs.ts` 1015 → 271 行拆三件：默认值锚与 33 键表 → `shared/prefs-rows.ts`（504 行）、持久化单飞与 409 恢复 → `shared/prefs-persist.ts`（417 行）；store 只留编排面 | `test/studio/webnext/` 既有档全绿（行为等价）；`test/governance/webnext-store-import-cycles.test.ts`（无环） |
| P2-2 | `ChatMessages.vue` 735 → 408 行拆三件：单条消息 → `ChatMessageItem.vue`（201）、工具卡与参数摘要 → `ChatToolCard.vue`（197，`computed` 按卡算一次，v-if 与插值不再各调一遍）；`toolSummary` 双调面消灭 | `test/studio/webnext/dom/` 既有档全绿（DOM 结构断言） |
| P2-3 | 切书样板收 `useBookScoped(name, {load, reset})` 单源，11 处消费点改调 | `test/studio/webnext/` 域内档（切书重载 + 卸载守卫断言） |
| P2-4 | 章节树「再显示 N 项」增量窗口（提示行按钮按 RENDER_CAP 步进放大；保 active 贴尾滑窗语义） | `test/studio/webnext/dom/chapter-tree-render-cap.test.ts`（窗口步进 + active 可见性 + omittedCount 恒等式） |
| P2-5 | 对话历史/分支拉取失败补合并 toast（`PULL_FAIL_MSG` 经 ui.toast 同文案合并；不再留白无解释） | `test/studio/webnext/` 域内档（失败态提示断言） |
| P2-6 | `style-harvest` 同步/异步孪生收共用内核（源1/源2 解析纯函数单源化；同步版零生产调用面保留为薄壳） | `test/process/style-harvest-*.test.ts`（两形态结果逐字段等价） |
| P2-7 | 低精度 mtime 卷降级不缓存收口（`fs/mtime-precision.ts` 单源 `isCoarseMtimeNs`；document/manifest 与 install/books-store 两消费方 get/set 两侧同绕） | 该两域既有档 + 探针档扩例（低精度注入 → 不缓存陈旧） |
| P2-8 | `isUtf8` 第 4 份删（source-map/export 收敛）；`sha256`/stat 指纹形态单源（`fs/hash.ts`、`fs/mtime-precision.ts` 邻域） | `test/fs/` 与 `test/document/` 域内档（单源对账 + 行为等价） |
| P2-9 | 探测指纹双份（`fieldsChanged` vs `probeFingerprint`）合并为 `capsFingerprint` 单源 | `test/studio/server/providers-*` 域内档（两调用面同判据） |
| P2-10 | 导出并发闸由模块级全局状态改**随组装根实例化**（`createExportSlotGate`；对齐 TaskGate 模式——同进程多 server 实例不再互相影响） | `test/studio/api/io-*` 域内档（两实例隔离断言） |
| P2-11 | **登记**：overview/tree/foreshadows 补 cursor 分页未做——三端点当前响应量级为「书内文档数」而非事件级（实测千章量级仍在毫秒级），报告自身修法口径即「量级增长前补」；补分页要动前端消费面三处 + 契约面，与本批「低风险去重」定位不符 | 登记：量级触发时按端点补 cursor（audit 与 chat-history 已有先例可循） |
| P2-12 | 诊断包超 4GiB 不再整包失败：`buildZipStoreVolumes` 按条目边界分卷（每卷独立可解压），单条自超限截断列入 `droppedNames` 提示（zip64 未实现属登记边界，以分卷规避其触发面） | `test/diagnostics/` 域内档扩例（窄限注入 → 分卷/截断路径逐条验） |
| P2-13 | 两热点档抑制清零：`EditorView.vue` 31 条 → 0（类型补强 + 拆解）、`WbAdvanced.vue` 30 条 → 0；全表 prune 509 → 348 条 / 143 档 | `npm run lint` exit 0；CI 抑制表 prune 后 diff 空门 |
| P2-14 | `useShelf` 模块级监听改惰性绑定 + 导出 `disposeGlowListeners`（幂等）；`useRelationGraph` 719 → 616 行拆出交互 hook（`useRelationInteraction.ts` 178 行） | `test/studio/webnext/` 域内档（dispose 幂等 + 交互行为等价） |
| P2-15 | test/ 批号**上锚门**落成：`check-counts.mjs` 新增 `TEST_BATCH_ANCHOR`（注释 10054 / 用例标题 4160，落门实测值冻结；超锚即红，锚下不追；手动下调 = 声明存量已清、只许收紧） | `test/scripts/check-counts.test.ts`（超锚转红 + 锚下放行）；`npm run check:counts` exit 0 |
| P2-16 | SFC 显影桶回收条件机器化：views/pages 0/0 桶改**双向对账**——被单测真 import 的视图自动划出→落非零门（现 78/59），点名无单测面的僵尸项即红 | `test/governance/coverage-threshold-globs.test.ts`（两向用例） |
| P2-17 | `check-counts` 零断言门从文件粒度下沉**用例粒度**（逐用例至少 1 断言或显式 `零断言豁免：理由` 标记）；治理大档随批拆解 | `test/scripts/check-counts.test.ts`；`npm run check:counts` exit 0 |
| P2-18 | `format/manifest.ts`（单章章纲）与 `document/manifest.ts`（项目清单）头注**互指**「同名不同物」，新人误判面消灭（改名不动——两域 import 面广，改名收益不抵迁移面） | 注释变更，两域既有档全绿 |

### 7.4 复检发现的追加项（本批自查 + e2e 抓出）

| 项 | 事实与处置 |
|---|---|
| 注释面残留清扫 | 清债标签 80 处（P1-x/P2-x 标签与日期戳入注释，`check:comments` 报红）→ 逐处删除标签保留语义，门恢复 0 命中。清扫中另发现**历史遗留**「分隔线直贴冒号」残形 71 处（`// ──：段名…`，分隔线后段名被早前清理器切走）——全库父版 AB 对照（引入前修订 0 命中）确证为真伤后清为 `// ── 段名…`；同期把该形态补入 `check-comments.mjs` 的残形判据表（新增一族「分隔线直贴冒号」，判据表七族→八族）+ 钉子用例（含零误报面），**机器门自此覆盖该类**（历史两批同族残形均因判据缺族而漏过；该族首版前缀集漏 `/*` 块注形之补正见 7.6） |
| 用量卡陈旧缓存（e2e 抓出） | 本批 P1-15 给 trace-stats/cost-stats 挂 5s 纯 TTL 缓存后，e2e「用量卡表格态」转红：空态用例先缓存零事件空壳，种入事件后第二次读在 TTL 窗内命中旧壳（新任务跑完仍显示「暂无 AI 调用记录」）。修复：新增 `stats-signature.ts` 数据源指纹探针——`主库 + -wal 侧车 + rule-hits 文件`三 stat（服务进程形态下实测「读不扰动指纹、每次 append 改 -wal 指纹」，故写后即刻失效、读到 checkpoint 也不假命中）；缓存键改复合键 `bookRoot\0userDataPath`（同进程多 server 实例互不串味）；`sessionDbPath` / `ruleHitsPath` 路径派生单源随沉。回归锚：`api-endpoints.test.ts` 三例（写源不变命中 / 写源变化 TTL 窗内重算 / 回退即红） |
| 形状锁（全量测试抓出） | 上述新模块初置 server 面外，触 `ai-studio-direction` 形状锁转红（studio→ai 直连须逐文件登记）。修复：模块移入 api 层（`api/stats-signature.ts`，同 `provider-save-guard.ts` 非路由模块先例）+ 登记表 `API_LAYER_REGISTERED` 补条目含理由。**门起效实录**：本批新增直连面被合成门机器拦下，正是该门设计意图 |

### 7.5 全门实录（mac 本机，收口终态）

```
npm run typecheck（tsc --noEmit）                      exit 0
npm run typecheck:web-next（vue-tsc --noEmit）          exit 0
npm run lint（eslint . --max-warnings 0）              exit 0（抑制表 prune：509 → 348 条）
npx vitest run                                         1305 档全绿 / 9158 通过 + 8 跳过，exit 0
npm run test:e2e                                       52 passed / 4 skipped，exit 0
check:counts / check:docs / check:comments / check:packaging / check:knowledge   全 exit 0
```

计数同步：README 单测数 8676 → **8685**（三处）；档数 1304 → **1305**（新增 startup-budget 档）；CLAUDE.md 全量档数同步。测试面：新档 1（startup-budget 5 例）+ 53 档扩例/改动（全部按「一条改动一条回归锚」落）。

### 7.6 登记未做（2 条 + 自查补收 1 条 + 效力边界）

1. **P2-11 大响应分页**：见 7.3——量级触发时补（报告口径原即「量级增长前」）。
2. **P2-12 的 zip64**：以分卷规避（见 7.3），zip64 本体未实现——真需单包 >4GiB 时再评估。
3. **注释门残形判据前缀集（已补收）**：收口批后自查发现「分隔线直贴冒号」族首版前缀集（`//`/`*`/`<!--`）不含 `/*`——`.vue` 样式块内 `/* ──：段名… */` 形据此漏判（受损批 3 处；该 3 处实例本身已在本批清理时修好，缺的是「未来同类形态门能抓」）。补收：前缀集补 `/*`（受损版实测全数拦下）+ 标定注释订正（首版「不在本门扫面内」为误述——实测样式块在扫面内，漏的是前缀集）+ 钉子与零误报用例各补。
4. **效力边界**：coverage 全量、electron 出包、soak、win 腿 CI 未跑（同 §6.3；单测/e2e 面全绿，跨 OS 需 CI 复核）。

