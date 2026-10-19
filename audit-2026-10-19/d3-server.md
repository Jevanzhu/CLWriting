# 域3 全量代码审计报告：HTTP 服务端 / 检查引擎 / 事件与状态 / 进程与驱动

- 审计对象：`src/studio/server/`、`src/check/`、`src/events/`、`src/state/`、`src/process/`、`src/driver/`、`src/log/`（工具调用 40 次内测读 ≈6.5k 行精读 + 定向 grep/glob）
- 对照测试：`test/studio`(511)、`test/check`(54)、`test/events`(31)、`test/state`(25)、`test/process`(54)、`test/driver`(10)、`test/log`(7)
- 证据面：源码 / 测试 / `git log`（本域 450 commits）；未读 docs/、知识层/、.agents/notes/、README.md 结论
- 纪律：未改任何源码；未跑全量测试/coverage；未起真实服务端

## 结论摘要（先说数字）

| 严重度 | 条目数 | 说明 |
| --- | --- | --- |
| P0 | 0 | 未发现可越鉴权、可静默损坏数据、可进程崩溃的缺陷 |
| P1 | 0 | 未发现功能性中断或无界崩溃面 |
| P2 | 3 | 体积无界（无阈值告警）、锁续期静默停表、服务进程同步锁等待漏网点 |
| P3 | 7 | 一致性/可观测/注释卫生类 |

**本域不是「待修状态」**：`git log` 显示本域已过 ≥5 轮全项目评审收口（`42523faa`/`6ad22cea`/`f07fb0e4`/`fdaa5599`/`476de996`「评审」批），入口闸/锁原语/事件迁移/缓存指纹等处均已按「已实测复现的竞态」逐点加固并带注释记档。因此绝大多数结论是「残留边界」而非「明显缺陷」；本报告把「已核为健壮」的面与「残留」分开写，避免虚报。

---

## A. 问题清单

