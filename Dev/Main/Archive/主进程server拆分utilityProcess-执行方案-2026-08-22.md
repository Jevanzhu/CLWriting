# 主进程 server 拆分 utilityProcess — 执行方案

- 日期：2026-08-22（立项）；**2026-08-23 依方案评审修订**（`Archive/主进程server拆分utilityProcess-方案评审-2026-08-23.md`（原 01-评审/，随二轮复核开评归档）S-1~S-13 全回填——恢复链两个契约（重启端口复用 S-1 / token 跨重启稳定 S-2→U-6）、改动面补 bootstrap-runner 与 src/log（S-3/S-4）、exit-重启互斥（S-5）、引擎名 node:sqlite 口径（S-6）、utility 网络栈验证（S-7）等；逐项落点见第十节修订记录）；**2026-08-23 同日二轮复核修订**（`Archive/主进程server拆分utilityProcess-方案评审二轮-2026-08-23.md`（原 01-评审/，2026-08-23 文档整理归档）F-1~F-6 全回填——用例数 21 实口径 / 握手统一 parentPort / 日志转发 err 透传 + initLogging 层短路 / token 启动读入内存一次复用 / 状态码 403 口径；逐项落点见第十节增记）
- 状态：**已完成**（2026-08-22 立项、作者拍板 A 方案；微决策 U1-U6 按第六节建议默认执行（U-6 为 2026-08-23 评审补）；**2026-08-23 批 U0-U4 全部完成：U0 基线 `372c8cb` / U1 `3ccd76f` / U2 `d49e2b1` / U3 `57b6803` / U4 文档批无代码提交**，执行记录见第十节；win 实测挂账转阶段 21 批 J0/J4 之后）
- 上游：2026-08-22 资源优化专项——前置优化已入库（cff3432 CSS/动画收敛与闲置动画删除 + 2b5a4af `.glow` blur 移除 + 1f7c2fd 三窗 `spellcheck:false`，闲置 CPU 已实测归零）；架构四方案对比（A utilityProcess / B Tauri / C 纯 Web / D 原生）后拍板 **A**——win 平台为硬需求（阶段 21 批次 J）使 B 的内存收益仅剩 mac 侧、双引擎回归 + IPC 全重写代价不划算。
- 阶段：总览阶段 22；任务清单：`Archive/参考项目深化研读与借鉴吸收-2026-08-15.md` 第九节 批次 K。
- 验收门：第七节；执行记录回填：第十节。
- 归档：2026-08-24 已完成归档 Archive/（原 02-执行/；批 U0-U4 全收口，执行记录见第十节）。

---

## 一、背景与动机

### 1.1 现状进程模型

Electron main 进程（`src/desktop/main.ts`）在打包态直接调用 `startServer(...)` 把整个 studio 后端内嵌在主进程里跑（`main.ts:369`）：HTTP 路由分发表、SQLite 双库（events/RAG，Node 内置 `node:sqlite`——项目零第三方 native 依赖）、driver 会话、SSE 长连接、静态托管全部与窗口管理、原生菜单、IPC（字体枚举等 12 个 channel）同进程。

实测基线（2026-08-22，mac arm64，书架页闲置）：

| 进程 | 常驻内存（phys_footprint） |
|---|---|
| Main（含 studio server） | ~70MB |
| GPU | ~115MB |
| Renderer | ~83MB |
| Network utility | ~9MB |
| 合计 | ~277MB |

闲置 CPU 在动画静态化后已归零（此前 ~15% 单核，cff3432）。

### 1.2 痛点（本方案要解决的）

1. **崩溃耦合**：studio server 的未捕获异常或 `node:sqlite`（Node 内置 SQLite 绑定，S-6 口径校准——非 better-sqlite3，全仓零该依赖）native 段错误直接带走整个 main——窗口、编辑器里未保存的界面状态全部消失（渲染进程崩溃有 `render-process-gone` 重载自愈，main 崩溃无此待遇）。
2. **不可恢复**：server 侧故障（端口占用、DB 损坏抛错）只能整进程退出重来。
3. **账目不清**：main 70MB 里壳层与后端各占多少无数据，资源回归无法归因（`app.getAppMetrics()` 只见一个 main）。

### 1.3 目标 / 非目标（诚实口径）

**目标**：
- server 崩溃不连坐窗口，且可独立自动重启——**恢复链由本方案自持（S-1/S-2 回填）**：重启 fork 钉住原端口（前端全同源相对路径、页面 origin 固化，§3.4）+ studioToken 跨重启稳定（U-6，旧 token 不失效）；前端 `serverOnline` 心跳信号感知断连/恢复（书内口径，§2.2），重连 UI 近零成本；
- main 瘦身为纯壳层（预期 ~25-35MB）；
- utility 进程在 `getAppMetrics()` 单列，资源账目清晰。

**非目标**：
- **总内存下降**——server 是搬家不是瘦身，utility 进程自身壳开销 ~10-15MB，总账预期持平或微增（±15MB），验收时如实记录不粉饰；
- 性能优化——前后端通信面（localhost HTTP/SSE 环回）一个字节都不动。

## 二、现状盘点（改动面事实，2026-08-22 核对）

### 2.1 启动链走读（`main.ts` bootstrap 336-425 行；生命周期三段守卫在 `bootstrap-runner.ts`——O-4（第十三轮）自 main.ts 抽出、main 只剩接线，S-4 回填）

```
bootstrap():
  workDir 定位：store.current（存在即用）> findWorkDir(cwd)   ← 留在 main（needsWelcome 判定 + workdir.json 管理都在 main）
  needsWelcome = !workDir
  devUi = CLW_DEV_UI=1 → appUrl = localhost:5173，不起 server（HMR 态，本方案不纳入，见 U-4）
  打包态:
    --book 直进：resolveInitialBook(workDir, ref) → setInitialBook(name)   ← main 直调 server 模块函数（main.ts:34, 362-365）
    staticDir = resolveStaticDir()（app.asar/dist/web | 开发态项目根 dist/web）
    server = startServer({ port: 0, staticDir, workDir, userDataPath, mirrorConsoleLog: !app.isPackaged })   ← main.ts:369
    port = await listenPort(server)          ← port 0 随机端口，listening 后取实际值（main.ts:242-251）
    appUrl = http://127.0.0.1:${port}
  建主窗（bounds 恢复）→ loadURL(needsWelcome ? appUrl/welcome : appUrl)   ← loadURL 天然在 ready 之后，时序等价基线
```

