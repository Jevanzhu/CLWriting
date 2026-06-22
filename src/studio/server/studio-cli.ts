/**
 * `clwriting studio [--port N] [--book <path>]` —— GUI 子命令入口（#12.2）。
 *
 * 起 server（默认 127.0.0.1:7878）→ 静态托管前端 → 自动开浏览器；
 * Ctrl+C 优雅关闭。这是 clwriting 单入口之一，只是其「执行」= 起常驻
 * server（不进状态机轮转）。
 *
 * --book 直进某书（1.2 起支持）；省略进书架。
 */
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { startServer } from './index.js'

const DEFAULT_PORT = 7878

interface StudioArgs {
  port: number
  book?: string
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
    }
  }
  return args
}

/**
 * 定位前端构建产物目录。
 * 打包后：dist/cli.js + dist/web/（here=dist/ → dist/web）
 * chunk 分割时：here 可能在 dist/chunks/（→ ../web）
 * 开发从源码跑：here=src/studio/server/ → src/studio/web/dist
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

  const server = startServer({ port: args.port, staticDir })

  server.on('listening', () => {
    const url = `http://127.0.0.1:${args.port}`
    console.log(`\n✓ CLWriting Studio 已启动 → ${url}`)
    if (args.book) console.log(`  --book ${args.book}（1.2 起支持直进单书）`)
    if (!staticDir) {
      console.log('  ⚠ 前端尚未构建，书架页将显示构建提示。')
      console.log('    构建：npm --prefix src/studio/web run build')
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