| ID | 严重度 | 类型 | 证据（file:line） | 影响 | 建议 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | P2 | 无界增长/可运维性 | `src/events/store-retention.ts:63-67`（`PRUNABLE_EVENT_TYPES` 仅三族：`llm/retry`/`retry/attempt`/`check/report`，窗口 30 天）；`:180-185`（到期判据只看最旧一行）；`src/events/store.ts:840-877`（全库 DELETE 出口只有 `clearBook`/`clearBooks`） | 除三族观测明细外，事件库其余族（`user/assistant message`、`turn/*`、`step/*`、`tool/call`、`llm/call`、`goal/change`…）**无任何时间/行数/体积上限**，只能靠用户「清空对话 / 清除事件史 / 删书」回收；长期写作单库行数单调增长，而全量读路径（`listEvents`）与审计/成本端点解析成本随之线性上升。无体积阈值、无超阈告警 | 加「库体积/行数阈值 → 启动通告（`startup-notices`）或健康项」的只读观测；若要保留产品数据，至少给 `llm/call`、`turn/*`、`step/*` 提供可配置保留窗（默认关，不改现状语义） | 高（事实层面）；中（体积到量级的时间预估未实测） |
| A2 | P2 | 竞态/静默失败 | `src/fs/cross-process-lock.ts:206-215`（续期 `setInterval` 内 `utimesSync` 抛错即 `clearInterval`，**无重试、无 `log.warn`**）；`:73`（`MAX_HELD_MS = 10min`）；`:128-136`（活 pid + mtime 超龄 → 判 stale 接管）；`src/studio/server/api/task-gate.ts:106-109`、`:176-184`（闸显式依赖 30s 续期，注释自述「不续期会被第二进程按活 pid 超龄接管成双持锁」） | 单次瞬态失败（win 杀软/索引器瞬时占用锁文件、磁盘抖动）即让长任务闸**永久失去续期**；10 分钟后他进程可接管同一 `(书, action)` 锁 → 同一书同一分钟级 AI 任务双跑（双倍 API 费 + 落盘互踩）。失败面无任何留痕，事后不可归因 | 续期失败改为「计数 + 退避重试 + 超 N 次才停表并 `log.warn`」；或停表时置一次性告警（写入事件流/健康项） | 高（代码路径确定）；中（触发概率低，需瞬态 FS 错误） |
| A3 | P2 | 事件循环阻塞/纪律漏网点 | `src/process/summary.ts:217-226`（`acquireCrossProcessLockWithTimeout` 同步 `Atomics.wait` 档）、`:587`（同族第二处）；对照纪律正本 `src/process/draft-pipeline.ts:242-244`、`src/state/health.ts:414-416`（「服务进程事件循环上的调用必须改用异步孪生」） | 摘要链在服务进程内（背景任务 owner `bg-summary:<书>`）执行；双进程争用（第二个实例 / CLI / dev-api）时该进程事件循环被同步微睡占住至等待档上限，窗内全部 HTTP 与 SSE 心跳停摆——正是本仓多轮修过的纪律漏网点形态 | 同一把锁改 `acquireCrossProcessLockAsync`（`cross-process-lock.ts:345-359` 已有孪生），或在调用点前置「非同进程」判据 | 中高（调用点确定；实际阻塞时长取决于未核的等待档常量） |
| A4 | P3 | 信息回显 | `src/studio/server/http.ts:300-303`（`请求体不是合法 JSON：${e.message}`）；Node 的 `JSON.parse` 报错文本会带请求体片段 | 400 错误信封内嵌请求体前若干字符；对本地 API 威胁有限（回显给同一调用方），但违背「错误出口不泄漏内容」的同文件口径（同文件 `:88-91` 明确对 `extra` 逐串脱敏） | 400 文案只给固定人话 + 偏移量，不回显解析器原文 | 中（Node 各版本片段长度不同） |
| A5 | P3 | 敏感面脱敏不一致 | `src/log/index.ts:304-321`（落盘行只过 `maskKeys`，`err.stack` 全文入 JSONL）；`:73-78`（stack 原样序列化）；对照 `src/studio/server/http.ts:79-91`（错误信封专门做凭据 + 路径双层脱敏） | `app-YYYYMMDD.jsonl` 含书库/用户目录绝对路径与完整调用栈；留 7 天。诊断包导出时另行脱敏（`diagnostics` 端点），故风险限于本机文件 | 落盘行同样过 `createPathScrubber`（`src/log/path-scrub.ts` 已存在，仅接一处） | 高 |
| A6 | P3 | 文案/档位漂移 | `src/process/draft-pipeline.ts:78-81`（超时档可注入）、`:246-247`（文案硬编码「5 秒未让出」） | 测试或将来调整档位时，错误文案与实际等待时长不符，误导排障 | 文案用 `getDraftSaveLockTimeoutMs()` 插值 | 高 |
| A7 | P3 | 内存卫生口径不一致 | `src/state/health.ts:62-85`（`sweepLastAt`/`cloudScanCache`/`finalizedLostCache` 三个书键 Map 无容量上限，注释自述「书数量级小无上限忧虑」）；对照 `src/events/store-retention.ts:92`、`:132-138`（同类表一律 `TABLE_MAX=256` FIFO） | 长期多书库/换库场景条目只增不减；量级小（每书一条），无正确性影响 | 与 `store-retention` 同口径加 `TABLE_MAX` FIFO，或按 `cache-registry` 挂点清理（已有 `forgetStateSweepStamp`，仅缺上限） | 高 |
| A8 | P3 | 资源上限只到单书维度 | `src/studio/server/api/stream-sse-writer.ts:39`（`MAX_SSE_PER_BOOK = 5`）、`:65-69`（连接数快照仅测试钩子）；`src/studio/server/api/stream-sse-connect.ts:79-84`、`:265-269` 两处同判 | 只有「每书 5 条」上限，无进程级总上限与运行时可观测面；多书库多窗口场景总连接数 = 5 × 书数，FD 上限依赖 OS 兜底 | 加进程级总名额常量（同款 429 单源回包）与一个只读观测出口（复用 `__getSseConnections` 口径） | 中 |
| A9 | P3 | 注释卫生（简洁度） | `src/studio/server/api/task-gate.ts:64-67`（「dd- 自查修正」「专项二轮顺修」）；`src/studio/server/http.ts:42`（「-7（全库代码审）」）；`src/events/store.ts:1-15`（评审批次叙事）；`src/studio/server/index.ts:613-617` 等（「收尾」「清偿批」） | 大量注释承载**修复史与评审批次号**，与本仓 `AGENTS.md`「注释只写作用/约束/不变量/平台差/同步关系；不写来历与出处，修复史归 git」的纪律相冲突；域内多档注释占比 40–60%（`task-gate.ts` 767 行中约六成是沿革叙事），同一事实在多处复述，长期维护成本高 | 按正本纪律做一次域内注释减重（沿革只留「为什么这样写」的一条不变量，批次号/修复史删除），本轮审计不改 | 高 |
| A10 | P3 | 信任边界（设计声明，非缺陷） | `src/studio/server/index.ts:290-305`（`/api/boot` 豁免 token，注释自述「token 本身由它下发」）；`src/studio/server/api/books.ts:233`（`/api/boot` 路由）；`src/studio/server/api/stream-sse-connect.ts:47-51`（自述「本机进程=同信任域，此处不承诺防本机进程」） | 任意本机进程可 `GET /api/boot` 取 token，进而读写全部书稿/配置/对话史；远端网页侧由 Host 精确匹配（`index.ts:644-659`）+ Origin/CORS（`:613-689`）阻断，实测无旁路 | 维持现状即可；若将来需要真正的本机隔离，须改为「token 由 Electron 主进程经 IPC 注入页面、boot 端点不出 token」（改动面大，需单独立项） | 高 |

