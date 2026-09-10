#!/usr/bin/env node
/**
 * R0910-W（2026-09-10）：Electron 集成冒烟（PR/push CI 用）。
 *
 * 背景：产品是 Electron 桌面应用，但 ci.yml 的 e2e job 只跑 Playwright + web 包 +
 * mock driver，从不启动 Electron 壳；唯一 Electron 覆盖是 desktop.yml 的 25s 存活
 * 冒烟（仅 tag 推送触发）。PR/push 门因此漏掉真实崩溃——如 src/desktop/main.ts 的
 * closed 清理监听在销毁态 webContents 上抛错、令退出链短路（关窗即退）的真实缺陷。
 *
 * 契约（与 src/desktop/main.ts 的 CLW_SMOKE_WINDOW_CYCLE 钩子硬绑定，勿改串）：
 * - 以 CLW_SMOKE_WINDOW_CYCLE=1 启动 → 真实建窗（createSecureWindow）→ 关窗
 *   → 打印 `[CLW_SMOKE] window-cycle-ok` 并 exit 0；
 * - uncaughtException → 打印 `[CLW_SMOKE] crash <message>`；
 * - 关窗链被炸穿 → 打印 `[CLW_SMOKE] window-cycle-timeout` 并非零退出。
 *
 * 本驱动只做四件事：起进程、捕获 stdout/stderr、等 window-cycle-ok（有界 60s）、
 * 失败/超时即带日志尾失败。它**不自建**任何产物（dist 须由调用方先 build:all——
 * ci.yml e2e job 的 release-smoke 步已在同 job 产出 dist）。不依赖 studio server
 * 启动：等待的是窗口循环标记，不 grep 服务就绪串。
 *
 * 跨平台：Windows 用 taskkill /T /F 杀进程树（无 POSIX 负 pid 信号）；POSIX 走
 * detached 进程组 + kill(-pid)。退出码 0 仅当观察到 window-cycle-ok。
 *
 * 跑：node scripts/electron-smoke.mjs（CI 侧经 xvfb-run -a 包裹）。
 * 可调：CLW_SMOKE_TIMEOUT_MS（默认 60000）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const OK_MARKER = '[CLW_SMOKE] window-cycle-ok'
const CRASH_MARKER = '[CLW_SMOKE] crash'
const TIMEOUT_MARKER = '[CLW_SMOKE] window-cycle-timeout'
const FAIL_MARKER = '[CLW_SMOKE] window-cycle-fail'

const TIMEOUT_MS = Number(process.env['CLW_SMOKE_TIMEOUT_MS']) || 60_000
/** 日志保留尾长（失败时打印现场；限长防 CI 日志被巨量输出淹没）。 */
const TAIL_CHARS = 8_000

// 产物前置门：main 入口缺失时 Electron 只会抛原生错误，先给可读指路（CI 里 dist 由
// 同 job 的 release-smoke 步 build:all 产出；纯冒烟驱动不自建）。
const mainEntry = (() => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).main
  } catch {
    return null
  }
})()
if (!mainEntry || !existsSync(join(root, mainEntry))) {
  console.error(
    `[electron-smoke] 未找到应用入口 ${mainEntry ?? '(package.json.main 缺失)'}——先跑 npm run build:all 生成 dist 再冒烟。`,
  )
  process.exit(1)
}

// headless Linux（CI/root）下 Chromium 沙箱不可用（无 SUID helper / 无用户命名空间），
// 会以 "SUID sandbox helper binary… not configured correctly" 直接退出。只在确需时补
// --no-sandbox：平台为 linux 且（CI 环境或 root）。Windows/macOS 本地不传，保持真沙箱。
const needNoSandbox =
  process.platform === 'linux' && (Boolean(process.env['CI']) || process.getuid?.() === 0)
const electronArgs = [
  join(root, 'node_modules', 'electron', 'cli.js'),
  ...(needNoSandbox ? ['--no-sandbox'] : []),
  '.',
]

let log = ''
let settled = false

/** 杀进程树：Windows 走 taskkill /T；POSIX 走 detached 进程组负 pid。幂等、容错。 */
function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
    }
  }
}

const child = spawn(process.execPath, electronArgs, {
  cwd: root,
  env: {
    ...process.env,
    CLW_SMOKE_WINDOW_CYCLE: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  // POSIX：独立进程组，便于整树 kill(-pid)。Windows 不能 detached（会弹新控制台，
  // 且 taskkill /T 已够用）。
  detached: process.platform !== 'win32',
  windowsHide: true,
})

function finish(code, reason, extra) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  killTree(child)
  const tail = log.length > TAIL_CHARS ? log.slice(-TAIL_CHARS) : log
  if (code === 0) {
    console.log(`[electron-smoke] PASS：${reason}`)
  } else {
    console.error(`[electron-smoke] FAIL：${reason}`)
    if (extra) console.error(`[electron-smoke] ${extra}`)
    console.error(`[electron-smoke] ---- 应用输出尾部（最近 ${tail.length} 字符）----`)
    console.error(tail || '(无输出)')
  }
  process.exit(code)
}

const timer = setTimeout(() => {
  const hit = log.includes(TIMEOUT_MARKER)
    ? '应用报告窗口循环超时（window-cycle-timeout）'
    : `等待 ${TIMEOUT_MS}ms 未观察到 window-cycle-ok`
  finish(1, hit)
}, TIMEOUT_MS)
timer.unref?.()

function onChunk(buf) {
  log += buf.toString('utf8')
  if (settled) return
  if (log.includes(OK_MARKER)) return finish(0, '捕获到 window-cycle-ok（真实建窗→关窗链通过）')
  if (log.includes(CRASH_MARKER)) {
    return finish(1, '应用报告主进程未捕获异常（[CLW_SMOKE] crash）')
  }
  if (log.includes(FAIL_MARKER)) return finish(1, '窗口循环校验失败（window-cycle-fail）')
}

child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)

child.on('error', (e) => finish(1, `无法启动 Electron：${e.message}`))

// 用 'close'（stdio 全部关闭后触发）而非 'exit'——'exit' 可能在管道 stdout 数据
// 排空前触发（Windows 实测：快速 exit 0 时标记行仍在缓冲，误判「退出前无标记」假红）。
child.on('close', (code, signal) => {
  if (settled) return
  // 进程已退出但未观测到成功标记——按失败收口并带现场。
  finish(
    1,
    `Electron 进程在标记出现前退出（exit=${code ?? 'null'} signal=${signal ?? 'null'}）`,
  )
})

// 自身被杀（CI 取消/超时）时兜底清理子进程树，避免孤儿持端口。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    killTree(child)
    process.exit(1)
  })
}
