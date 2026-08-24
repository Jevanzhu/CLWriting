/**
 * 前端静态托管（SPA fallback，#12.2）。
 *
 * 生产时 server 托管 web 构建产物（dist/web/）：文件存在则按 MIME
 * 返回，不存在则 fallback 到 index.html（前端路由接管）。开发时
 * 走 Vite dev server（5173），proxy /api 到后端，不经此处理。
 */
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, sep, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { replyError } from './http.js'
import { resolveWithinRoot } from '../../fs/safe-path.js'

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
    // Q-1（第十五轮）：URL 构造包 try/catch——llhttp 接受 absolute-form 请求行（如
    // `GET http://[bad HTTP/1.1`），new URL 抛 TypeError 会变 async 回调的未捕获
    // rejection（/api 分支在 index.ts 有 catch，静态分支此前裸奔 → Node ≥15 默认
    // throw 即进程崩溃；红测试：raw socket 畸形请求行，修复前 ERR_INVALID_URL 裸抛）。
    // 与下方 decodeURIComponent 守卫同款：畸形请求回 400，不炸服务。
    let parsed: URL
    try {
      parsed = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    const { pathname } = parsed
    // dd-P3：静态面仅放行 GET/HEAD——POST/PUT 到非 /api 路径此前照常回文件/SPA
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // hh §八-12：错误信封统一 {code,error}（原裸文本 'Method Not Allowed'）
      replyError(res, 405, 'BAD_INPUT', 'Method Not Allowed')
      return
    }
    let decodedPathname: string
    try {
      decodedPathname = decodeURIComponent(pathname)
    } catch {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }

    // 防路径穿越：normalize 后必须在 root 内
    const rel = normalize(decodedPathname).replace(/^(\.\.[/\\])+/, '')
    const abs = join(root, rel)
    // 路径边界检查:必须等于 root 或在其下(root+sep),防 root='dist' 时 'dist-evil' 前缀欺骗
    if (abs !== root && !abs.startsWith(root + sep)) {
      replyError(res, 403, 'BAD_PATH', 'forbidden')
      return
    }
    try {
      const s = await stat(abs)
      const file = s.isDirectory() ? join(abs, 'index.html') : abs
      // M-9（第十一轮）：canonical 判界（双侧 realpath）——stat 跟随 symlink，字符串前缀
      // 判界挡不住 dist 内被植入的外指 symlink（本地已可写前提下的任意文件读，低利用面）。
      // 委托 fs/safe-path.resolveWithinRoot（与 books/files 等路径守卫同口径：最终响应文件
      // 两侧 realpath 后重判界；目录 → index.html 后再验，防 symlink 落在 index.html 自身）。
      // 越出 → 403；realpath 失败（断链 symlink 等）→ null 同判 403（fail-closed，不回落 SPA）
      const safe = resolveWithinRoot(root, relative(root, file) || 'index.html')
      if (!safe) {
        replyError(res, 403, 'BAD_PATH', 'forbidden')
        return
      }
      // vite 构建产物在 assets/ 下且文件名带内容 hash → 可长缓存 immutable；
      // 其余（index.html 等 SPA 入口）→ no-cache，保证发版后立即生效（Y-P2-7）。
      // X-21（第五十六轮）：判定改用规范化后 rel——原用未规范化的 decodedPathname，
      // `/assets/../index.html` 字面前缀命中 /assets/ 却实发 SPA 入口，错拿一年
      // immutable 长缓存。rel 已 normalize（.. 折叠）；分隔符统一回 /（win32
      // normalize 产 \，跨平台判定口径恒为 / 分隔）。
      const cacheable = rel.split(sep).join('/').startsWith('/assets/')
      // B-21（第六十轮）：补 content-length（RFC 9110 对 HEAD 响应的期望元数据）且
      // HEAD 不发 body——此前与 GET 同分支 res.end(data)，整文件读入内存后才丢弃
      const data = await readFile(safe.abs)
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': cacheable
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'content-length': String(data.length),
      })
      if (req.method === 'HEAD') res.end()
      else res.end(data)
    } catch (e) {
      // N-3（第十二轮）：errno 分流——只有 ENOENT/ENOTDIR（路径不存在/非目录段）才走
      // SPA fallback；其余 IO 错误（EACCES/EMFILE/盘满等）此前一律混叠成 200 index.html
      // （存在的文件被静默换成 SPA 入口、无任何报错），现如实回 500
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        replyError(res, 500, 'IO_ERROR', `静态文件读取失败：${err.code ?? err.message}`)
        return
      }
      // SPA fallback：非文件路径回 index.html（前端路由接管；B-21：HEAD 同口径补长度不发 body）
      try {
        const data = await readFile(join(root, 'index.html'))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': String(data.length),
        })
        if (req.method === 'HEAD') res.end()
        else res.end(data)
      } catch {
        replyError(res, 404, 'NOT_FOUND', '前端尚未构建。请先运行：npm --prefix src/studio/web-next run build')
      }
    }
  }
}
