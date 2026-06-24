# 桌面版工作目录（书库）选择与管理方案 v0.1

> **状态**：✅ 实施完成（批1-5，2026-06-25）。打包态选库/切换/建库 smoke 全通过；752 测 + vue-tsc 全绿。
> **关联**：母本 `electron-方案.md`（桌面化第一阶段）、`clwriting-gui-方案.md`（GUI 壳）。
> **分支**：`feat/electron`（PR #7 之上继续）。

---

## 1. 问题

桌面版双击 `.app` 启动时 `process.cwd()` = `/`（或 app bundle 内部路径），`findWorkDir(cwd)` 返回 `null`，书架永远空态。三个缺口叠加：

| 缺口 | 现状 | 影响 |
|------|------|------|
| **不能选** | workDir 仅来自 `findWorkDir(process.cwd())`（`main.ts:28`） | 双击启动拿不到书库 |
| **不记忆** | 无任何持久化 | 每次启动都要重新定位 |
| **不能换** | workDir 启动时闭包进全部 28 个路由（`index.ts:39-58`），运行时定死 | 换书库须退出重开 |

Electron 桌面版**独有**原生目录选择器 `dialog.showOpenDialog`，正是补缺利器。浏览器版用 CLI `--workdir` 参数对齐（决策④）。

---

## 2. 探查发现的关键约束（设计依据）

四路并行探查的硬约束，直接决定方案架构：

### 2.1 🔴 server 路由层是模块级单例 —— 运行时"重启 server"不可行

- `src/studio/server/router.ts:26` —— `const routes: Route[] = []`，模块级数组，**只增不清**。
- `src/studio/server/index.ts:34` —— `let routesRegistered = false`，**首次注册后永久短路**（`ensureRoutes` 第 38 行 `if (routesRegistered) return`）。
- **后果**：第二次 `startServer(新workDir)` 传的新 workDir 进不了任何 handler —— 所有路由闭包锁死**第一次**的 workDir。新 server 监听新端口，API 仍读写旧目录。
- **附带风险**：`server.close()` 不会主动断开 SSE 长连接（`api/stream.ts` 的 SSE 是长连接），会卡到 keep-alive 自然结束（可能永不），且 driver（spawn claude）子进程不释放。

> **结论**：要支持运行时切换工作目录，要么重置 router 单例 + 主动清理 SSE/driver（改动面大、风险高），要么**进程级重启**。本方案选后者。

### 2.2 🟢 workDir 不必"已含 .clwriting/" —— 建书引导闭环

- `doInit`（`src/install/init.ts:54-113`）是唯一入口，**同时建工作目录 + 第一本书**：`scaffoldWorkDir`（`init.ts:116-123`，幂等 `mkdirSync(.clwriting, recursive:true)`）+ `scaffoldBookRepo` + `appendBook`/`writeActive`。
- **关键洞察**：`startServer({ workDir })` 接受任意目录路径；`readBooks(workDir)` 在无 `books.jsonl` 时返回 `[]`（不崩，书架空态）；用户点新建 → `doInit(workDir)` 在该目录顺带产出 `.clwriting/`。
- GUI `POST /api/books`（`api/books.ts:42-45`）的 `if (!ctx.workDir) return 400` 拦的是 **null**，不是"无 .clwriting"。只要主进程把"用户选的目录"当 workDir 传入（非 null），建书端点即可放行，`doInit` 顺带建库。
- **不存在**"只建工作目录不建书"的独立函数（`scaffoldWorkDir` 私有未 export）。本方案**不新增** `ensureWorkDir`（YAGNI）——引导直接进建书向导，一步到位。

### 2.3 🟢 preload 不存在、纯 HTTP 通信

- `src/desktop/` 下**只有 `main.ts`**，无 `preload.ts`，无任何 IPC（全项目零 `ipcRenderer`/`contextBridge`）。
- 渲染进程靠 `fetch http://127.0.0.1:{port}/api/...`（`main.ts:15-29` 包装 fetch 注入 token）。
- 书架空态两处（`Bookshelf.vue:66-73`）：`!workDir`（未定位，文案"请在 CLWriting 工作目录下启动 studio"）+ `books.length===0`（暂无书籍）。
- 书架头部 `Bookshelf.vue:58-62` 有「+ 新建」按钮，可并列放「📁 打开书库」。
- 无应用级菜单/工具栏组件。

