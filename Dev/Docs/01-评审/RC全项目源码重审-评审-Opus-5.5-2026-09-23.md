# RC 全项目源码重审评审报告

- 执行模型：Opus-5.5（claude-opus-5-5；2 路子代理分区只读审查 + 主控机器门实测与关键锚点复核）
- 基线：`f2cd4aed`（mac 分支，工作树净）
- 口径：**忽略现有文档**——不读 Dev/、README、CLAUDE.md、AGENTS.md 及历轮评审，结论只以源码为依据；test/ 仅用于判断覆盖。
- 范围：`src/` 全域（约 12.3 万行）+ `scripts/` + `electron-builder.yml` + `tsup.config.ts`。
  - A 区（核心后端，约 6.7 万行）：desktop / ai / document / format / check / process / events / install / rag / fs / state / metrics / cache / review / driver / export / git / knowledge / learn / log / update / shared。
  - B 区（studio，约 5.5 万行）：`studio/server`（本地 HTTP API）+ `studio/web-next`（Vue 3 + Pinia + CodeMirror 6）。
- 深度：desktop、ai、fs、document、events、git、install、update、studio/server 全部与 web-next 核心链（api/stores/editor/Book.vue/useSse）精读；check / metrics / review / driver / export / knowledge / log / format / process / cache 及 prefs store 为抽查，未见问题不等于无问题。

## 〇、机器门实测（2026-09-23，本地）

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc） | 通过 |
| `npm run typecheck:web-next`（vue-tsc） | 通过 |
| `npm run lint`（eslint --max-warnings 0） | 通过 |
| vitest 全量 | 1288 文件全绿；7908 passed / 8 skipped；138s |

e2e 与四 check 未在本轮跑。

## 一、总评

**P1 为 0。代码库经多轮加固，单点缺陷基本收口，剩余风险集中在「跨模块时序」「安全纵深」「前后端规模假设不一致」三类。**

- 安全基线扎实：窗口安全五件套收敛在 `createSecureWindow` 且调用方不可覆盖；IPC 校验可信 sender；server 仅回环监听，Host 精确匹配防 DNS 重绑定，写请求 Origin + token 双闸，GET `/api/*` 亦需 token；子进程统一参数数组不走 shell；前端零 `v-html`、零 `any`。
- 数据层成熟：原子写（同目录 tmp → fsync → rename → 目录 fsync + Windows 退避）、路径防穿越（双侧 realpath + 逐段拒软链）、保存链「journal 挂账 → 快照 → 原子写 → 结算」与锁前/锁内双复核、乐观锁 + 幂等键。
- 主要短板：关机链 flush 与停机并发（A-1）、git 配置执行面未封（A-2）、保存端点 1MB 上限与「200 万字」规模定位冲突（B-1）；维护面上，评审沿革注释大量挤占代码（B-6）。

## 二、摘要

| 编号 | 级别 | 标题 | 区 |
|---|---|---|---|
| A-1 | P2 | 关机/注销时渲染层最后一次 flush 与停机并发，大概率被拒 | desktop |
| A-2 | P2 | git 调用未禁 core.fsmonitor/hooks，恶意书目录可执行任意命令 | git/install |
| B-1 | P2 | 单文档超约 34 万字可打开可编辑但永远存不上（413） | studio |
| A-3 | P3 | 钥匙串通道搁置，API Key 本地加密实为混淆 | ai/desktop |
| A-4 | P3 | 陈锁接管在长临界段下可致双方同时持锁 | fs/learn |
| A-5 | P3 | 快照写失败阻断整次正文保存（待确认是否有意） | document |
| A-6 | P3 | journal 拿锁超时降级无锁追加，可能与 compact 冲突丢行 | document |
| A-7 | P3 | providers 备份恢复先删主文件，与日志文案相反且不在写锁内 | ai |
| A-8 | P3 | 流式卡顿计时器在非超时异常分支未清理 | ai |
| A-9 | P3 | 超时提示可能显示小数分钟 | ai |
| B-2 | P3 | 每次按键对全文多遍 O(n) 拷贝与比较 | web-next |
| B-3 | P3 | SSE 忙碌探测会建立真实流连接、占名额（待确认） | web-next |
| B-4 | P3 | 编辑供应商改 baseUrl 时静默沿用原 API Key | server |
| B-5 | P3 | Book.vue 与 chat store 职责过多 | web-next |
| B-6 | P3 | 评审沿革注释严重挤占代码 | 全库 |