退出链：`before-quit` → `shutdownStudio(getWorkDir 回调, studioServer)`（`graceful-shutdown.ts`：每书 abortSelfHeal/abortChat + waitSettled（session/end 落库）+ waitBackgroundTasks + server.close，双 1.5s 超时放行）。

生命周期三段守卫（`bootstrap-runner.ts`，O-4 抽出）：Y-P2-7 bootstrap 并发重入挡 / L-3+R-14 **重试前关旧 server**（上次 bootstrap 在 startServer 之后失败时的滞留清理）/ 低-8 退出途中 activate 直通——拆分后「关旧 server」语义必须换轨为 serverManager 停旧 child（kill + 等退出），改动面见 §四（S-4）。

### 2.2 现成可复用资产

| 资产 | 现状 | 拆分中的角色 |
|---|---|---|
| `src/desktop/server-main.ts` | 独立 server 入口（发布冒烟/e2e 用，`node dist/desktop/server-main.js --dir --port`）：参数组装、EADDRINUSE 中文兜底、SIGINT/SIGTERM 2s 超时强退 | 与新 utility 入口抽共享核心 `server-boot.ts`（U-3），两薄壳各留形态 |
| `useHeartbeat`（前端） | 进书后 20s POST /heartbeat（**书内口径**——书架/welcome 页无心跳、断连不可见，S-10 登记见 §九），`serverOnline` 全局信号驱动状态栏徽章 + 右栏 AI 置灰 | server 重启期间断连提示零改动生效、恢复回绿——**前提是 §3.4 端口复用 + U-6 token 稳定**：前端 API/SSE/心跳全同源相对路径且 token 仅挂载时取一次（`client.ts` boot 无 403 重取），端口或 token 任一换代，心跳 POST 携旧 token 403 会把信号永久卡灰（服务端写闸/SSE 闸统一回 403 FORBIDDEN——二轮 F-6 口径） |
| `test/desktop/main.test.ts` | kk-P2-8：vi.mock('electron') 全假件 + 动态 import main.js 驱动真实生命周期（21 用例，二轮 F-1 实测口径：vitest 21 passed；一轮 S-13 的「24」系宽匹配 grep 把 3 行 `emit(` 误计） | 扩 mock `utilityProcess`，server-manager 以注入 fork 实现单测 |
| `render-process-gone` 自愈（dd-P3） | 渲染进程崩溃重载窗口 | server 侧对齐同款自愈思路（批 U3 重启） |

### 2.3 零改动面（行为红线）

- `src/studio/server/**` 全部业务代码、HTTP/SSE 协议、静态托管——**唯一豁免（U-6 A，S-2）**：`StudioServerOptions` 增可选 `studioToken` 注入参数（缺省 `randomUUID()` 行为不变，协议语义零改动）；
- 前端全部（含 preload）；12 个 `desktop:*` IPC channel 及其守卫（字体枚举/穿越校验/菜单等全留 main）；
- `relaunch()`（切书库重启整进程）——child 随 app 退出，新进程重新 fork，行为不变；
- e2e 体系——主套件（39 过 2 跳）由 global-setup 在 Playwright 进程内 `import { startServer }` 起后端（`test/e2e/global-setup.ts`，不经 Electron main、也不经 server-main.js），仅 release-smoke 2 用例真跑编译产物 `server-main.js`（S-11 表述校准）——**天然不受影响**，release-smoke 回归确认。

## 三、目标架构

### 3.1 进程图

```
拆分后：
┌─ main（瘦身后 ~25-35MB）────────────┐      ┌─ utilityProcess（~60-70MB）──────────┐
│ 窗口工厂/菜单/12 个 IPC channel      │ fork  │ studio server 全量                    │
│ workDir 定位 + workdir.json 管理     │──────→│ （HTTP 路由/SQLite×2/RAG/SSE/静态）   │
│ serverManager：                      │  消息  │ server-boot 核心（与 server-main 共享）│
│  fork/ready 握手/exit 监听/退避重启   │  通道  │ shutdown 指令执行（shutdownStudio 下沉）│
│ stdio→logger 转发（单写者）          │       │                                       │
└─────────────────────────────────────┘      └───────────────────────────────────────┘
        ↑ 前端 http://127.0.0.1:<port>（环回，不经任何进程的 JS 上下文，零改动）↑
```

**端口与 token 契约（S-1/S-2 回填）**：首启 `--port 0` 随机、实际端口经 ready 回传由 main 记住；**崩溃重启 fork 钉住原端口 + 同一 token**——前端 API/SSE/心跳全部同源相对路径（`client.ts` apiFetch / `useSse` 生产态 base=''），页面加载那一刻 origin 固化，端口或 token 任一换代渲染进程都连不回（token 仅挂载时经 /api/boot 取一次、无 403 重取）。

### 3.2 握手协议（parentPort 默认消息通道，消息形状进代码注释与测试）

- 传输机制（二轮 F-2 统一）：utilityProcess 自带 main↔child 双向默认通道——main 侧 `child.on('message', ...)` / `child.postMessage(...)`，child 侧 `process.parentPort.on('message', ...)` / `process.parentPort.postMessage(...)`（Electron typings ParentPort 明文默认双向）；**不引入 MessageChannelMain 端口转移**——fork options 传 port + 两侧接线是专用 MessagePort 通道的仪式，ready/shutdown 级小消息用不上，徒增接线面。原文 §3.2 与 §四 各写一套互斥机制（MessageChannelMain vs parentPort）系初稿遗留、一轮评审漏检，本条一并收口。
- child → main：
  - `{ type: 'ready', port: <实际监听端口> }`（listening 后发，每 child 一次；**握手状态机按「每 fork 一轮」建模**——S-5：退避重启的新 child 各发各的 ready/port，manager 每轮重置握手期待，不假设全局一次性）；
  - `{ type: 'boot-error', code: 'EADDRINUSE' | ..., message: string }`（startServer/监听失败，替代现在的 reject 路径）；
  - `{ type: 'shutdown-done' }`（优雅退出完成回执，main 侧总超时兜底不等它也行）。