### 2.4 🟢 `--workdir` 注入点清晰

`studio-cli.ts` 手写 argv 解析（无第三方库），`--workdir` 照抄 `--book`（`studio-cli.ts:43-49`）写法即可，单文件 5 处改动（见 §6.4）。

---

## 3. 方案架构

**核心思路**：workDir 持久化在 `userData`；桌面版启动读它作为 server 的 workDir；切换书库 = 改持久化值 + `app.relaunch()` 进程重启。

```
┌─ 桌面版启动 (main.ts bootstrap) ──────────────────────────┐
│  1. 读 userData/workdir.json { current, recent }           │
│  2. current 有效(存在目录) → workDir = current              │
│     current 失效/无     → 弹 dialog.showOpenDialog 选目录   │
│  3. 选完: 含 .clwriting → 直接用; 不含 → 二次确认"在此新建" │
│  4. 持久化 current + 更新 recent 列表                       │
│  5. startServer({ workDir }) → loadURL                      │
└────────────────────────────────────────────────────────────┘

┌─ 运行时切换 (决策①) ──────────────────────────────────────┐
│  渲染层 → preload API openLibrary() / switchLibrary(path)  │
│     → 主进程 IPC: 写 workdir.json current=path             │
│     → app.relaunch() + app.exit()                          │
│     → 重启回到上面启动流程,读新 current                     │
│  (规避 §2.1 路由单例 + SSE 泄漏; 低频操作,1-2s 重启可接受)  │
└────────────────────────────────────────────────────────────┘

┌─ 决策② 选到非书库目录 ────────────────────────────────────┐
│  showOpenDialog 选了 X(无 .clwriting)                      │
│     → 提示"X 还不是书库目录,要在这里新建吗?"                │
│     → 确认 → current=X 持久化 → relaunch                    │
│     → 启动 workDir=X(书架空态) → 引导进建书向导             │
│     → doInit(X, 书名...) 顺带建 .clwriting + 第一本书       │
└────────────────────────────────────────────────────────────┘
```

### 3.1 为什么 relaunch 而非重启 server

| 维度 | 重启 server | 进程 relaunch ✅ |
|------|------------|-----------------|
| 路由单例（§2.1） | 需新增 `clearRoutes`+`resetRoutes`，破坏 730 测试模型 | 天然规避 |
| SSE/driver 泄漏 | 需主动断连 + interrupt，易错 | 进程退出全清 |
| server 契约 | 要改 `index.ts`/`router.ts` | **零改** |
| 测试影响 | 730 测试受波及 | 不碰 |
| 用户体验 | 无感切换（同窗口） | 重启 1-2s（窗口闪） |

切换书库是"书库级"低频操作（不是切书），1-2s 重启代价 << 改 server 层的风险。**选 relaunch**。

---

## 4. 四个决策点的落地

### 决策① 运行时切换（已确认）

- 渲染层书架头部「📁 打开书库」按钮 + 「最近书库」下拉 → 调 preload API → 主进程 IPC → relaunch。
- 见 §3 架构图第二块。

### 决策② 非书库目录：先提示，确认后引导建书（已确认）

- showOpenDialog 选完，主进程检查 `existsSync(join(dir, '.clwriting'))`。
- 含 `.clwriting` → 直接采用。
- 不含 → `dialog.showMessageBox` 二次确认「X 还不是书库目录（不含 .clwriting/）。要在这里新建吗？」
  - **确认** → current=X 持久化 → relaunch → 启动后 workDir=X（空态）→ 前端检测"空工作目录"引导进建书向导（BookNew 段1）。
  - **取消** → 回到选择器 / 回退上次。
- 不新增 `ensureWorkDir`：建库由建书向导的 `doInit` 顺带完成（§2.2）。

### 决策③ 多数库切换（已确认）

持久化结构 `userData/workdir.json`：