## 三、P2（3 条）

### A-1 关机/注销时，渲染层最后一次 flush 与停机并发，大概率被拒

- 位置：`src/desktop/lifecycle.ts:302-342`；`src/desktop/graceful-shutdown.ts:48-66,118-121`
- 描述：`session-end` 处理器以 `void (async () => …)()` 发起渲染层 flush（预算 2s），同一轮同步代码随即 `void serverManager.shutdown()`（:342）。子进程收到停机指令后执行 `shutdownStudio`：逐书 abort 后立即 `server.close()` + `closeIdleConnections()`。而渲染层要经 `executeJavaScript` → 前端 flush 钩子 → `fetch PUT`，几乎必然晚于 IPC 停机指令到达，此时新连接被拒、空闲 keep-alive 已摘除。失败只记一条 info 日志（「未落定」）。
- 触发：Windows 关机/注销，距上次自动保存（默认 30s 节拍）之间的键入静默丢失——代码注释自己把此场景定为「编辑永不静默丢失」红线，而并行实现达不到该目标。
- 复核：主控已读 `lifecycle.ts:302-342`，确认 flush 与 shutdown 并行下发、互不等待。实际丢失概率需在 Windows 实机验证。
- 建议：`await flushRendererWithBudget(…, 2s)` 后再下发 shutdown（2s + 3.5s 仍在 OS 收尾窗口量级内）；或让 `shutdownStudio` 先 drain 在途保存再 close。补测试：flush 在途时 server 不得已关闭。

### A-2 git 调用未禁 core.fsmonitor / hooks，打开恶意书目录即可执行任意命令

- 位置：`src/git/exec.ts:90-91`（`git()` 统一入口）、`:304-310`（`statusPorcelain` 仅加 `-c core.quotepath=false`）；调用点 `src/install/migrate-finalized-revision.ts:63`；启动入口 `src/studio/server/index.ts:284`
- 描述：`git status` 会读取书目录 `.git/config`，若含 `core.fsmonitor = <命令>` 即执行该命令。git 的 `safe.directory` 只拦属主不一致，用户自己下载/解压的目录属主就是本人，拦不住。server 启动时对每本书跑 `migrateFinalizedRevisions`，清单无定稿基线（恶意构造的书天然满足）即走到 `git status`。
- 触发：作者把他人共享的「书目录」（如小说工程仓库）放进书库 → 启动 app 即以用户权限执行任意命令。
- 复核：主控已读 `exec.ts` 与迁移调用链，确认无任何 `-c core.fsmonitor=false` / hooksPath 防护。
- 建议：`git()` 统一前置 `-c core.fsmonitor=false -c core.hooksPath=<空目录> -c core.untrackedCache=false`，并考虑 `GIT_CONFIG_NOSYSTEM=1`；git 可执行文件用绝对路径解析（Windows 下 cwd 劫持风险待实测）。

### B-1 单文档超约 34 万字可打开可编辑，但永远存不上

