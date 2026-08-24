import { rmSync } from 'node:fs'
import { defineConfig } from 'tsup'

// P-13（第十四轮）：只清 dist/desktop 子目录——本目录唯一写者是 tsup（两 config 均落此），
// 不触碰第二个 config 的 clean 竞争前提（clean 整个 dist/ 会删掉并发构建的 preload.cjs）。
// 清理历史 chunk 累积：clean:false 下旧 hash chunk 永久残留，且会被 files: dist/**/*
// 原样打进 DMG（发布物膨胀 + 排障时新旧 chunk 混淆）。配置加载期同步执行，早于产物发射。
rmSync('dist/desktop', { recursive: true, force: true })

export default defineConfig([
  {
    // 阶段 22 批 U1：server-utility 为 utilityProcess 子进程入口（server-manager fork
    // dist/desktop/server-utility.js；electron-builder files: dist 自动含）。
    // B-24（第六十轮补修）：export-worker 为导出内核 worker 线程独立入口——server
    // bundle 内联 run-async.ts 后以 import.meta.url 同伴解析 dist/desktop/
    // export-worker.js，必须与 server bundle 同目录独立成件（不随 bundle 内联）。
    // 对象形态钉死产物名：数组形态下 entry 公共根从 src/desktop 变 src/，全部产物
    // 会被挪进 desktop/、export/ 子目录（package.main / fork 路径全断）
    entry: {
      main: 'src/desktop/main.ts',
      'server-main': 'src/desktop/server-main.ts',
      'server-utility': 'src/desktop/server-utility.ts',
      'export-worker': 'src/export/export-worker.ts',
    },
    external: ['electron'], // electron 由 Electron 运行时提供,不 bundle
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    // 修正输出漂移（审查 §八⑩ 打包产物）：main entry 必须落 dist/desktop/ 与 package.main
    // 及 preload.cjs 同目录——此前默认输出到 dist/main.js，dist/desktop/main.js 停留在
    // f4501c4 的旧薄壳（引用已不存在的旧 chunk），dev:app/打包态跑的是重构前代码。
    outDir: 'dist/desktop',
    // 不 clean:多 config 数组下,clean 整个 dist/ 会与第二个 config(preload.cjs)构建竞争,
    // 时序不利时删掉刚构建的 preload.cjs → dev:app 报 PRELOAD-ENOENT。
    // 旧 chunk 残留由文件头 P-13 的 rmSync(dist/desktop) 在构建前统一清理（比 tsup
    // 内置 clean 更窄：只清本 config 的输出子目录，无跨 config 竞争面）。
    // tsup 默认加 nodeProtocolPlugin 剥离 `node:` 前缀（为兼容 Node <14.18，tsup#1003），
    // 会把 `node:sqlite` 改写成 bare `sqlite`，运行时 Node 去找不存在的 npm 包 `sqlite` 而崩。
    // 本项目门槛 Node ≥24，内置模块原生支持 `node:` 协议，保留前缀。
    removeNodeProtocol: false,
  },
  {
    // preload 必须是 CommonJS:Electron sandbox preload 用 require 加载,
    // 不支持 ESM(import 会报 "Cannot use import statement outside a module")。
    entry: ['src/desktop/preload.ts'],
    external: ['electron'],
    format: ['cjs'],
    target: 'node24',
    platform: 'node',
    outDir: 'dist/desktop',
    removeNodeProtocol: false,
  },
])