```json
{
  "current": "/abs/path/to/library-A",
  "recent": [
    { "path": "/abs/path/to/library-A", "label": "library-A" },
    { "path": "/abs/path/to/library-B", "label": "library-B" }
  ]
}
```

- 启动读 `current`；切换写入 `current` 并把旧 current 推入 `recent`（去重，保留最近 5 个）。
- 渲染层「最近书库」下拉读 `recent`（经 preload API `getRecentLibraries()`）。
- `label` 取目录 basename；`recent` 项点击 = switchLibrary(path)。

### 决策④ 浏览器版 `--workdir` 对齐（已确认）

`clwriting studio --workdir <路径>`：见 §6.4 单文件改动。桌面版/浏览器版定位手段一致（一个走 IPC+持久化，一个走 CLI 参数），workDir 注入 `startServer` 的下游链路完全共用。

---

## 5. 桌面版与浏览器版能力矩阵

| 能力 | 桌面版 | 浏览器版 |
|------|--------|----------|
| 定位 workDir | userData 持久化 → 弹选择器 | `--workdir` 参数 / cwd 上溯 |
| 切换书库 | 「打开书库」按钮 + 最近列表 → relaunch | 退出重开 + 换 `--workdir` |
| 非书库目录建库 | 二次确认 → 引导建书向导 | `--workdir X` 后同（doInit 顺带建） |
| 最近列表 | ✅（userData 持久化） | ❌（终端无状态） |

前端通过检测 `window.clwritingDesktop` 是否存在，决定渲染桌面入口（按钮/最近列表）还是隐藏。

---

## 6. 文件改动清单

### 6.1 新增 `src/desktop/workdir-store.ts`

userData 持久化读写（纯函数，可单测）：

- `readStore(): { current: string|null, recent: RecentItem[] }` —— 读 `userData/workdir.json`，缺失/损坏返回 `{ current: null, recent: [] }`。
- `writeCurrent(path: string): void` —— 写 current + 推 recent（去重，截断 5 条）。
- `getRecent(): RecentItem[]`
- 路径：`app.getPath('userData')` + `/workdir.json`，原子写（复用内核 `atomicWriteFile`）。
- 校验：写入前 `existsSync` 确认目录存在；recent 项启动时过滤已失效路径。

### 6.2 新增 `src/desktop/preload.ts`

`contextBridge.exposeInMainWorld('clwritingDesktop', {...})`，最小 API：

- `openLibrary(): Promise<{path, created} | null>` —— 触发 showOpenDialog + 非书库确认（决策②）。返回选定路径；用户取消返回 null。
- `switchLibrary(path: string): Promise<void>` —— 切换到指定路径（来自最近列表），主进程写持久化 + relaunch。
- `getRecentLibraries(): Promise<RecentItem[]>` —— 读最近列表。
- `getCurrentLibrary(): Promise<string | null>` —— 当前 workDir（供前端显示）。

### 6.3 改造 `src/desktop/main.ts`

- `webPreferences` 加 `preload: path.join(__dirname, 'preload.js')`。
- `bootstrap()` 启动流程：readStore → 无 current 则调 openLibrary 选择器逻辑 → 持久化 → `startServer({ workDir })`。
- 注册 IPC handler（`ipcMain.handle`）：`desktop:open-library` / `desktop:switch-library` / `desktop:get-recent` / `desktop:get-current`。
- 切换 handler 内：writeCurrent → `app.relaunch(); app.exit(0)`。
- 加原生应用菜单（`Menu.buildFromTemplate`）：「文件 → 打开书库目录… / 最近书库 / 退出」。
- 启动若 current 失效且用户取消选择 → 显示空态窗口（不 quit），书架引导选库。

### 6.4 改 `src/studio/server/studio-cli.ts`（决策④，单文件 5 处）

| # | 位置 | 改动 |
|---|------|------|
| 1 | `StudioArgs` 接口（`:21-24`） | 加 `workdir?: string` |
| 2 | `parseArgs`（`:43-49` 后） | 加 `else if (a === '--workdir')` + `else if (a.startsWith('--workdir='))`（`.slice(10)`） |
| 3 | `:138` | `findWorkDir(process.cwd())` → `findWorkDir(args.workdir ?? process.cwd())` |
| 4 | `:146` 后（可选） | 日志反馈 `--workdir` 生效路径 |
| 5 | `:2` 注释 + `cli.ts:189` help | 补 `--workdir <路径>` 用法 |

