/**
 * 前端静态托管（SPA fallback，#12.2）。
 *
 * 生产时 server 托管 web 构建产物（dist/web/）：文件存在则按 MIME
 * 返回，不存在则 fallback 到 index.html（前端路由接管）。开发时
 * 走 Vite dev server（5173），proxy /api 到后端，不经此处理。
 */
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 创建静态托管 handler：rootDir 为前端 dist 绝对路径 */
export function createStaticHandler(rootDir: string) {
  const root = normalize(rootDir)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    // dd-P3：静态面仅放行 GET/HEAD——POST/PUT 到非 /api 路径此前照常回文件/SPA
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }
    let decodedPathname: string
    try {
      decodedPathname = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    // 防路径穿越：normalize 后必须在 root 内
    const rel = normalize(decodedPathname).replace(/^(\.\.[/\\])+/, '')
    const abs = join(root, rel)
    // 路径边界检查:必须等于 root 或在其下(root+sep),防 root='dist' 时 'dist-evil' 前缀欺骗
    if (abs !== root && !abs.startsWith(root + sep)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const s = await stat(abs)
      const file = s.isDirectory() ? join(abs, 'index.html') : abs
      const data = await readFile(file)
      // vite 构建产物在 assets/ 下且文件名带内容 hash → 可长缓存 immutable；
      // 其余（index.html 等 SPA 入口）→ no-cache，保证发版后立即生效（Y-P2-7）。
      // 用 URL 层 decodedPathname 判定（跨平台恒为 / 分隔，且穿越路径天然不命中）。
      const cacheable = decodedPathname.startsWith('/assets/')
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': cacheable
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      res.end(data)
    } catch {
      // SPA fallback：非文件路径回 index.html（前端路由接管）
      try {
        const data = await readFile(join(root, 'index.html'))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(data)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('前端尚未构建。请先运行：npm --prefix src/studio/web-next run build')
      }
    }
  }
}
