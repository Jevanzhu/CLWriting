# CLWriting Electron 桌面化方案 v0.1

> **状态**：方案确认，进入实施（2026-06-24）。**做好桌面版再发版**（跳过 v1.0.0 server+浏览器版）。
> **关联**：母本 `clwriting-gui-方案.md`（server+浏览器版，保留作开发/降级）。

## 1. 定位

把现有 server+浏览器 GUI 桌面化为 **Electron 应用**，分发给网文作者（自带 Node + Chromium 运行时，不依赖系统浏览器）。GUI 是壳，大脑仍是 claude CLI——**架构红线不变**（不直连大模型，主进程 spawn claude）。

## 2. 架构（最大复用）

```
Electron 应用（dmg / exe / AppImage）
├── 主进程（Node，Electron 内置）
│   ├── BrowserWindow（窗口 + 生命周期）
│   └── startServer() ← 复用 src/studio/server（127.0.0.1:port）
│       └── spawn claude CLI ← 复用 src/driver
└── 渲染进程（Chromium）
    └── loadURL('http://127.0.0.1:port') ← 复用 dist/web（Vue 零改造）
```

- **零改造复用**：`src/studio/server` + `src/studio/web` + `src/driver` + 全部业务逻辑（8 节功能、727 测）
- **新增**：`src/desktop/main.ts`（主进程入口，~100 行）+ `preload.ts`（安全）+ `electron-builder` 配置

## 3. 决策

1. **发版**：做好 Electron 再发（跳过 v1.0.0 浏览器版）
2. **首版 unsigned**（省 $99/年 mac 开发者账号；首次启动手动信任）
3. **首版无自动更新**（后续 electron-updater + GitHub Release）
4. **studio 命令保留**（开发/降级，server+浏览器）
5. **安全**：`contextIsolation: true` / `sandbox: true` / `nodeIntegration: false`
6. **claude CLI 门槛保留**（用户装 claude + 订阅；架构红线决定，不可避免）

## 4. 风险

✅ **node:sqlite 已验证可用**（Electron 42.5.0 内置 Node v24.17.0，smoke 建表/插入/查询全过）。风险消除，不用换 better-sqlite3。

## 5. 工作计划

1. ✅ **装 Electron 42.5.0 + node:sqlite smoke 通过**（Node 24，建表/查询全过）
2. ✅ `src/desktop/main.ts`（startServer + BrowserWindow + loadURL，复用 server）+ `api/cli.ts` 双模式 spawn（Electron 用 ELECTRON_RUN_AS_NODE）
3. ✅ `electron-builder.yml` + `dev:electron`/`build:desktop`/`build:desktop:dir` + Mac dir 打包 + .app 运行 smoke 通过
4. ✅ CI `desktop.yml`（三平台 matrix，手动/tag v* 触发）
5. 发版流程（tag + GitHub Release + dmg/exe/AppImage）

## 6. 目录

```
src/desktop/          新增（Electron 壳）
├── main.ts           主进程：起 server + BrowserWindow loadURL
└── preload.ts        contextBridge（安全隔离）
electron-builder.yml  打包配置
src/studio/           复用（server + web，不动）
```

## 7. 为什么选 Electron（非 Tauri/Flutter）

- **driver 零改造**：claude CLI 通讯（spawn + stream-json + GLM quirks）是 Node `cc.ts`，PoC 验证过；Electron 主进程直接复用，Tauri 要 Rust 重写重新踩坑
- **ECharts/CodeMirror 直接用**：web 独有成熟生态，Flutter/原生无等价物
- **跨平台一致**：Chromium 三平台一致
- 代价：包体 ~150MB（可接受，VS Code ~300MB）
