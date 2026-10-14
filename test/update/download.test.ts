/**
 * 阶段 55：便携包下载链（本地 http 桩，不打外网）。
 *
 * 判据锚在**盘面可观察结果**上：成功 ⟺ 正式名存在且无 `.part` 残留；失败/取消 ⟺
 * 两者皆无。校验面覆盖两条来源（资产 digest 与 SHA256SUMS 清单回落）与「两者皆无
 * 即拒绝」的 fail-closed 口径——下载链绝不把不可校验的字节交出去。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listenSafe } from '../helpers/safe-port.js'
import { tempDirTracked } from '../helpers/temp-dir.js'
import { downloadUpdateZip, sha256OfFile, type UpdateDownloadProgress } from '../../src/update/download.js'

const ZIP_BODY = Buffer.alloc(256 * 1024, 7) // 256KB：够跨多个读块，进度回调有事可报
const ZIP_SHA = createHash('sha256').update(ZIP_BODY).digest('hex')

const servers: http.Server[] = []

afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections()
    s.close()
  }
})

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void

/** 起一个只有本用例路由的 http 桩服务器，返回基址 */
async function serve(routes: Record<string, Route>): Promise<string> {
  const server = http.createServer((req, res) => {
    const route = routes[req.url ?? '']
    if (!route) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    route(req, res)
  })
  await listenSafe(server)
  servers.push(server)
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return `http://127.0.0.1:${port}`
}

function sendBody(body: Buffer, headers: Record<string, string> = {}): Route {
  return (_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), ...headers })
    res.end(body)
  }
}

function destDir(): string {
  return tempDirTracked('clw-update-dl-')
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort()
}

describe('downloadUpdateZip（阶段 55）', () => {
  it('正常：流式落盘 → 校验通过 → rename 成正式名（无 .part 残留，进度含总量）', async () => {
    const base = await serve({
      '/pkg.zip': sendBody(ZIP_BODY),
      '/SHA256SUMS.txt': sendBody(Buffer.from(`${ZIP_SHA}  CLWriting-1.0.0-x64.zip\n`)),
    })
    const dir = destDir()
    const progress: UpdateDownloadProgress[] = []
    const r = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: ZIP_SHA,
      onProgress: (p) => progress.push({ ...p }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sha256).toBe(ZIP_SHA)
    expect(r.zipPath).toBe(join(dir, 'CLWriting-1.0.0-x64.zip'))
    expect(entries(dir)).toEqual(['CLWriting-1.0.0-x64.zip'])
    expect(readFileSync(r.zipPath).equals(ZIP_BODY)).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toEqual({ received: ZIP_BODY.length, total: ZIP_BODY.length })
  })

  it('digest 缺失 → 回落 SHA256SUMS.txt；清单缺行即拒（不落正式名）', async () => {
    const base = await serve({
      '/pkg.zip': sendBody(ZIP_BODY),
      '/SHA256SUMS.txt': sendBody(Buffer.from(`${'0'.repeat(64)}  CLWriting-1.0.0-x64.zip\n`)),
    })
    const dir = destDir()
    const bad = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: null,
      checksumsUrl: `${base}/SHA256SUMS.txt`,
    })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.failure.reason).toBe('checksum')
    expect(entries(dir)).toEqual([]) // .part 已清、正式名未落

    // 清单自身拉不到（404）同样拒
    const gone = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: null,
      checksumsUrl: `${base}/missing.txt`,
    })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.failure.reason).toBe('checksum')
  })

  it('校验不匹配 → checksum 失败且盘面无残迹', async () => {
    const base = await serve({ '/pkg.zip': sendBody(ZIP_BODY) })
    const dir = destDir()
    const r = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: 'f'.repeat(64),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('checksum')
    expect(entries(dir)).toEqual([])
  })

  it('无任何校验值来源 → 拒绝（不明字节不解压）', async () => {
    const base = await serve({ '/pkg.zip': sendBody(ZIP_BODY) })
    const dir = destDir()
    const r = await downloadUpdateZip({ url: `${base}/pkg.zip`, destDir: dir, fileName: 'x.zip', sha256: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('checksum')
    expect(entries(dir)).toEqual([])
  })

  it('取消（中途 abort）→ canceled 且盘面无残迹', async () => {
    // 慢速路由：先发一部分，再挂着不回，等客户端 abort
    const base = await serve({
      '/pkg.zip': (_req, res) => {
        res.writeHead(200, { 'content-length': String(ZIP_BODY.length) })
        res.write(ZIP_BODY.subarray(0, 32 * 1024))
        // 不再 end：连接挂住，等客户端 abort
      },
    })
    const dir = destDir()
    const controller = new AbortController()
    const r = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: ZIP_SHA,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('canceled')
    expect(entries(dir)).toEqual([])
  })

  it('非 2xx → network 失败且盘面无残迹', async () => {
    const base = await serve({}) // 全部 404
    const dir = destDir()
    const r = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: ZIP_SHA,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('network')
    expect(entries(dir)).toEqual([])
  })

  it('起手清旧 .part（上次中断的残留不混进本次）', async () => {
    const base = await serve({ '/pkg.zip': sendBody(ZIP_BODY) })
    const dir = destDir()
    writeFileSync(join(dir, 'CLWriting-1.0.0-x64.zip.part'), Buffer.from('stale half file'))
    const r = await downloadUpdateZip({
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'CLWriting-1.0.0-x64.zip',
      sha256: ZIP_SHA,
    })
    expect(r.ok).toBe(true)
    expect(entries(dir)).toEqual(['CLWriting-1.0.0-x64.zip'])
    expect(readFileSync(join(dir, 'CLWriting-1.0.0-x64.zip')).equals(ZIP_BODY)).toBe(true)
  })

  it('sha256OfFile：与流式实测一致（助手换目录前的包体复核用）', async () => {
    const dir = destDir()
    const file = join(dir, 'a.bin')
    writeFileSync(file, ZIP_BODY)
    expect(await sha256OfFile(file)).toBe(ZIP_SHA)
  })
})