- main → child：
  - `{ type: 'shutdown' }`（before-quit 时下发，child 执行 shutdownStudio 全流程）。
- 端口握手的时序等价基线：现状就是 `await listenPort(server)` 之后才 `loadURL`；拆分后 `await readyMsg` 之后才 `loadURL`，首窗白屏时间增量 = fork 冷启动（预估 100-300ms，批 U1 实测，>500ms 再优化并行建窗）。

### 3.3 参数与环境传递

| 现状（main 进程内） | 拆分后（跨进程） |
|---|---|
| `workDir`（main 定位） | `--dir <abs>` 参数；**可缺省 = welcome 态**（与现状 `startServer({workDir:null})` 等价——welcome 页由 server 托管，建库后走既有 relaunch 链，S-8） |
| `app.getPath('userData')` | `--user-data <abs>` 参数（child 无 app 对象） |
| `port: 0` 随机 | 首启 `--port 0`，实际端口走 ready 消息回传、main 记住；**崩溃重启 fork 显式 `--port <该端口>`**（S-1——Node listen 默认 SO_REUSEADDR，child 死后立即可重绑；重启钉端口失败（EADDRINUSE 瞬态）并入退避重试，不走启动失败退出路径） |
| `studioToken = randomUUID()`（server 进程内每次新生成） | **U-6 A（S-2）**：main 首启生成并原子持久化（userData/studio-token.json），**启动读入内存一次、fork 一律复用内存值**（二轮 F-5——免每次 fork 读盘，亦消除会话中途 token 文件损坏→重启换代 token 的窄边），fork 经 `--token <uuid>` 传 child → startServer 可选参数注入（缺省 randomUUID 行为不变） |
| `setInitialBook(name)`（main 直调） | `--book <name>` 参数，child 在 startServer 前调 `setInitialBook`（U-1 附带） |
| `mirrorConsoleLog: !app.isPackaged` | `--mirror-console` 标志参数按需传（仅 server-main 直跑形态消费；child 态日志通道恒为 stdout，见 §3.5） |
| `staticDir` | child 自派生（与 server-main 同款：`dirname(本文件)/../web`，asar 内路径等价） |
| —（main 直调无此概念） | fork options 附 `serviceName: 'studio-server'`（getAppMetrics 单列的可辨识名 ProcessMetric.name，S-12） |
| 环境变量（CLWRITING_DRIVER 等） | utilityProcess 默认继承父进程 env（Electron typings 明文 `env` 缺省 = `process.env`），批 U1 核验并加断言；`CLW_LOG_STDOUT=1` 经 `options.env` 注入（不污染 main 自身 env，§3.5） |

### 3.4 生命周期四条时序

1. **正常启动**：whenReady → 定位 workDir → fork(--dir?/--user-data/--port 0/--token/--book?) → ready(port) → 建/复用主窗 loadURL。
2. **启动失败**（**仅首次启动**）：boot-error（如 EADDRINUSE）→ 原生错误对话框（复用 server-main.ts:35 中文文案口径）→ app.quit()；重启期的瞬态失败并入时序 3 退避，不走本路径。
3. **运行中崩溃**：child `exit` 事件（**shutdownStarted 未置位时才算崩溃**——互斥见时序 4）→ 记日志 → 退避重启（立即 / 5s / 15s，U-2；**fork 钉住原端口 + 同一 token**）→ 重启期间前端 serverOnline 心跳失败自动置灰（书内口径），恢复回绿；3 次仍失败 → 对话框（重启服务 / 退出应用），**窗口与编辑器界面状态全程存续**（U-6 A 下页面不重载、token 不换）。
4. **退出**：before-quit → 发 shutdown 指令 → child 执行 shutdownStudio（在途编排收尾 + server.close，双 1.5s）→ shutdown-done 或 main 侧 2s 总超时 → child.kill() 强杀兜底 → 继续 quit。**exit/重启互斥（S-5）**：shutdownStarted 置位后 child exit（含 kill 兜底触发的）不再进入退避重启——否则退出途中 fork 新 child 成孤儿（验收门 4 直接打挂），server-manager 以内部状态门实现并配测试用例。app 崩溃路径：utilityProcess 由 Electron 运行时管理随 app 退出（批 U2 实测确认，异常则补 will-quit kill）。

### 3.5 日志（U-5：单写者）

child 不自写 JSONL（避免双进程同写 `userData/logs/app-*.jsonl` 交错、且 child 若同时 stdout 镜像会双记）。落地机制（S-3 回填——`initLogging` 在 startServer 内部无条件落盘（server/index.ts:143），单靠入口覆盖会被重设，必须走模式分支）：

- `src/log/index.ts` 增 **stdout-only 模式**（env `CLW_LOG_STDOUT=1`：**initLogging 层短路**——不设 logsDir、不 mkdir、不跑 7 天清理（src/log/index.ts:102-108 原样执行的话 child 每次 fork 仍有文件系统副作用、与 main 单写者双清同一 logs 目录，二轮 F-4），emit 直写 `process.stdout` 一行 JSON（与落盘行同构 `{ts,level,tag,msg,err?}`）；startServer 内部 init 无需改动——模式分支在 initLogging 自身）；server-manager fork 时经 `options.env` 注入（不污染 main 自身 process.env）；缺省（未设 env）行为逐字节不变，server-main 直跑与单测零感知；
- main 以 `stdio: 'pipe'` fork（utilityProcess 该项**缺省是 `inherit`**——Electron typings 明文，必须显式传 pipe），逐行读 child.stdout：每行按 JSON 解析后 `log[level](tag, msg, err)` 重发落盘——**err 透传**（二轮 F-3：`log.error` 第三参，不透传则 server 侧错误对象/堆栈在转发层丢失；行内无 err 字段不传第三参）；ts 以 main 收行时刻重记（stdio 实时转发漂移可忽略，需原始时刻考古时行内原文兜底路径已覆盖）——等级/标签保留、**不产生 JSON 套 JSON**（S-3：不做 `log.info('server-proc', line)` 整行二次序列化）；解析失败的行按 `log.info('server-proc', 原文)` 兜底；
- 重放与排障口径不变：日志单文件、tag 维度区分来源（server 侧原 tag 原样保留）。