- 位置：`src/studio/server/http.ts:5`（`JSON_BODY_LIMIT_BYTES = 1MB`）、`:128,170`；`src/studio/server/api/documents-save.ts:91,229`、`api/files.ts:124`（均用默认上限 `readJson(req)`）；`web-next/src/stores/doc.ts:322-343`；`web-next/src/shared/dirty-mirror.ts:33-46`
- 描述：保存端点沿用 1MB 默认上限，全仓无端点覆盖；中文 UTF-8 每字 3 字节，正文超约 34 万字即 413。读取与编辑侧无上限，前端 dirty-mirror 还专为 >1M 字符文档设了节流档（注释写「200 万字文档」）——前后端规模假设不一致。413 落进 `doSave` 通用分支，只提示「请求体过大」，无拆分出路；autosave 每拍重传整文再失败；切书时只能「丢弃并切换」。
- 触发：导入整本旧稿或大设定文件（>35 万字）后编辑，或向单文档大段粘贴。
- 复核：主控已确认 `http.ts:5` 常量与 `documents-save.ts` / `files.ts` 的 `readJson` 均未传 `limitBytes`。test/ 无文档保存 413 用例。
- 建议：文档内容 PUT 与 `/file` PUT 单独放宽上限（如 16MB）；前端保存前按字节预估，超限明确提示拆分并停止 autosave 重试；413 用专用机器码（如 `PAYLOAD_TOO_LARGE`，现为 `BAD_INPUT`）。

## 四、P3（12 条）

### A 区（核心后端）

- **A-3 钥匙串通道搁置，API Key 本地加密实为混淆**——`src/desktop/os-kek.ts:82,105`、`src/ai/provider/vault-key.ts:49`。`OS_KEK_SHELVED = true` 使 v2（safeStorage）永不启用；v1 密钥材料由二进制内置分片异或得到，拿到 app 即可还原。providers 文件经同步盘/备份外泄后可离线解出全部 Key，0600 权限对此无效。代码日志自述为有意搁置，故按设计取舍降为 P3。建议：评估恢复 safeStorage（v1 仅作迁移兜底）；搁置期间在设置界面如实告知「本地仅做混淆」。
- **A-4 陈锁接管在长临界段下可致双方同时持锁**——`src/fs/cross-process-lock.ts:118-160`（:137 持锁进程存活但超 `MAX_HELD_MS`=10min 仍判 stale）。仅 task-gate 与 app-instance-guard 传 `renewIntervalMs`；接管为「判 stale → 删 → 重建」非原子，两接管方可交错。learn 收割锁（`src/learn/index.ts`）无续期，大书慢盘扫描超 10min 时可被接管（实际耗时待确认）。建议：长临界段调用方开续期或续期默认开启；接管改 rename 到唯一名再删。
- **A-5 快照写失败阻断整次正文保存（待确认是否有意）**——`src/document/service.ts:583`。`maybeSnapshot` 在正文原子写之前、同一 try 内；`.版本` 目录被同步盘锁住/只读/配额满时，所有保存 WRITE_ERROR。若「无快照不覆写」是有意红线，建议在错误文案中点明原因与出路；否则降级为警告、不阻断正文写（journal pending 已兜底旧内容）。
- **A-6 journal 拿锁超时降级无锁追加，可能与 compact 冲突丢行**——`src/document/journal.ts:281-306`。两次拿锁超时后改无锁 `appendFileSync`，撞上 compact 整文件重写时该行可能被覆盖或交错损坏（注释自认此窗口）。建议：compact 改「写新文件 + rename 前补追新增行」，或降级写侧车文件、恢复时合并。
- **A-7 providers 备份恢复先删主文件，与日志文案相反且不在写锁内**——`src/ai/provider/store.ts:201-204,314`。`tryRestoreFromBak` 先 `rmQuietly(fp)` 再原子写回；恢复失败分支日志却称「损坏文件保留」。恢复过程也不在 `serializedLockedWrite` 内，可与并发保存竞争。建议：损坏文件先 rename 为 `.corrupt-<ts>` 留证，恢复纳入同一把写锁，修正文案。
- **A-8 流式卡顿计时器在非超时异常分支未清理**——`src/ai/gen.ts:119-139,141`。`it.next()` 因非超时原因 reject 时 catch 未 `clearTimeout(timer)`，而 finally 注释称「catch 两态已清」；计时器未 unref，最多多挂 60s（reject 已被 race 吸收，不崩）。建议：catch 首行补 `clearTimeout(timer)`；`withFirstByteTimeout` 实为逐 chunk 超时，建议改名。
- **A-9 超时提示可能显示小数分钟**——`src/ai/runner.ts:648`。`${timeoutMs / 60_000} 分钟` 在非整分钟配置下出现「1.5 分钟」「0.25 分钟」。建议：不足 1 分钟显示秒，否则取整。

