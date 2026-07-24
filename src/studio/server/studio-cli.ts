/**
 * `clwriting studio [--port N] [--book <书名或路径>] [--workdir <路径>]` —— GUI 子命令入口（#12.2）。
 *
 * 起 server（默认 127.0.0.1:7878）→ 静态托管前端 → 自动开浏览器；
 * Ctrl+C 优雅关闭。这是 clwriting 单入口之一，只是其「执行」= 起常驻
 * server（不进状态机轮转）。
 *
 * --book <书名或路径> 直进单书（1.2 起支持）；省略进书架。
 * --workdir <路径> 指定工作目录（书库根），省略则从 cwd 向上找 .clwriting/。
 */
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { startServer } from './index.js'
import { findWorkDir, readBooks } from '../../install/books.js'
import { setInitialBook } from './api/books.js'

const DEFAULT_PORT = 7878

interface StudioArgs {
  port: number
  book?: string
  workdir?: string
}

function parsePort(value: string | undefined): number {
  if (!value) throw new Error('--port 需要端口值')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口必须是 1-65535 的整数：${value}`)
  }
  return port
}

/** 解析 clwriting studio [--port N] [--book <path>] */
export function parseArgs(argv: string[]): StudioArgs {
  const args: StudioArgs = { port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (a === '--port') {
      args.port = parsePort(argv[++i])
    } else if (a === '--book') {
      const v = argv[++i]
      if (v) args.book = v
    } else if (a.startsWith('--port=')) {
      args.port = parsePort(a.slice(7))
    } else if (a.startsWith('--book=')) {
      args.book = a.slice(7)
    } else if (a === '--workdir') {
      const v = argv[++i]
      if (v) args.workdir = v
    } else if (a.startsWith('--workdir=')) {
      args.workdir = a.slice(10)
    }
  }
  return args
}

/**
 * 定位前端构建产物目录。
 * 打包后：dist/cli.js + dist/web/（here=dist/ → dist/web）
 * chunk 分割时：here 可能在 dist/chunks/（→ ../web）
 * 开发从源码跑：前端走 vite 5173（dev:web-next），不依赖此探测
 * 逐个探测 index.html，命中即用；都不到返回 undefined（server 仅 API）。
 */
async function resolveStaticDir(): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'web'), // dist/web/（here=dist/）
    join(here, '..', 'web'), // here=dist/chunks/ 时
    join(here, '..', '..', 'web', 'dist'), // 开发 here=src/studio/server/
  ]
  for (const c of candidates) {
    try {
      const s = await stat(join(c, 'index.html'))
      if (s.isFile()) return c
    } catch {
      // 继续下一个候选
    }
  }
  return undefined
}

/** 跨平台开浏览器（失败不致命，打印 URL 让用户手动开） */
export function openBrowser(url: string): void {
  let printedFallback = false
  const printFallback = (): void => {
    if (printedFallback) return
    printedFallback = true
    console.log(`请在浏览器手动打开：${url}`)
  }

  try {
    const child =
      process.platform === 'win32'
        ? spawn('start', ['""', url], { shell: true, detached: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
            detached: true,
            stdio: 'ignore',
          })

    child.on('error', printFallback)
    child.unref()
  } catch {
    printFallback()
  }
}

/**
 * 把 --book（书名或书路径）解析成书名，设为启动初始书。
 * 匹配优先级：name 相等 > path 相等 > 绝对路径相等；都不匹配则原样（前端 404 提示）。
 */
function resolveInitialBook(bookArg: string | undefined, workDir: string | null): void {
  if (!bookArg) {
    setInitialBook(undefined)
    return
  }
  if (!workDir) {
    setInitialBook(bookArg)
    return
  }
  const abs = resolve(bookArg)
  const matched = readBooks(workDir).find(
    (b) => b.name === bookArg || b.path === bookArg || resolve(workDir, b.path) === abs,
  )
  setInitialBook(matched?.name ?? bookArg)
}

/** `clwriting studio` 命令处理器 */
export async function studioCommand(argv: string[]): Promise<void> {
  let args: StudioArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  const staticDir = await resolveStaticDir()

  // 工作目录定位：--workdir 显式指定优先，否则从 cwd 向上找 .clwriting/
  const workDir = findWorkDir(args.workdir ?? process.cwd())
  resolveInitialBook(args.book, workDir)

  const server = startServer({ port: args.port, staticDir, workDir })

  server.on('listening', () => {
    const url = `http://127.0.0.1:${args.port}`
    console.log(`\n✓ CLWriting Studio 已启动 → ${url}`)
    if (args.book) console.log(`  --book ${args.book} → 直进单书`)
    if (args.workdir) console.log(`  --workdir ${args.workdir} → 工作目录已定位`)
    if (!workDir) {
      console.log('  ⚠ 未定位到工作目录（当前目录不含 .clwriting/），书架将为空。')
    }
    if (!staticDir) {
      console.log('  ⚠ 前端尚未构建，书架页将显示构建提示。')
      console.log('    构建：npm --prefix src/studio/web-next run build')
    }
    openBrowser(url)
  })
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`✗ 端口 ${args.port} 已被占用，换一个：clwriting studio --port <N>`)
    } else {
      console.error(`✗ 启动失败：${e.message}`)
    }
    process.exit(1)
  })

  // Ctrl-C 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在关闭 Studio…')
    server.close(() => process.exit(0))
  })
}
