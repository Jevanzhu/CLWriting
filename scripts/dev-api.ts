#!/usr/bin/env node
/**
 * 独立启动 studio API server（无静态托管），供 Vite dev 代理。
 *
 * 用法：
 *   npx tsx scripts/dev-api.ts              # 自动找 workDir（cwd 向上）
 *   npx tsx scripts/dev-api.ts --dir /path   # 指定工作目录
 *
 * 端口：缺省值单源 = src/shared/contract/studio.ts 的 DEV_API_DEFAULT_PORT（web-next 的
 * Vite /api 代理目标与 SSE dev 直连基址同源消费）；可用环境变量 CLW_DEV_API_PORT 覆盖
 * （脚本与错误指引文案同源读，避免「改源码顶部常量」的死胡同）。
 *
 * 配合：
 *   npm run dev:web   # Vite HMR → http://localhost:5173（/api 代理到此 server）
 *
 * 退出：Ctrl+C 停 server。
 */
import { startServer } from '../src/studio/server/index.js'
import { resolveDevApiPort } from '../src/studio/server/dev-port.js'
import { findWorkDir } from '../src/install/books.js'
import { defaultUserDataPath } from '../src/fs/user-data-path.js'
import { parseStore } from '../src/desktop/workdir-store.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// 端口 env 单源——listen、banner、EADDRINUSE 指引全部从同一个解析结果取值。指引不可
// 写「改 scripts/dev-api.ts 顶部 PORT」：vite 代理目标取自跨包单源缺省（env 覆盖不会
// 同步过去），只经 env 改脚本端口 = dev 页面 /api 全 502 且无提示。
const PORT = resolveDevApiPort(process.env)

// --dir 参数
// 严格取参口径：`--dir --flag` 不得把下一个 flag 名吞作目录值（后续 findWorkDir /
// existsSync 会静默回落，错因不可见）。对齐 scripts/verify-responses-relay.ts argValue
// 的基准：值缺失 / 空串 / 以 `--` 开头一律按未传处理（null），回落 cwd 向上找 /
// 桌面端持久化书库。
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) return null
  const v = process.argv[i + 1]
  if (v === undefined || v === '' || v.startsWith('--')) return null
  return v
}
const explicitDir = argValue('--dir')

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

// dev Origin 白名单开关——server 生产态不再固定放行 5173，
// 仅本 dev server 显式开启（Vite 5173 页面经代理调 /api 时带该 Origin）
process.env['CLW_DEV_CORS'] = '1'

const server = startServer({ port: PORT, workDir, userDataPath })

// listen 失败（端口被占等）必须有 'error' 监听——EventEmitter 无监听的 error 事件直接
// 裸抛整段栈，开发者看到的是崩溃而非原因。补人话报错：EADDRINUSE 点名端口占用（最常见：
// 已有一个 dev-api 在跑），其余如实透传后退出。
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  ❌  端口 ${PORT} 已被占用（EADDRINUSE）——可能已有一个 dev-api 在跑。`)
    console.error(`     请先停掉占用进程（lsof -i :${PORT}），或设 CLW_DEV_API_PORT=<其他端口> 后重试；`)
    console.error(
      `     注意：Vite /api 代理目标取自跨包单源缺省（src/shared/contract/studio.ts 的 DEV_API_DEFAULT_PORT），`,
    )
    console.error(`     要整体换端口请改该单源（env 覆盖不会同步过去），否则 dev 页面连不上后端。`)
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
// 不变量：SIGINT/SIGTERM 都必须有强退兜底——`server.close(cb)` 对 SSE/keep-alive 长
// 连接会悬置回调（dev 页面开着 SSE 时 Ctrl+C 进程挂在信号上杀不掉）。形态搬
// src/desktop/server-main.ts 同款：exiting 幂等旗 + 2s 定时兜底强退；定时器 unref——
// close 顺利先到时不作为活跃句柄拖慢退出，幂等防双信号双触发。
// 兜底超时句柄用**模块级单槽**：原每个信号各排一个 2s timer 且不清旧，
// SIGINT+SIGTERM 连发（Ctrl+C 后补 kill / 进程管理器双信号）会叠两个等价兜底
//（exiting 幂等无害但句柄滞留、多排违 timer 纪律）。排前查重，已有在途兜底则跳过。
let exiting = false
let exitFallbackTimer: ReturnType<typeof setTimeout> | null = null
const exitNow = (): void => {
  if (exiting) return
  exiting = true
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n  ⏹  Stopping API server…')
    server.close(exitNow)
    // 已有在途兜底不重排（重复信号安全）；unref——close 顺利先到时不拖慢退出
    if (!exitFallbackTimer) {
      exitFallbackTimer = setTimeout(exitNow, 2_000)
      exitFallbackTimer.unref()
    }
  })
}