## 四、改动面清单（文件级）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/desktop/server-boot.ts` | **新增** | 共享核心纯函数：组装 startServer 参数（--dir（可缺省=welcome 态）/--user-data/--port/--token/--book/--mirror-console 解析）+ listening/error 信封化回调（供两入口复用，U-3 单一真相源） |
| `src/desktop/server-utility.ts` | **新增** | Electron utility 入口薄壳：parentPort 握手（ready/boot-error/shutdown-done）+ shutdown 指令执行（调 shutdownStudio，超时参数同现状）|
| `src/desktop/server-manager.ts` | **新增** | main 侧管理器：fork（入口路径定位兼容 asar；`serviceName: 'studio-server'` + `stdio: 'pipe'`（缺省 inherit）+ env 注入 `CLW_LOG_STDOUT=1`）+ 消息握手（parentPort 默认通道，§3.2——二轮 F-2）+ exit 监听退避重启（**钉住原端口 + 同一 token；shutdownStarted 置位后 exit 不触发重启——S-5 状态门**）+ stdio 转发（JSON 行解析按 level/tag/err 重发，§3.5）+ shutdown 下发与总超时 + **token 首启生成/原子持久化（userData/studio-token.json）/启动读入内存一次、fork 一律复用内存值（U-6，二轮 F-5）**；**fork 以依赖注入暴露**（测试替换假件） |
| `src/desktop/main.ts` | 修改 | bootstrap 打包态分支：删 startServer/listenPort/setInitialBook 直调，改 `serverManager.start()` 拿 port；before-quit 改发 shutdown 指令；`studioServer` 状态量删除；bootstrap-runner deps 接线换轨（下行）。其余（窗口/IPC/菜单/second-instance）零改动 |
| `src/desktop/bootstrap-runner.ts` | 修改（S-4） | deps 语义换轨：`getStudioServer/setStudioServer` 的「重试前关旧 server」改为经 serverManager 停旧 child（kill + 等退出）；shuttingDown 三段守卫语义不变 |
| `src/log/index.ts` | 修改（S-3） | stdout-only 模式（env `CLW_LOG_STDOUT=1`：initLogging 层短路——不设 logsDir/不 mkdir/不 cleanup，emit 直写 stdout 一行 JSON，二轮 F-4）；缺省行为逐字节不变 |
| `src/studio/server/index.ts` | 修改（**唯一红线豁免**，U-6 A） | `StudioServerOptions` 增可选 `studioToken` 参数（缺省 `randomUUID()` 行为不变，协议语义零改动） |
| `src/desktop/server-main.ts` | 修改（小） | 参数组装/错误信封改走 server-boot 共享核心，node 直跑形态保留（e2e/冒烟不动） |
| `tsup.config.ts` | 修改 | entry 加 `src/desktop/server-utility.ts`（dist/desktop，与 main 同 config；electron-builder `files: dist` 自动含） |
| `test/desktop/main.test.ts` | 修改 | mock electron 补 `utilityProcess` 假件；启动链断言改握手口径（loadURL 前置 ready；21 用例基线——二轮 F-1 实测） |
| `test/desktop/server-manager.test.ts` | **新增** | 握手（ready 传端口/boot-error 退出/两轮 fork 各自 ready）/ 退避重启次数与间隔 + 端口钉住 + 计数复位窗口 / **shutdownStarted 后 exit 不触发重启（S-5）** / shutdown 总超时强杀 / stdio 转发（JSON 行解析/坏行兜底），注入假 fork 驱动 |
| `test/desktop/server-boot.test.ts` | **新增** | 参数解析与两入口共享等价性（--book → setInitialBook 调用序、--token 注入与缺省等价、--dir 缺省=welcome 态、EADDRINUSE 信封形状） |
| `test/log/log.test.ts` | 修改（扩展） | stdout-only 模式回归（emit 直写 stdout 行形状 / 未设 env 时缺省行为不变） |

不动：`src/studio/server/**`（除上表 U-6 唯一豁免行）、`src/studio/web-next/**`、preload、e2e spec、CI（desktop.yml tag 门现有三步不涉本面）。

## 五、批次分解（批 U0-U4，每批独立全绿后提交）

### 批 U0：基线固化
- 五件套绿基线提交号记录（当前 HEAD）；
- 进程基线留档：拆分前 main/GPU/Renderer/Network 四进程 footprint + 书架页闲置 CPU（作为批 U4 对账基线）；
- 验收：基线数字落入本节回填区。

### 批 U1：共享核心 + utility 入口 + 握手（主批）
- `server-boot.ts` + `server-utility.ts` + `server-manager.ts` + main.ts 接线 + tsup entry；
- 覆盖：ready 端口回传、loadURL 时序等价、--book 下沉、--token 注入与缺省 randomUUID 等价、--dir 缺省（welcome 态）解析、serviceName 落 getAppMetrics 单列、env 继承断言、EADDRINUSE 对话框（时序 2）；
- `node:sqlite` 在 utility 进程可用性首验（风险 R-1，S-6 口径——项目无第三方 native 模块，ABI/asarUnpack 议题不存在，验证点为内置模块在 utility 进程 Node 环境的可用性与实验性告警口径；异常即停批上报）；
- 验收：mac 打包态（`npm run dev:electron` 未打包路径 + build:desktop:dir）启动、进书、SSE 对话、`--book` 直进、welcome 态（--dir 缺省）建库链路各手动过一遍 + 全量单测/e2e 绿；**utility 网络栈实测**（R-7，S-7）：系统代理环境（clash/surge 类）下 provider 出呼与 main 内嵌态对照（连通性/延迟/流式完整性）。

### 批 U2：退出联动 + 日志转发
- shutdown 指令 + shutdownStudio 下沉 + 2s 总超时强杀 + shutdown-done 回执；
- **shutdownStarted 后 exit 不触发重启的状态门**（S-5）+ 退避计数复位窗口（U-2：ready 后稳定运行 5 分钟清零）用例；
- stdio pipe → logger 单写者（U-5 落地机制见 §3.5：src/log stdout-only + main 解析重发）；mirrorConsole 语义在 child 侧的对齐（child 恒 stdout 通道）；
- 孤儿进程实测（正常退出/强杀 main 两种）；
- 验收：退出后无残留 utility 进程（`ps` 核验）；JSONL 单文件、无同条双记、server 侧 tag 原样保留；被中断会话 session/end 落库（shutdownStudio 既有行为回归）。