### B 区（studio）

- **B-2 每次按键对全文多遍 O(n) 拷贝与比较**——`web-next/src/editor/CmHost.vue:193,390`、`views/EditorView.vue:63-66,85`、`stores/doc.ts:226`。一次按键约 5 遍全文 `toString` / `splitFrontmatter` / `mergeFm` / 全等比较，全在同步输入路径。数百 KB～MB 级文档输入可感卡顿（5 千字章节无感）。建议：父层改防抖（100–200ms）或惰性读 `view.state.doc`，只同步「已变更」信号；`body` 计算属性避免每次重切全文。
- **B-3 SSE 忙碌探测会建立真实流连接、占名额（待确认）**——`web-next/src/composables/useSse.ts:187-191`；服务端上限见 `server/api/stream.ts`（`MAX_SSE_PER_BOOK`）。探测以 fetch GET 真实 `/stream`，200 时服务端已推 sync 快照、登记消费者、占名额，客户端才 abort。与 0ms 首拍重连并发时可能挤掉正式 EventSource 名额致 429 再等 4s。建议：提供不建流的探测（HEAD 或 `?probe=1` 只做鉴权与名额判定），或探测与重连串行。
- **B-4 编辑供应商改 baseUrl 时静默沿用原 API Key**——`src/studio/server/api/providers.ts:273,286`。`newKey = input.apiKey || existing.apiKey`，此时 `baseUrl` 可改为任意主机，下次探测/生成即把原 Key 发往新地址（误填域名或换第三方中转站）。主控已复核。建议：`baseUrl` 主机名变化时服务端拒绝空 Key，要求重填，或前端显式确认。
- **B-5 Book.vue 与 chat store 职责过多**——`web-next/src/pages/Book.vue:63-346`（一个 setup 内含 SSE 看门狗、三段切书守卫状态机带回滚、关窗/刷新冲刷、自动保存计时）；`stores/chat.ts`（758 行，事件分发状态机 + 分支重生成 + 历史补种）；`stores/prefs.ts`（807 行，未精读）。建议：抽 `useBookSwitchGuard` / `useUnloadFlush` / `useAutosave`；chat 分发状态机独立成模块便于单测。
- **B-6 评审沿革注释严重挤占代码**——按「轮 / 修复批 / 重评 / 复审」粗计（含少量「轮询」等误计），studio 命中约 1800 行、src 全域约 5000 行，热点如（`doc.ts` 51、`stream.ts` 34、`Book.vue` 27、`server/index.ts` 26）；server 注释行约占 33%（4717/14357）；如 `web-next/src/api/client.ts:245-329` 注释远多于逻辑。A 区同型（如 `lifecycle.ts` session-end 段、`package.json` 的 `//overrides` 长文）。注释讲修复史而非不变量，阅读与改动成本高且易与代码脱节。建议：注释只留「为什么 / 不变量」，编号与沿革交给 git 历史；可分模块渐进清理，每批跑 L1。

## 五、设计取舍（不计为问题，留档）

- `/api/boot` 对无 Origin 请求直发 token（`server/api/books.ts:230-232`），写请求亦放行无 Origin：本机任意进程可驱动 API，代码注释明确「本机即同一信任域」。
- SSE `?token=` 兼容通道（`server/api/stream.ts:244-252`）使 token 出现在 URL；已有 ticket 通道为主路径。
- mac 包 ad-hoc 签名（`identity: "-"`），属发布策略。
- 已核实非问题：`/file` PUT 唯一调用方 `StyleBaselineCard.vue:145` 有基线时带 `expectedRevision`；快照 id/docId 有白名单校验（`document/version.ts:562-563`）；RAG 旧库迁移（`rag/store.ts:75-125`）有 checkpoint + 并发改用新库 + 侧车失败告警三重兜底。

## 六、亮点