### 已逐点核验为健壮（不列问题，供交叉验证）

- **鉴权闸序**：`index.ts:621-781` 六道闸（bad request / Host / OPTIONS / 写 Origin / 写 token / GET·HEAD token）顺序正确，且 GET token 闸用**规范化后** `apiPathname`（`:712-733`），`/foo/../api/books`、`%2e%2e` 编码点段均被拦（测试：`test/studio/server/token-gate-normalized-path.test.ts`）。
- **Host / DNS rebinding**：`:644-659` 精确匹配 `127.0.0.1:port`/`localhost:port`/`[::1]:port`，`listeningPort===0` 时 fail-closed；**有实守护**：`test/studio/server/auth-gate-reject-body-drain.test.ts:139-145`（`host: 'evil.example:1'` → 403）。
- **CORS/CSRF**：`:660-695` 非白名单 Origin 不设 ACAO（GET 可发不可读）+ 写方法 Origin 403 + 写 token 二次闸；白名单仅实际监听 origin（`:798-807`），dev 5173 需 `CLW_DEV_UI/CLW_DEV_CORS` 显式开启（`:584-589`）。测试：`test/studio/server/api-cors.test.ts`（含 OPTIONS 预检含 PATCH/HEAD）。
- **token 比较**：`http.ts:185-190` 双侧 SHA-256 后 `timingSafeEqual`，长度信道消除（测试：`safe-token-compare-digest.test.ts`）。
- **豁免表**：`index.ts:305` 显式路径表（禁后缀匹配），SSE 路径模式与 `stream.ts` 单源；测试：`test/governance/studio-token-exempt-sync.test.ts`（双向集合相等门）。
- **SSE 凭据**：`stream-sse-connect.ts:72-102` 两凭据预检（ticket peek / 头 token）+ 全部书域校验通过后才消费票（429/404 不烧票），`?token=` 通道两端同删；HEAD 探测不占名额（`:242-277`，测试 `sse-probe-no-slot.test.ts`）。
- **错误信封统一**：`http.ts:152-171` 单出口 + `ERROR_CODES` 清单；全 `src/studio/server` grep `reply(res, 4xx/5xx)` **零命中**（错误响应无手写旁路）。
- **关停链**：`index.ts:401-411`（断全部 SSE → abort 在途导出 → close → 有界 2s 等在途 worker）；残留 SSE 与导出句柄按实例记账（`stream-sse-writer.ts:38-62`、`index.ts:554-558`）。
- **并发闸**：`task-gate.ts:166-216` 进程内 Set 快路径 + 跨进程 `O_EXCL` 锁（占位无 TOCTOU）+ stale 接管改**原子改名认领**（`cross-process-lock.ts:272-303`）+ 释放前 payload 校验（`:216-232`），释放顺序与幂等闩均有注释锁定；忙闸矩阵单源 `BUSY_MATRIX`（`:520-559`）。测试：`test/studio/api/task-gate.test.ts`、`cross-process-busy-gate.test.ts`、`orchestrator-mutex-gates.test.ts`。
- **事件库**：每书一库 + WAL + 引用计数单例（`store.ts:393-490`）、开库全程持迁移锁、跨进程开口标记（`sweepOpenMarkers`）阻断「他进程持旧库 → checkpoint 静默失败」；迁移三步墓碑前置 + 逆序回滚 + 回滚失败保碑（`:1074-1155`）；孤儿会话补 end 有 32 分钟宽限 + `BEGIN IMMEDIATE` 事务内复核（`:291-335`）；关闭路径在线自检（`store-selfcheck.ts:101-160`，尾窗 512 行、区间上限 8）。
- **缓存指纹**：`tree-issues-cache.ts:154-220` 全局纪元含 14 类章外输入（含 `设定/名册.md`、账本推进归档、清单），章级行按 `(rel_path, mtimeµs, size, verdict_fp, epoch_fp)` 判定，行级纪元戳 + 读侧强制比对；机检器代次由规则表哈希生成（`:34`），无手工 bump 漏改面；`tree_issues_cache.rel_path` 为 PRIMARY KEY（`src/cache/schema.ts:23-24`）→ 无按章行膨胀。
- **定时器/句柄**：`src/studio/server` 全部 `setTimeout/setInterval` 均有对应 `clearTimeout/clearInterval`（grep 14 处清除点；http.ts 两处宽限定时器 `unref` + close 即清）。
- **日志**：`log/index.ts:351-435` 待写队列 `MAX_PENDING_WRITES=1024` 丢最旧 + 周期告警、泵内逐行盯目录、fail-open；7 天清理启动 + 跨日节流（`:133-176`）。
- **检查引擎聚合**：`check/runner.ts:127-395` 单入口聚合 11+ 项，`effectiveShort` 单源短篇判定，缺章节纲/读取失败不静默（黄项透出）；同步/async 双驱动生成器（`run-tree-issues.ts:149-191`），每 25 章让出，重活（rebuild/开库）走 worker 效应档（`:98-118`）。
- **重试上限**：`process/retry.ts:30-58` 三态（pass/retry≤3/escalate），无重试风暴面。

