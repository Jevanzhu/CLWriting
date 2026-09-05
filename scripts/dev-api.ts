#!/usr/bin/env node
/**
 * 独立启动 studio API server（port 7878，无静态托管），供 Vite dev 代理。
 *
 * 用法：
 *   npx tsx scripts/dev-api.ts              # 自动找 workDir（cwd 向上）
 *   npx tsx scripts/dev-api.ts --dir /path   # 指定工作目录
 *
 * 配合：
 *   npm run dev:web   # Vite HMR → http://localhost:5173（/api 代理到此 server）
 *
 * 退出：Ctrl+C 停 server。
 */
import { startServer } from '../src/studio/server/index.js'
import { findWorkDir } from '../src/install/books.js'
import { defaultUserDataPath } from '../src/fs/user-data-path.js'
import { parseStore } from '../src/desktop/workdir-store.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const PORT = 7878

// --dir 参数
const dirIdx = process.argv.indexOf('--dir')
const explicitDir = dirIdx !== -1 && dirIdx + 1 < process.argv.length ? process.argv[dirIdx + 1] : null

const userDataPath = defaultUserDataPath()

/**
 * 兜底定位：桌面端持久化书库（userData/workdir.json 的 current）。
 * dev:api 常从项目根目录启动，而书库未必在项目树内——cwd 向上找不到
 * .clwriting/ 时，回落到与 dev:app/桌面版同一份书库记录，保证 HMR 链路
 * 与桌面端看到的是同一书库（与 src/desktop/main.ts 的启动定位口径一致）。
 */
function storedWorkDir(): string | null {
  const fp = join(userDataPath, 'workdir.json')
  if (!existsSync(fp)) return null
  try {
    const store = parseStore(readFileSync(fp, 'utf-8'))
    return store.current && existsSync(store.current) ? store.current : null
  } catch {
    return null
  }
}

// 优先级：--dir 显式指定 > cwd 向上找 > 桌面端持久化书库
const workDir = explicitDir ?? findWorkDir(process.cwd()) ?? storedWorkDir() ?? undefined

// RB-SV-P1-1：dev Origin 白名单开关——server 生产态不再固定放行 5173，
// 仅本 dev server 显式开启（Vite 5173 页面经代理调 /api 时带该 Origin）
process.env['CLW_DEV_CORS'] = '1'

const server = startServer({ port: PORT, workDir, userDataPath })

// X-22（第五十六轮）：listen 失败（端口被占等）此前无 'error' 监听——EventEmitter
// 无监听的 error 事件直接裸抛整段栈，开发者看到的是崩溃而非原因。补人话报错：
// EADDRINUSE 点名端口占用（最常见：已有一个 dev-api 在跑），其余如实透传后退出。
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  ❌  端口 ${PORT} 已被占用（EADDRINUSE）——可能已有一个 dev-api 在跑。`)
    console.error(`     请先停掉占用进程，或修改 scripts/dev-api.ts 顶部 PORT 后重试。`)
  } else {
    console.error(`  ❌  API server 启动失败：${err.message}`)
    console.error(err)
  }
  process.exit(1)
})

server.on('listening', () => {
  console.log()
  console.log(`  🚀  API server ready  →  http://127.0.0.1:${PORT}`)
  console.log(`  📁  workDir: ${workDir || '未定位（书架为空）'}`)
  console.log(`  🎨  Vite dev:  npm run dev:web  →  http://localhost:5173`)
  console.log()
})

// 优雅退出
// 重评-25（全库代码重评审 2026-09-05）：此前 SIGINT 只 `server.close(() => exit(0))`
// 无兜底——close 对 SSE/keep-alive 长连接会悬置回调（graceful-shutdown 同因，M-8 判例），
// dev 页面开着 SSE 时 Ctrl+C 进程挂在信号上杀不掉。搬 src/desktop/server-main.ts 的
// M-8 同款：exiting 幂等旗 + 2s 定时兜底强退；定时器 unref——close 顺利先到时不作为
// 活跃句柄拖慢退出，幂等防双信号双触发。
let exiting = false
const exitNow = (): void => {
  if (exiting) return
  exiting = true
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n  ⏹  Stopping API server…')
    server.close(exitNow)
    const t = setTimeout(exitNow, 2_000)
    t.unref()
  })
}