### 6.5 改前端 `src/studio/web/src/pages/Bookshelf.vue`

- 检测 `window.clwritingDesktop`：存在则渲染桌面入口。
- 书架头部加「📁 打开书库」按钮（调 `clwritingDesktop.openLibrary()`）。
- 「最近书库」下拉（调 `getRecentLibraries()`，点击 `switchLibrary`）。
- `!workDir` 空态文案从"在工作目录启动 studio"改为「📁 选择书库目录」按钮（桌面版）。
- 新增 `.d.ts` 声明 `window.clwritingDesktop` 类型。

> **浏览器版**：`window.clwritingDesktop` 不存在 → 不渲染桌面入口 → 仍用 `--workdir`/cwd 路径，行为不变。

---

## 7. 工作计划（分批，每批可独立验证）

1. **批1 · 持久化 + CLI 对齐**（无 UI 依赖，纯逻辑）
   - `workdir-store.ts`（新增 + 单测）
   - `studio-cli.ts --workdir`（决策④ + 测试）
   - 验证：`clwriting studio --workdir <path>` 定位正确；store 读写/去重/截断。

2. **批2 · 桌面主进程 + IPC**
   - `preload.ts`（新增）+ `main.ts` 改造（启动流程 + IPC handler + relaunch + 菜单）
   - 验证：`dev:electron` 启动弹选择器 → 选含 .clwriting 目录 → 书架显示该书库；切最近 → relaunch 到新书库。

3. **批3 · 决策② 非书库目录引导**
   - showOpenDialog 选非书库目录 → 二次确认 → relaunch workDir=X → 前端引导建书
   - 验证：选空目录 → 确认 → 启动空态 → 建书向导 → `doInit` 产出 `.clwriting/` + 第一本书。

4. **批4 · 前端入口 + 最近列表 UI**
   - `Bookshelf.vue` 桌面入口 + 最近下拉 + 空态文案
   - 验证：浏览器版（无 preload）不渲染桌面入口；桌面版渲染且功能通。

5. **批5 · 打包态实测**
   - `build:desktop:dir` 出 .app → 双击启动走完整选库/切换流程（验证 `process.cwd()` 问题在打包态确实被解决）。

---

## 8. 测试策略

| 层 | 测点 | 工具 |
|----|------|------|
| `workdir-store` | 读写/去重/截断/损坏容错/失效路径过滤 | vitest 单测 |
| `studio-cli --workdir` | 参数解析/空值/等号形式/findWorkDir 校验 | vitest（parseArgs 纯函数） |
| preload API | mock ipcMain/dialog 验证契约 | vitest（mock electron） |
| e2e | 选库 → 切换 → 非书库建库引导（mock driver） | Playwright（扩 `smoke.spec.ts`） |
| 打包态 | .app 双击选库全流程 | 手动 smoke |

> 不碰 server/router 层 → 现有 730 测试零回归风险。

---

## 9. 风险

| 风险 | 缓解 |
|------|------|
| relaunch 在某些平台行为差异 | Mac 优先验证（主开发机）；Win/Linux CI 覆盖 |
| userData 路径权限 | `app.getPath('userData')` 是 Electron 标准可写目录 |
| 持久化文件损坏 | `readStore` 容错（JSON.parse 失败 → 空态重选） |
| 用户误把重要目录当书库 | 决策②二次确认 + `.clwriting` 标志检查 |
| 前端类型缺失 | 加 `window.clwritingDesktop` 的 `.d.ts` |

---

## 10. 不做（YAGNI）

- ❌ `ensureWorkDir`（只建工作目录不建书）—— doInit 一步到位够用。
- ❌ 运行时热切换 server —— relaunch 更稳（§3.1）。
- ❌ 浏览器版最近列表 —— 终端无状态，`--workdir` 够用。
- ❌ 书库加密/多账号 —— 超出当前范围。
