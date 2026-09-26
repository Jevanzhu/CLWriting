import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

// 只清 dist/desktop 子目录——本目录唯一写者是 tsup（两 config 均落此），
// 不触碰第二个 config 的 clean 竞争前提（clean 整个 dist/ 会删掉并发构建的 preload.cjs）。
// 清理历史 chunk 累积：clean:false 下旧 hash chunk 永久残留，且会被 files: dist/**/*
// 原样打进 DMG（发布物膨胀 + 排障时新旧 chunk 混淆）。配置加载期同步执行，早于产物发射。
// 仅在非 watch 构建执行——`tsup --watch`（npm run dev）改配置触发
// restart 会重新加载本文件，此处的 rmSync 会把 dev 循环正在使用的 dist/desktop 产物连根
// 删掉；dev 态不清 stale chunk 无碍（残留只损发布物体积，发布走 build:desktop 全新构建，
// 不含 --watch，守卫不生效）。
// 清理路径 cwd 相对 → import.meta.url
// 绝对化（scripts/check-counts.mjs 同款口径，含 ^ 等特殊字符时 pathname 百分号编码由
// fileURLToPath 解码）——原 rmSync('dist/desktop') 依赖 cwd=项目根，从子目录直跑
// `npx tsup`（向上寻得本配置）时按 cwd 解析会删错位置。项目根正常路径下与原写法同义
//（零行为）。outDir 保持相对（tsup 自身按配置所在 cwd 解析，构建入口固定根目录）。
const desktopOutDir = fileURLToPath(new URL('./dist/desktop', import.meta.url))
if (!process.argv.includes('--watch')) {
  rmSync(desktopOutDir, { recursive: true, force: true })
}