---

## B. 实现完成度（按模块 + 证据）

| 模块 | 完成度 | 关键证据 |
| --- | --- | --- |
| HTTP 服务端入口（`index.ts` 827 行） | 高 | 组装根依赖显式注入（`:96-106`、`:347-351`）、启动链「迁移先于服务可用」（`:576`、`:636`）、六道闸、keep-alive/requestTimeout 显式钉值（`:786-791`）、非回环 host fail-fast（`:606-610`）、关停链（`:401-411`、`:822-825`） |
| 路由与错误信封（`http.ts`/`router.ts`/`schema.ts`） | 高 | `replyError` 单出口 + 路径/凭据双脱敏（`:82-91`、`:152-171`）；`ERROR_CODES` 双向对账门（`:104-150`，测试 `error-envelope.test.ts`）；`readJson` 分块 Buffer 拼接 + 闲置超时 408 + 413 排空宽限（`:218-342`） |
| 静态托管（`static.ts` 262 行） | 高 | 路径穿越双防线（normalize 前缀 + `resolveWithinRoot` 双侧 realpath，`:130-150`、`:234-238`）、SPA fallback 同过判界、win 设备名拦截（`:116-128`）、流式 + `close` 即 destroy（`:187-213`）、安全头三处单源（`:51-55`） |
| 并发闸/任务门（`task-gate.ts` 834 行） | 高 | 见「已核健壮」；矩阵 6 信号 × 12 意图单源、跨进程枚举锁名反解（`:304-324`）、长任务门控包装统一 10 段样板（`:705-743`）、失败码映射单源（`:754-758`） |
| SSE（`stream.ts`/`-sse-connect`/`-writer`/`-ticket`/`watchdog`/`run-writer`） | 高 | 票一次性 60s + 在库上限 256 逐出（`stream-ticket.ts:18-23`、`:57-88`）；建流前 429/404 不烧票；断连清理含生成器 `cancelStream` 唤醒（`stream-sse-connect.ts:114-138`）；背压双判死（字节 1MB + 连续 240 次，`stream-sse-writer.ts:101-126`） |
| 事件库（`events/store.ts` 1160 行 + 5 族） | 高 | 见「已核健壮」；保留策略 + 空间回收（`store-retention.ts:219-348`，有界窗口 512×4、增量 vacuum 让出、迁移锁互斥） |
| 状态/健康（`state/health.ts` 876 行） | 高 | 七类健康项；move/save 两类 pending 分诊（确定性收口 vs 保守报红，`:418-486`、`:658-696`）；三处 TTL 节流回「上次结果」（fail-closed 方向，`:87-113`）；卫生清扫（tmp/孤儿 journal 归档/超龄 spill，`:306-324`） |
| 检查引擎（`check/` 24 档） | 高 | 全量清单 24 档已核；聚合/缓存/降级旗标如上；规则词表三级供给与阈值夹紧留痕（`runner.ts:226-249`） |
| 写章流水线（`process/draft-pipeline.ts` 727 行） | 高 | `saveDraft` 全程对齐 `executeSave` 纪律：per-doc 跨进程锁 → 锁内复核（双向占用检查，`:254-271`）→ 单读派生 → journal pending → 原子写 fsync → settled → manifest 登记 → 树失效 → 字数日记（`:245-361`）；非 UTF-8 覆写 fail-closed 类型化错误（`:62-71`） |
| 驱动（`driver/` 5 档） | 高 | provider 直连无子进程（`cc.ts:1-12`）；广播总线 + 三重 cap（pre 200 / execRing 200 分腿 / consumer 200 + 丢事件 notice，`:45-54`、`:183-207`）；取消语义明确（`:278-281`、`:320-347`） |
| 日志（`log/` 3 档） | 高 | 见「已核健壮」；双词表对账测试 `test/log/mask-redact-reconciliation.test.ts` |
| 兜底与关闭（`in-flight-work`/`graceful-shutdown`/`uv` 层） | 中高 | 有界等待 + 取消登记（`index.ts:397-411`）；未逐档精读 |