### 批 U3：崩溃自动重启
- exit 监听 + 退避（立即/5s/15s）+ 3 次封顶对话框（重启服务/退出）；
- 前端联动实测：kill -9 utility → 窗口存续、**端口不变 + token 不换断言**、serverOnline 置灰 → 自动恢复回绿 **+ 写请求恢复断言（进书后保存一次成功——端口或 token 任一失效都会在此暴露，S-1 连带）**；
- 验收：演练脚本留证入批注；server-manager.test.ts 重试用例绿。

### 批 U4：测试收口 + 双平台实测 + 文档回填
- 五件套全绿（tsc/vue-tsc/vitest/e2e/check:counts，README 计数随单测增量同步）；
- mac 实测对账：四进程（含 utility 单列）footprint vs 批 U0 基线，总账 ±15MB 口径如实记录；
- win 实测：**依赖阶段 21 批 J0/J4**（win 构建就绪）；未就绪则本批 mac 收口、win 验证挂账转阶段 21 尾部，不阻塞收口；
- 总览阶段 22 状态、8-15 第九节批次 K、本文件第十节回填。

## 六、微决策点（附建议；默认按建议执行，作者可否决）

| # | 决策点 | 选项与建议 |
|---|---|---|
| U-1 | 握手时序 | **建议**：先 fork 等 ready 再 loadURL（与现状 `await listenPort` 时序严格等价，白屏增量预估 100-300ms）；备选：先建窗挂 loading 态并行 fork——首窗更快但引入首载竞态，实测 >500ms 劣化才切换 |
| U-2 | 重启策略 | **建议**：自动退避重启（立即/5s/15s），3 次封顶转原生对话框（重启服务/退出应用）；**计数器 ready 后稳定运行 5 分钟清零**（S-9——偶发单次崩溃不累计到 3 误弹对话框）；不做静默无限重启（掩盖持续故障） |
| U-3 | 入口收敛 | **建议**：server-main 与 server-utility 抽 `server-boot.ts` 共享核心（参数组装 + 错误信封单一真相源），两薄壳各留握手/信号形态差异；反对两入口各自复制参数解析 |
| U-4 | dev 形态范围 | **建议**：CLW_DEV_UI=1 HMR 态不纳入（现状本就不起 server，dev-api 独立进程已是「拆分」形态）；未打包非 HMR（`npm run dev:electron`）纳入拆分以保测试面一致 |
| U-5 | 日志归属 | **建议**：单写者——child 走 stdout（src/log stdout-only 模式），main pipe 收行解析重发落 JSONL（落地机制 §3.5）；备选：child 自写独立 `server-*.jsonl`（隔离好但日志分裂，排障要拼两文件） |
| U-6 | studioToken 跨重启稳定（2026-08-23 评审补，S-2） | **建议 A**：token 由 main 首启生成并原子持久化（userData/studio-token.json），fork 经 `--token` 传 child、startServer 可选参数注入（`src/studio/server/**` **唯一红线豁免**，缺省行为不变）——前端 boot 一次性、无 403 重取（`client.ts` O-10 约束），token 换代即写请求/SSE/心跳永久 403 FORBIDDEN（服务端写闸 `server/index.ts:296` / SSE 闸 `stream.ts:220` 统一口径——二轮 F-6；client.ts:24/32 注释的「401」系该文件自身不精确表述，非服务端行为）；安全口径不降级（boot 路由 ee-P2-12 已拍板「token 不承诺防本机进程」，持久化防的仍是远端网页驱动，网页读不了本地文件）；备选 B：重启后 main 对全部窗口 reload（main-only 但「窗口与编辑器界面状态全程存续」承诺失效）；备选 C：前端 403 时重跑 boot 取新 token（破前端零改动红线，不推荐） |

## 七、验收清单（收口门）