export default defineConfig([
  {
    // server-utility 为 utilityProcess 子进程入口（server-manager fork
    // dist/desktop/server-utility.js；electron-builder files: dist 自动含）。
    // （补修）：export-worker 为导出内核 worker 线程独立入口——server
    // bundle 内联 run-async.ts 后以 import.meta.url 同伴解析 dist/desktop/
    // export-worker.js，必须与 server bundle 同目录独立成件（不随 bundle 内联）。
    // 对象形态钉死产物名：数组形态下 entry 公共根从 src/desktop 变 src/，全部产物
    // 会被挪进 desktop/、export/ 子目录（package.main / fork 路径全断）
    entry: {
      main: 'src/desktop/main.ts',
      'server-main': 'src/desktop/server-main.ts',
      'server-utility': 'src/desktop/server-utility.ts',
      'export-worker': 'src/export/export-worker.ts',
      // analyze-style 全书文风扫描 worker 线程独立入口（export-worker
      // 同款：server bundle 内联 style-scan-async.ts 后以 import.meta.url 同伴解析
      // dist/desktop/analysis-worker.js，必须与 server bundle 同目录独立成件）
      'analysis-worker': 'src/studio/server/api/analysis-worker.ts',
      // rebuild 内核 worker 线程独立入口——server bundle 内联
      // run-rebuild-async.ts 后以 import.meta.url 同伴解析 dist/desktop/
      // rebuild-worker.js，必须与 server bundle 同目录独立成件（同 export-worker）
      'rebuild-worker': 'src/cache/rebuild-worker.ts',
    },
    external: ['electron'], // electron 由 Electron 运行时提供,不 bundle
    // rc.0 发布：dependencies 三件必须强制内联——tsup/esbuild 缺省把 package.json
    // dependencies 全部外置（external:['electron'] 只管显式清单，管不到隐式 deps 外置），
    // 产物因此留下裸 import '@anthropic-ai/sdk'/'openai'/'font-list'；而 electron-builder
    // files '!node_modules/**' 已把 node_modules 排除出 asar（前提是
    // 「tsup 全量 bundle、运行时零裸包解析」——该前提被隐式外置打破），打包态 ESM link
    // 即抛 ERR_MODULE_NOT_FOUND：server-utility 子进程秒崩×3 → 「服务异常」错误框 → 无窗
    // 挂死（v1.0.0-rc.0 发版实录）；main 侧 ipc.ts 的 font-list 裸导入同病（App
    // Translocation 态主进程未捕获异常实录）。dev 能跑是仓库根有 node_modules，CI 打包态
    // 冒烟假绿是 .app 躺在 workspace dist-electron/ 下、解析沿文件路径向上摸到仓库
    // node_modules——装进 /Applications / 从 dmg 挂载卷运行必死。font-list 内联后
    // __dirname 指向本目录的二进制同伴拷贝（onSuccess）设计随之成真。
    noExternal: ['@anthropic-ai/sdk', 'openai', 'font-list'],
    // rc.0 发布·font-list 特例：其 ESM 壳 index.mjs 是 createRequire 运行时
    // require('./libs/core')（相对 import.meta.url）——esbuild bundle 后该路径指向
    // dist/desktop/、libs/ 不在，裸 noExternal 内联会在模块顶层抛 MODULE_NOT_FOUND
    // （连 dev 一起碎，本批实证）。alias 钉到 CJS 入口 index.js 走 esbuild 原生 CJS
    // 静态内联；内联后其内部 path.join(__dirname, 'fontlist') 的 __dirname 即本产物
    // 目录，与下方 onSuccess 的 darwin 二进制同伴拷贝正好对齐。
    esbuildOptions: (options) => {
      options.alias = {
        'font-list': fileURLToPath(new URL('./node_modules/font-list/index.js', import.meta.url)),
      }
      // font-list CJS 内联后的运行时垫片——esbuild ESM 输出既不提供自由变量
      // __dirname（本批实证：仅剩使用点、零定义，darwin 枚举 path.join(__dirname,
      // 'fontlist') 运行时即 ReferenceError），也让内联 CJS 的 require 走 __require
      // 垫片、在无 require 的 ESM 顶层抛 "Dynamic require of path is not supported"
      // （dev 示踪实录：font-list/libs/darwin require('path') 即炸、主进程模块求值
      // 未捕获异常 → Electron 默认错误对话框模态挂起）。banner 顶层 var 与 wrapper
      // 同模块作用域词法可见；__dirname 随产物自身位置推导（dev = dist/desktop，
      // 打包态 = app.asar/dist/desktop——execFile 走 Electron asar 补丁可执行，自管
      // spawn 路径另有 asarUnpack 外置，两路均在位）；require = createRequire 同位
      // 推导，node 内建模块经它解析。
      options.banner = {
        js: `import { fileURLToPath as __clwUrl2Path } from 'node:url';import { dirname as __clwPathDirname } from 'node:path';import { createRequire as __clwCreateRequire } from 'node:module';var __dirname = __clwPathDirname(__clwUrl2Path(import.meta.url));var require = __clwCreateRequire(import.meta.url);`,
      }
    },
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    // 修正输出漂移（审查 §八⑩ 打包产物）：main entry 必须落 dist/desktop/ 与 package.main
    // 及 preload.cjs 同目录——此前默认输出到 dist/main.js，dist/desktop/main.js 停留在
    // f4501c4 的旧薄壳（引用已不存在的旧 chunk），dev:app/打包态跑的是重构前代码。
    outDir: 'dist/desktop',
    // 不 clean:多 config 数组下,clean 整个 dist/ 会与第二个 config(preload.cjs)构建竞争,
    // 时序不利时删掉刚构建的 preload.cjs → dev:app 报 PRELOAD-ENOENT。
    // 旧 chunk 残留由文件头的 rmSync(dist/desktop) 在构建前统一清理（比 tsup
    // 内置 clean 更窄：只清本 config 的输出子目录，无跨 config 竞争面）。
    // tsup 默认加 nodeProtocolPlugin 剥离 `node:` 前缀（为兼容 Node <14.18，tsup#1003），
    // 会把 `node:sqlite` 改写成 bare `sqlite`，运行时 Node 去找不存在的 npm 包 `sqlite` 而崩。
    // 本项目门槛 Node ≥24，内置模块原生支持 `node:` 协议，保留前缀。
    removeNodeProtocol: false,
    // mac fontlist 原生二进制随包
    // 分发——font-list 上游按 path.join(__dirname,'fontlist') execFile，bundle 后
    // __dirname 指向 dist/desktop，二进制必须落 bundle 同目录（此前打包态恒 ENOENT，
    // 字体枚举回落 system_profiler 慢路径，慢机触 10s 超时连败熔断、下拉返空）。
    // 仅 darwin：win 走 win-fonts 自绘枚举、linux fc-list 是系统命令，均无随包二进制
    // （非 darwin 腿不拷，check-packaging 门同口径只查 darwin）。copyFileSync 保留
    // 可执行位（libuv uv_fs_copyfile 保 mode）；源缺失（依赖安装不完整）ENOENT 裸抛
    // 红构建，不静默跳过（静默跳过 =原样回潮）。watch 模式每次重建后重拷，
    // 幂等。
    // 两端路径 import.meta.url
    // 绝对化——上批只绝对化了文件头 rmSync，本处 copyFileSync 仍是 cwd 相对
    // （Node 原生调用按 process.cwd 解析），同场景（子目录直跑 `npx tsup`）会 ENOENT
    // 红构建或拷错位置；项目根正常路径下与原写法同义（零行为）。
    onSuccess: async () => {
      if (process.platform !== 'darwin') return
      copyFileSync(
        fileURLToPath(new URL('./node_modules/font-list/libs/darwin/fontlist', import.meta.url)),
        fileURLToPath(new URL('./dist/desktop/fontlist', import.meta.url)),
      )
    },
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