- 窗口安全五件套单点收敛、外链白名单精确到仓库 releases 路径、IPC 载荷结构化校验。
- 原子写与路径防穿越达工业级；保存链一致性设计深，非 UTF-8 闸门防乱码回写。
- AI 链路：SDK 重试关闭由 runner 统一重试并尊重 Retry-After；卡顿先 abort 再弃迭代器，避免服务端继续计费；清理段异常被吞防 unhandledRejection。
- server 子进程崩溃原端口退避重启，渲染层收广播自动重连。
- 前端：零 XSS 面、零 `any`，监听器/定时器成对清理，弹窗 `role="dialog"` + `aria-modal` + 焦点陷阱齐全。

## 七、优先修复建议

1. **A-1**：session-end 先等 flush 落定再停机——唯一确认的高频日常静默丢字路径。
2. **A-2**：`git()` 统一禁 fsmonitor/hooks——唯一「放进书库即执行任意代码」面。
3. **B-1**：放宽保存端点上限 + 前端字节预检 + 413 专用机器码。
4. **B-4 / A-3**：改 baseUrl 须重填 Key；Key 存储强度如实告知或恢复钥匙串。
5. **A-4 / A-5**：长临界段锁开续期、接管原子化；快照失败处置定口径。

A-6～A-9、B-2、B-3 可并入同一清理批；B-5、B-6 属维护面，建议随所在模块后续改动渐进处理。

## 八、收口条件

P2×3 修复 + 对应复现测试通过 + L2 终门（vitest 全量 + tsc/vue-tsc + eslint + 四 check + e2e）全绿，方可收口；P3 逐条给出「修复 / 接受并记理由」处置。

## 九、收口记录（RC 源码重审修复批，2026-09-23）

**P2×3 全修 + 复现测试在案；P3×12 全处置（全量修复 10 条、部分修复 + 接受并记理由 2 条 = A-3 恢复项与 B-6 余量）；L2 终门全绿——收口。**

修复批落地于 `win` 线；开工前已核对源码面与本报告基线 `f2cd4aed` 逐字等价（win 线此前只并入 mac 线文档批，无源码改动），故全部发现在修复时点均属实。报告 §〇 自记「e2e 与四 check 未跑」的缺口已在本批补齐（见门实录）。