1. **行为等价红线**：HTTP/SSE 协议零改动；前端与 preload 零改动；12 个 IPC channel 行为不变；e2e 39 过 2 跳不降；release-smoke 2 用例过（U-6 的 startServer 可选参数为唯一豁免——缺省路径行为不变由回归锚定）。
2. **时序等价**：loadURL 仍发生在 server ready 之后（测试断言锚定）。
3. **稳定性目标**：kill -9 utility 演练——窗口存续、自动重启、**端口不变 + token 不换**、serverOnline 灰→绿恢复 **+ 写请求恢复（进书后保存一次成功；端口或 token 任一失效都会在此暴露）**（留证）。
4. **退出卫生**：正常退出/强杀 main 均无孤儿 utility 进程（含 shutdownStarted-exit 互斥门）；被中断会话 session/end 落库不回退。
5. **资源口径（如实）**：main 瘦身至 ~25-35MB；总账 ±15MB；utility 在 getAppMetrics 单列（serviceName 可辨识）——三项数字入第十节，劣化超界则说明原因或回滚。
6. **质量门**：五件套全绿；新增回归（握手/重启/退出/参数共享等价/**exit-重启互斥/端口钉住/token 注入/log stdout-only**）全绿。
7. **回滚廉价性确认**：任一批 revert 即回内嵌形态（通信面零改动是 A 方案的工程优点，收口时验证一次干净回滚）。

## 八、风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R-1 | `node:sqlite`（Node 内置 SQLite，S-6 口径校准——项目零第三方 native 依赖，非 better-sqlite3）在 utility process 不可用或行为异常 | 同一 Electron 二进制内嵌 Node，版本一致理论无障碍；批 U1 首项验证（可用性 + 实验性告警口径留档），异常即停批上报（回退 = 保持内嵌，方案整体重议） |
| R-2 | main 崩溃时 utility 成为孤儿 | Electron 文档口径 utilityProcess 随 app 退出收编；批 U2 双路径实测（正常退出 + 强杀），异常则补 will-quit 兜底 kill + child 侧父进程存活性检测 |
| R-3 | fork 冷启动劣化首屏 | 批 U1 实测记录；>500ms 切 U-1 备选（并行建窗） |
| R-4 | 双写日志交错/丢失 | U-5 单写者设计根除（src/log stdout-only + main 单点落盘，§3.5）；批 U2 验证单文件无同条双记 |
| R-5 | 与并行批次共管 `main.ts`（批次 J5 体验面也改 main.ts） | 让路约定：J5 未开工，本方案先行；若交叠，J5 的标题栏/字体缓存改动与 serverManager 无逻辑耦合，按先提交方为准 rebase |
| R-6 | asar 内入口路径定位（fork 传 `dist/desktop/server-utility.js` 相对 app 根） | server-main 已有同款 `dirname(fileURLToPath(import.meta.url))` 派生先例；批 U1 打包态（build:desktop:dir）实机验证 |
| R-7 | utility 进程网络栈与 main 内嵌态不等价（S-7，2026-08-23 评审增）——Electron ForkOptions 文档明文：utility 网络请求默认走 system network context（无 HTTP cache），系统代理（clash/surge）环境下 provider 出呼行为可能漂移（本项目对代理敏感有前科：dev 态 renderer 显式 setProxy direct） | 批 U1 开代理环境实测对照（连通性/延迟/流式完整性）；异常则评估 ForkOptions.session 显式配置或该流量留 main 的取舍，上报作者再定（不静默放行——威胁验收门 1 行为等价） |

## 九、关联与挂起项

- **书架页/welcome 页断连盲区（S-10 登记，不做）**：serverOnline 心跳仅书内有——书架页 utility 崩溃对用户不可见（重启自动完成则无感，3 次失败对话框兜底可见）；心跳挂 App 层可解但破前端零改动红线，登记待作者取舍。
- **getAppMetrics 周期埋点**（JSONL 进程指标，60s）：作者已暂缓；与本方案天然配套（utility 单列后价值放大），批 U0/U4 可选附带，不纳入验收门。
- **win 平台**：批 U4 的 win 实测依赖阶段 21 批 J0（打包）/J4（CI）；未就绪挂账不阻塞 mac 收口。
- **e2e 视觉回归固化**（截图像素 diff）：资源优化专项另一挂起项，与本方案无关，独立立项。
- GPU 内存 A/B（blur 移除收益补测）：待机器空闲环境，与本方案无关。

## 十、执行记录（回填区）

- **批 U0：已完成（2026-08-23，基线 HEAD `372c8cb`，工作树干净）**：
  - 五件套绿基线：tsc 0 错 + vue-tsc 0 错 + vitest 337 文件/3036 单测全绿 + e2e 39 过 2 跳 + check:counts 过（README 声称 337/3036 与实测一致）；
  - 进程基线留档（**对账口径：dev 未打包形态 `electron .`（tsup + build:web 产物），mac arm64，书架页闲置，`footprint` 工具 phys_footprint，2026-08-23 实测**）：

    | 进程 | phys_footprint |
    |---|---|
    | Main（含内嵌 studio server） | 55 MB（peak 59） |
    | GPU | 67 MB（peak 226） |
    | Renderer | 43 MB |
    | Network utility | 8.4 MB |
    | 合计 | ~173 MB |

  - 闲置 CPU：四进程 3 轮采样（间隔 5s）全部 0.0%（与 §1.1「动画静态化后已归零」一致）；
  - 口径注：§1.1 的 8-22 历史表（Main ~70 / GPU ~115 / Renderer ~83 / Network ~9，合计 ~277MB）与本轮实测形态不同日（GPU/Renderer 波动大），**批 U4 对账以本节 8-23 同形态实测为基线**。
- **批 U1：已完成（2026-08-23，提交 3ccd76f）**：
  - 落地：`server-boot.ts` 共享核心（U-3）+ `server-utility.ts` utility 入口（parentPort 握手，F-2）+ `server-manager.ts`（fork/serviceName/握手四路 settle/token 持久化与内存复用（U-6/F-5）/旧 child 清理/stopChild）+ main.ts 接线（S-4 换轨 + boot-error 对话框）+ `startServer` 可选 `studioToken`（唯一红线豁免）+ tsup entry + 测试四件（main 21→24 / server-manager 新 / server-boot 新 / boot-token +1）；
  - 门禁：tsc/vue-tsc 0 错 + vitest 339 文件/3063 全绿（+27）+ e2e 39 过 2 跳 + release-smoke 2 过（server-main 重构后 node 直跑全链路）+ check:counts（README 同步 3063/339）+ packaging + knowledge；
  - 实机验收（dev 未打包形态，mac arm64）：真实 fork→ready 握手→书架页 200；**node:sqlite utility 可用性首验过（R-1）**——books/events 读写正常；`--book` 直进 boot 回传 initialBook；**token 跨完整 app 重启不变 + 带注入 token 写请求 200 + 无 token 403**；退出零孤儿；
  - **R-7 网络栈对照过**：系统代理开启态（127.0.0.1:5858）`providers.test` 真实出呼，utility 形态 vs server-main node 直跑形态结果逐字一致（connected:true / 流式探测同文案「流结束无终止事件」系两形态共有的 provider/代理层现象、非 utility 漂移 / 延迟 0.23s vs 0.21s 同量级）；
  - 非正式资源观察（正式对账批 U4）：拆分后 dev 形态 Main ~40MB / utility child ~36MB（刚启动无会话态，书架页闲置）。
- **批 U2：已完成（2026-08-23，提交 `d49e2b1`）**：
  - 落地：server-manager `shutdown()`（指令下发 → shutdown-done 回执/自然 exit/2s 总超时三路竞速，settle.by 区分「回执到达让渡一拍等自然退出（优雅不 kill）」与「超时强杀 + 2s 收尸兜底」；幂等；停机结果留痕 info 优雅/warn 强杀——批 U3 崩溃归因同源；超时参数可注入保测试快）+ **S-5 互斥门**（shutdown/stopChild 主动停机置 shutdownStarted、每轮 start 复位——child exit 属预期不触发重启）+ server-utility 重构 `runUtilityEntry(parentPort, parsed)`（shutdown 指令 → `shutdownStudio(getWorkDir, server)` → `.catch` 吞错 `.finally` 回执 shutdown-done + exit(0)，收尾失败也回执不挂死）+ **stdio 日志单写者**（fork `stdio:'pipe'` + env 展开拷贝注入 `CLW_LOG_STDOUT=1` 不污染 main 自身；src/log initLogging 层短路（F-4：不设 logsDir/不 mkdir/不跑 7 天清理），emit 直写 stdout 同构 JSON 行；main 侧 `forwardChildStdio` 收行按 level/tag/msg 重发 logger 落盘，err `{name,message,stack}` 重建 Error 透传（F-3），坏行/level 不可辨识/字段残缺原文整行兜底，跨 chunk 半行缓冲拼装，stderr 整行 warn 进档取证；mirrorConsole 语义在 child 侧对齐：stdout-only 短路恒走 stdout 通道，--mirror-console 标志被忽略即无双写）+ main.ts before-quit 换 `serverManager.shutdown()`；
  - **用例调整如实记档**：S-5 门本批只置位、重启消费面在批 U3——「exit 不触发重启」与「退避计数复位（U-2 五分钟清零）」两类用例均无可观测行为面，随批 U3 重启逻辑一并落地（§五 批 U2 行的用例排期据此顺延）；
  - 门禁：tsc/vue-tsc 0 错 + vitest 340 文件/3078 全绿（+15：server-manager 11→19 / server-utility 新 5 / log +2）+ e2e 39 过 2 跳 + release-smoke 2 过 + check:counts（README 同步 3078/340）+ packaging + knowledge；
  - 实机验收（dev 未打包形态，mac arm64；R-2 双路径 + 单写者）：**单写者实证**——child 进程 env `CLW_LOG_STDOUT=1`、server 侧 tag（migrate-defaults 等）经 main 落盘 JSONL、同 ts 同 msg 零重复行、child 无日志文件打开；**正常退出**（AppleEvent quit）→ before-quit → shutdown 指令 → shutdown-done → JSONL 留痕「已停机（shutdown 指令链路）」→ 零孤儿；**强杀 main**（kill -9，另 SIGTERM 硬杀同验）→ child 随 Chromium/Mojo 父死检测消亡零孤儿、无优雅留痕（符合硬杀预期）；boot API 带注入 token 响应正常；被中断会话 session/end 落库由 shutdownStudio 既有单测回归全绿锚定，在途 SSE 长会话实机中断随批 U3 kill -9 演练一并留证。
- **批 U3：已完成（2026-08-23，提交 `57b6803`）**：
  - 落地：**退避自动重启**（U-2）——非主动停机 exit（wasActive 判真，迟到旧 exit 不误触发）→ 0/5s/15s 三档退避、3 次自动重启后再崩转 `onRestartExhausted` 封顶回调（'restart' 计数清零开新周期 / 'quit' 不再重启，缺省 quit 无接线不盲启）、ready 后稳定 5 分钟计数清零（S-9，计时回调校验 active 身份防垂死 child 误清）；**恢复链契约**（S-1/U-6）——重启复刻原参数面 + 钉住最近成功端口 + 同一内存 token（start 恒 '0'、重启传钉住值）；重启期握手失败（EADDRINUSE 残留等）按退避继续（§3.4 时序 3）；**S-5 三面取消**——shutdown/stopChild 置门 + cancelPendingRestart（等待窗口内退出不 fork 孤儿）+ 显式 start 换轮作废；launch 抽出共用（fork 面单源）；main.ts 封顶接线 `dialog.showMessageBoxSync`（重启服务/退出应用，选退出 app.quit）；
  - 批 U2 登记的 S-5 用例本批落地：shutdown / stopChild 双路径 exit 不重启（封 fork 数锚定）+ 退避等待窗口内 shutdown 作废挂起重启；
  - 门禁：tsc/vue-tsc 0 错 + vitest 340 文件/3087 全绿（+9：server-manager 19→27 / main 24→25 崩溃风暴接线 fake timers 快进）+ e2e 39 过 2 跳 + release-smoke 2 过 + counts（README 3087）+ packaging + knowledge；
  - **kill -9 实机演练**（dev 未打包形态 mac arm64，隔离临时书库不动真实数据）：建书写请求 #1（child1 同源+token 200）→ kill -9 child → **新 child 同端口 58072 重启（lsof 实证，JSONL 留痕 warn「异常退出 0ms 后自动重启（第 1/3 次）」→ info「已自动重启（端口 58072 钉住）」，全程 147ms）→ main 存活窗口存续 → 写请求 #2 同端口+同 token 再建书 200 → token 文件 md5 未变** → 正常退出零残留、workdir 恢复；serverOnline 灰→绿由前端既有心跳重连承接（同端口+同 token 恢复链为其前提；147ms 窗口短于心跳周期，灰态肉眼大概率不可见——如实记档，截图级确认不作为门）。
- **批 U4：已完成（2026-08-23，文档批无代码提交，HEAD `57b6803`）**：
  - **五件套收口**：tsc/vue-tsc 0 错 + vitest 340 文件/3087 全绿（U0 3036 → +51 净）+ e2e 39 过 2 跳 + release-smoke 2 过 + check:counts（README 同步 3087/340）+ packaging + knowledge——批 U1/U2/U3 各自门禁齐平（每批独立全绿后提交）；
  - **mac 四进程对账**（同 U0 形态：dev 未打包 `electron .`、真实 workdir 书架空闲置、`footprint` phys_footprint、启动后静置采样）：

    | 进程 | U0 基线（内嵌） | U4 拆分后 |
    |---|---|---|
    | Main | 55 MB（含内嵌 server） | **40 MB**（peak 43） |
    | GPU | 67 MB | 66 MB（peak 212，与 U0 peak 226 同族偶发） |
    | Renderer | 43 MB | 41 MB |
    | Network utility | 8.4 MB | 8.3 MB |
    | **studio-server utility（新单列）** | —（并入 Main） | **36 MB**（peak 37） |
    | 合计 | ~173 MB | ~191 MB |

    闲置 CPU：五进程 3 轮采样合计 0%（与 U0 一致）；**utility 单列实证**——`--utility-sub-type=node.mojom.NodeService` 独立 pid、独占 studio 端口（ps/lsof），serviceName `studio-server` 在 getAppMetrics 可辨识（S-12；运行时 API 无 CLI 查询面，以进程树实证代，如实记档）；
  - **资源口径如实记录（验收门 5）**：Main 瘦身 15MB（55→40，低于预测的 25-35MB 区间——server 逻辑本体实际占用小于预估）；**总账 +18MB，超「±15MB 持平口径」3MB**——超出来源为 utility 进程基座固有开销（第二份 Node/V8 运行时 + Chromium 进程 glue ≈ 36MB，其中仅 ~15MB 是自 Main 迁出的 server 本体），方案定位本就是**非内存方案**（作者拍板 A 方案时已知：买崩溃隔离与账目单列），不构成回滚事由；
  - **回滚验证（验收门 7）**：`git revert --no-commit 57b6803 d49e2b1 3ccd76f` 三批逆序回内嵌形态——server-boot/server-manager/server-utility 三文件消失、main.ts 无 serverManager 引用，tsc 0 错 + build:all 成功 + **vitest 337 文件/3036 全绿（与 U0 基线逐位一致）** + release-smoke 2 过；随后 `git reset --hard` 丢弃恢复拆分态（HEAD `57b6803`）并重建产物复验（desktop+log 105 用例绿）——回滚廉价性成立：通信面零改动使 revert 即完整内嵌形态；
  - **win 挂账**：批 U4 win 实测依赖阶段 21 批 J0（electron-builder win）/J4（CI win 腿），均未就绪——按方案 §五 预定挂账转阶段 21 尾部，不阻塞 mac 收口；
  - **验收七门走查**：①行为等价（e2e 39 过 2 跳/release-smoke 2 过/前端·preload·e2e spec 零改动——三批提交文件面仅 src/desktop、src/log、src/studio/server/index.ts（U-6 豁免）、tsup、tests、README）②时序等价（loadURL 用 ready 回传端口，main.test 锚定）③稳定性（kill -9 演练：147ms 同端口重启/写请求恢复，批 U3）④退出卫生（正常/强杀双路径零孤儿 + S-5 互斥用例，批 U2/U3）⑤资源口径（上表，总账超界 3MB 如实说明）⑥质量门（上）⑦回滚（上）——**全过，方案收口**。
- **2026-08-23 依方案评审修订**（报告：`Archive/主进程server拆分utilityProcess-方案评审-2026-08-23.md`（原 01-评审/，随二轮复核开评归档）§五 8 条全回填，S-1~S-13 逐项落点）：
  - S-1 重启端口复用：§3.1 端口/token 契约注 + §3.3 参数表 + §3.4 时序 3（含重启期 EADDRINUSE 走退避）+ 批 U3/验收 3 断言；
  - S-2 token 跨重启稳定 → 微决策 **U-6（建议 A：main 持久化注入 + startServer 可选参数 = 唯一红线豁免）**：§1.3 目标改写 + §2.3 豁免注 + §3.3 参数行 + §四 两行（server-manager/server index.ts）+ 验收 1/3；
  - S-3 日志落地机制：§3.5 重写（src/log stdout-only + main 解析重发、不 JSON 套 JSON）+ §四 src/log 行 + test/log 扩展行 + R-4 对策更新 + 批 U2 验收；
  - S-4 bootstrap-runner：§2.1 走读刷新（runner 存在 + 行号校准 + 退出链签名）+ §四 新增行 + main.ts 行接线注；
  - S-5 exit/重启互斥与握手轮次：§3.2「每 fork 一轮」建模 + §3.4 时序 3/4 互斥门 + §四 server-manager/测试行 + 批 U2 用例 + 验收 4/6；
  - S-6 引擎名 node:sqlite：§1.1/§1.2/R-1/批 U1 统一口径；总览阶段 22 行（两处）与任务清单批次 K 同步改（三处一致）；
  - S-7 utility 网络栈：R-7 新增 + 批 U1 开代理环境实测；
  - S-8 welcome 态 --dir 缺省：§3.3 参数行 + §四 server-boot 行 + 批 U1 验收；
  - S-9 退避计数复位：U-2 附 5 分钟清零 + 批 U2 用例；
  - S-10 书架页心跳盲区：§1.3/§2.2 书内口径 + §九 登记（不做，作者可取舍）；
  - S-11 e2e 表述：§2.3 校准（主套件 global-setup 进程内起 server，仅 release-smoke 跑 server-main.js）；
  - S-12 serviceName：§3.3 参数行 + §四 server-manager 行 + 验收 5；
  - S-13 快照对齐：§2.1 行号（369/242-251/362-365/336-425）+ §2.2 用例数（24——**二轮 F-1 更正为 21**：宽匹配 grep 误计 `emit(` 3 行，vitest 实测 21 passed）。

- **2026-08-23 同日二轮复核修订**（报告：`Archive/主进程server拆分utilityProcess-方案评审二轮-2026-08-23.md`；作者结论「可开工维持、开工前销 F-1/F-2、其余随批」——因均为文档级修订且互不冲突，本批一次性全销 F-1~F-6）：
  - F-1 用例数 24→21（三处：§2.2 / §四 / 本节 S-13 行）——一轮 S-13 的「24」系宽匹配 grep 把 3 行 `emit(` 误计；本轮 `npx vitest run test/desktop/main.test.ts` → 21 passed (21) + 精确计 `it(` = 21 亲验，历史锚点 5775f69 提交信息「首次接线 19 例」与演进 19→21 相符；
  - F-2 握手机制统一 parentPort：§3.2 重写传输机制（main 侧 `child.on('message')`/`child.postMessage` ↔ child 侧 `process.parentPort`，弃 MessageChannelMain 端口转移仪式）+ §四 server-manager 行对齐——原文 §3.2 与 §四 两套互斥机制系**初稿遗留、一轮评审漏检**（作者判「回填引入」不确，见二轮报告 §四 核验附记），矛盾本身成立；
  - F-3 转发 err 透传：§3.5 `log[level](tag, msg, err)`（行内无 err 字段不传第三参）+ ts 以 main 收行时刻重记的口径注明（原始时刻考古走行内原文兜底路径）；
  - F-4 stdout-only 短路上移 initLogging 层：§3.5 + §四 src/log 行（不设 logsDir/不 mkdir/不 cleanup——只挡 emit 会留 child 每次 fork 的文件系统副作用、与 main 双清同一 logs 目录）；
  - F-5 token 内存复用显式化：§3.3 token 行 + §四 server-manager 行「启动读入内存一次，fork 一律复用内存值」（任务清单 K1 同步）；
  - F-6 状态码 403 口径：六处 401→403（§2.2×2 / §3.1 / U-6×3）——服务端写闸 `server/index.ts:296` 与 SSE 闸 `stream.ts:220` 统一回 403 FORBIDDEN，client.ts:24/32 注释的「401」系该文件自身不精确表述。