**测试守护真实性（④交叉验证）**：抽读的断言均锚**外部可观察面**（原始 HTTP 状态码/响应头/同 socket 二次往返/连接计数快照），未发现「只断言内部函数被调用」的空壳守护。代表：`api-cors.test.ts:57-139`（raw socket 断言 status/ACAO/allow-methods）、`auth-gate-reject-body-drain.test.ts:163-179`（五处闸各自 403/204 + `appFinishHooks ≥ 1` + 同 socket 第二请求 200）、`studio-token-exempt-sync.test.ts:102-107`（豁免表双向集合相等）。缺口：A2 的续期停表分支、A1 的体积阈值面**无守护测试**（后者因功能不存在）。

---

## C. 简洁与优雅度

**优点**：单点化做得很彻底——错误信封、错误码清单、忙闸矩阵、信号文案、锁原语、SQL prepared 缓存（三域同构）、书键缓存登记表、`testableConst` 注入工厂、生成器「核 + 双驱动」（同步/异步零漂移）等，都在域内收敛到了唯一落点；`src/studio/server/index.ts` 的 `RouteDeps`/`RouteOverrides` 把「测试缝渗入生产」收成组装根显式注入面，是同类 Electron 内嵌服务里少见的干净做法。

**主要不优雅点**：

1. **注释过载且违正本纪律**（A9）：域内多档注释占 40–60%，且相当比例是修复史/评审批次/被否决方案叙事（`task-gate.ts:64`、`http.ts:42`、`index.ts:613-617`、`store.ts:1-15`）。`AGENTS.md` 已明文要求「注释只写作用与约束、不写来历与出处，修复史归 git」，二者冲突。可读性上第三者也确实有害：真正的不变量（如「闸消费点仅下方一处」）被埋在沿革里。
2. **超长单文件**：`index.ts`(827)、`task-gate.ts`(834)、`store.ts`(1160)、`health.ts`(876) 均属「多职责 + 巨量注释」；虽已做过分波拆分（`stream.ts`→`-sse-connect`/`-writer`/`-watchdog`，见 `stream-sse-writer.ts:1-26`），但残核仍偏大。
3. **同族常量散点**：`MAX_SSE_PER_BOOK`(5) / `SSE_BACKPRESSURE_LIMIT`(跨包契约单源 ✓) / `MAX_CONSUMER_QUEUE`(200) / `MAX_EXEC_RING`(200) / `MAX_PRE_KEYS` 形近值分居三四档，语义相近却各自为政；`TABLE_MAX=256` 与 health 三表「无上限」口径不一（A7）。
4. **两处平行实现的分诊规则靠注释承载**：`run-single-doc` 与 `run-tree-issues` 的「章作用域 vs 全书性」条目切分靠 `skipLeadsBookChecks` 布尔 + 注释（`check/runner.ts:87-93`），回归边界不易一眼看出（本域无对应断言面）。
5. 少量「文案硬编码 vs 可注入档位」（A6）属典型小漂移。