- **A-1（P2）**：session-end 处理器改「先等渲染层 flush 落定（≤预算，默认 2s）→ finally 恒下发停机指令」，与 close/quit 两链「先存后停服」收敛为同一条不变量。等待仍有界（2s + shutdown 3.5s ≈ 5.5s，仍在 R50-A-1 观察窗的覆盖内）；窗口已销毁/钩子缺失时 flush 立即返回，不是无条件 sleep。复现测试 = `test/desktop/main-close-flush.test.ts` 新增 3 例（flush 在途不提前停服 / 早退分支仍发停机 / 挂起渲染层到点放弃）。
- **A-2（P2）**：`src/git/exec.ts` 收敛单源 `hardenGitArgs()`——全部 `git` 调用（同步 + 异步）统一前置 `-c core.fsmonitor=false -c core.hooksPath=NUL|/dev/null`。复现测试 = `test/git/exec.test.ts`（真仓 fsmonitor 向量的对照臂证明修复前确实可执行 + 平台分支单测 + 同步/异步 argv 断言；变异验证：移除该旗即 2 例转红）。连带改口 2 处：只断言「子命令 + 实参」的异步孪生测试改为剥离硬化前缀后比对（`test/git/git-async-twins.test.ts`、`test/process/style-harvest-async.test.ts`（原 r44-style-harvest-async））。
- **B-1（P2）**：内容类保存端点上限放宽至 16MB（`CONTENT_BODY_LIMIT_BYTES` 单源，documents-save / files / documents-crud 三点），413 改用专用机器码 `PAYLOAD_TOO_LARGE`（原 `BAD_INPUT`）；前端 `shared/save-limits.ts` 按字节预检（UTF-16 长度快路 + TextEncoder 精算），超限文档停止 autosave 重试、手动保存时弹一次可读提示。复现测试 = `test/studio/save-content-body-limit.test.ts`（3 例，含前后端上限 parity 断言）+ `test/studio/webnext/doc-save-too-large.test.ts`（4 例）；连带 `test/studio/readjson-body-lifecycle.test.ts` 改口到新机器码。
- **A-3（P3，部分修复 + 恢复项接受并记理由）**：如实告知已落地——Key 输入框文案改「已存 Key（本机保存，留空即保留）」，AiServicePanel 明示「仅混淆级保护、非加密存储、不钥匙串托管、勿放同步盘或公开备份」，根 README 同步口径，源码注释指向 `os-kek.ts` / `vault-key.ts` 单源。**恢复 safeStorage 一项维持搁置**（v2 通道与 `OS_KEK_SHELVED` 不动）——该搁置属作者既有拍板纪律，本报告的建议落点即「搁置期间如实告知」。
- **A-4（P3）**：陈锁接管改「rename 到唯一隔离名（`.名字.<pid>.<uuid>.tmp`，与 ABANDONED_TMP_RE 同口径）再删」，夺锁期 ENOENT 续试；learn 收割锁开启续期（`LEARN_HARVEST_LOCK_RENEW_MS` = 30s）。残余如实记档：二次复核→rename 之间的 µs 级窗口是按名 check-then-act 固有，不宣称归零（见模块头注）。测试 = `test/fs/cross-process-lock.test.ts`、`test/learn/harvest-lock-before-scan.test.ts`（原 r0912-harvest-lock-first）。
- **A-5（P3，处置定口径 = 不阻断正文写）**：快照写失败改 fail-open——正文照常原子落盘，`SaveResult.snapshotDegraded` 随响应透出（服务端 200 + 标记，前端每文档一次 info 提示），不再因 `.版本` 写失败让整次保存 WRITE_ERROR。判据写入 `src/process/draft-pipeline.ts` 的消费方分诊单源汇总（编辑器保存链 = fail-open；与 AI 产物覆写面的 fail-closed 有意分叉，理由：被覆写的是编辑器自己上一版正文，非唯一副本）。测试 = 三件（`test/document/snapshot-fail-save.test.ts`、`test/studio/documents-save-snapshot-degraded.test.ts`、`test/studio/webnext/doc-save-snapshot-degraded.test.ts`）。
- **A-6（P3）**：compact 改「keep-set + 自基线偏移起尾段重读补追」（换行边界守卫 + 稳定性重读 ≤4 轮），并新增降级追加自校验 `appendDegradedVerified`（open 'a' → fstat dev+ino → 写 + fsync → stat 复核，重试 ≤3）；KN-H-1 期望升级为「压缩且新行保留」。残余窗口如实记档（µs 级，不宣称归零）。测试 = `test/document/journal.test.ts` 适配；专档降级自校验回归已随 P3-9 快照机制整体删除而撤档。
- **A-7（P3）**：providers 备份恢复改「先读 bak（读失败不碰主文件）→ 同一把写锁内 → 锁内复核 → 损坏主文件 rename 为 `.corrupt-<ts>` 留证 → 原子写回（fsync + 0600）」；三处与行为相反的文案一并修正。测试 = `test/ai/provider/bak-restore-safety.test.ts`（4 例）+ 既有 store / r2w4 用例加强。
- **A-8（P3）**：`withFirstByteTimeout` 更名 `withChunkStallTimeout`（口径是逐 chunk 挂起，不止首字节；**env 名与已落库事件字段 `firstByteTimeoutMs` 保名**——配置面与重放形状不破）；非超时异常分支补 `clearTimeout`（此前计时器白挂到超时点），finally 注释改为「结论而非前提」。测试 = `test/ai/gen.test.ts` 新增 2 例（fake timers 下 `getTimerCount() === 0`，含成功路径对照臂；变异验证：移除解武装即红）。
- **A-9（P3）**：超时文案改走 `src/shared/text.formatTimeoutText()` 单源（<1s 毫秒 / <60s 秒 / 否则分钟，向下取整——文案口径是「超过 N」），消除「0.001 分钟」「1.5 分钟」这类不可读值。测试 = `test/ai/runner.test.ts` 参数化矩阵（8 档边界）+ 真实超时出口的 60ms 锚点。
- **B-2（P3）**：编辑器正文回写改 200ms 尾防抖单源（`shared/body-writeback.ts`），按键同步路径只保留一遍全文拷贝；快照/外部写回前先 `flushBodyWriteback()`（六处消费点，关窗 `hasUnsavedWork` 纳入待回写判定）。测试 = `test/studio/webnext/editor-body-writeback.test.ts`（11 例）+ 两件既有编辑器用例改口。
- **B-3（P3，报告标「待确认」→ 实测确认成立）**：GET 探测确实真建流并占名额（仪器化实测：探测 200 → 计数 4→5 → 正式流 429）。改法 = 新增 HEAD 探测路由（只做鉴权与名额判定、不登记句柄），前端探测改 `method: 'HEAD'`，CORS `allow-methods` 补 HEAD，拒绝路径与建流侧共用 `replySseBusy` / `replySseForbidden` 单源。测试 = 服务端 5 例 + 前端 4 例（变异验证）。
- **B-4（P3）**：编辑供应商改 `baseUrl` 主机名且 Key 留空 → 400 `API_KEY_REQUIRED_ON_HOST_CHANGE`（要求重填），同请求显式带 Key 正常保存；判定与文案收敛单源 `src/studio/server/api/host-change-guard.ts`，并**同型补洞 `/api/rag-providers`**（endpoint 换主机 + 空 Key 同拒绝；复核本报告 B-4 时发现的同类面）。测试 = `test/studio/provider-key-host-change.test.ts`（8 例）+ 前端拒绝原因上屏 + `test/studio/rag-providers-api.test.ts` 新增 1 例并改口既有「换 endpoint」用例（原断言钉的是修复前语义）。
- **B-5（P3）**：前端职责拆分——抽 `stores/chat-dispatch.ts`（事件分发状态机）、`composables/useBookSwitchGuard.ts`（切书守卫带回滚）、`useUnloadFlush.ts`（关窗/刷新冲刷）、`useAutosave.ts`（自动保存计时）；`Book.vue` 401→128 行、`stores/chat.ts` 758→500 行。SSE 看门狗按既有源码锚测试（`sse-selfheal`）保留在 Book.vue 内——该段与挂载点语义强绑定，不为拆而拆。测试 = 3 件新文件（25 + 10 + 6 例）。
- **B-6（P3，部分修复 + 余量接受并记理由）**：定界批清理报告点名热点（`stores/doc.ts`、`pages/Book.vue`、`api/client.ts`、`server/index.ts`、`server/api/stream.ts`、`desktop/lifecycle.ts`、`package.json` 注释键）：沿革句压成「为什么 / 不变量」，轮次编号交回 git 历史。两路独立自检「注释外零改动」（`transpileModule(removeComments)` 输出、AST token 流、package.json 去注释键后深比较——均逐字相同），eslint + typecheck + 相关测试面全绿。**余量按报告自建议「随所在模块后续改动渐进处理」**：同型热点仍存于 `documents-crud.ts`、`http.ts`、本批新抽出的 `useBookSwitchGuard.ts`、`test/helpers/studio-token-setup.ts` 等，另立批按同口径处理。
- **门实录（L2 终门，修复批全量）**：`typecheck` ✅ + `typecheck:web-next` ✅ + `eslint --max-warnings 0` ✅ + `check:counts` ✅（README 同步为 1303 文件 / 8112 单测）+ `check:docs` ✅ + `check:packaging` ✅ + `check:knowledge` ✅ + vitest 全量 ✅（实测执行 1303 文件：1295 passed / 8 skipped；8037 例：7961 passed / 76 skipped / **0 failed**；343.5s）+ e2e ✅（33 spec / 54 例：51 passed / 3 skipped，含 `build:web`）。README 的 8112 与实测 8037 之差是 `check:counts` 的静态枚举口径（模板标题与平台门用例全计，不数执行），非漏跑。
- **本批无新增待拍板项**；§五 设计取舍四条维持留档，与本批处置不冲突。