---

## D. 无法判断项及原因

1. **未深读面**（预算 40 次工具调用，已用于精读 15 档）：`src/studio/server/api/` 下 77 档逐端点的鉴权顺序与输入校验只做了抽样（读 `task-gate`/`stream*`/`http`/`static`/`books` 头部），`process/summary.ts`（701）、`prepare.ts`、`skills.ts`、`check/run-single-doc.ts`（671）、`check/leads.ts`（476）、`events/projection.ts`、`chat-bridge.ts`、`chain-bridge.ts` 未通读——这些面的结论**不可引用本报告**。
2. **未执行任何测试**：纪律禁止全量/并发 vitest；`npx vitest run <单档>` 亦未使用（无「必须复现」的判据）。因此所有「有测试守护」的判断均为**静态核验**（存在测试文件 + 抽读断言面），不代表实测绿。
3. **性能与量级全为推断**：A1 的「多久到多大」、A3 的实际阻塞时长（`getSummaryGenerateLockTimeoutMs` 未读取）、A8 的 FD 上限均无实测数据（不得起服务端、不得跑 scale 用例）。
4. **域外面未核**：`src/desktop/` 侧 token 的持久化与 IPC 注入（`studioToken` 跨崩溃重启稳定，见 `index.ts:324-327` 注释）不在本域；token 持久化文件的 ACL/权限面未知；`web-next` 前端的凭据处理（`client.ts:88`/`:150`）仅按被引注释推断。
5. **A2 的触发概率**（win 杀软/索引器瞬时占用 `utimes` 的频度）无法在本机评估，只有上游注释（`cross-process-lock.ts:76-88`）声称该形态在真实环境出现过。
6. **`git log` 只抽近 300 条**（本域共 450 commits）：更早历史中的修复热点（如事件库迁移早期形态）未追，故「反复修复热点」结论仅覆盖近期批次。
