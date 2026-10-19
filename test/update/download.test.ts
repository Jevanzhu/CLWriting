/**
 * 阶段 55：便携包下载链（本地 http 桩，不打外网）。
 *
 * 判据锚在**盘面可观察结果**上：成功 ⟺ 正式名存在且无 `.part` 残留；失败/取消 ⟺
 * 两者皆无。校验面覆盖两条来源（资产 digest 与 SHA256SUMS 清单回落）与「两者皆无
 * 即拒绝」的 fail-closed 口径——下载链绝不把不可校验的字节交出去。
 *
 * 地址面判据：包体地址与校验清单地址都必须逐字等于规范地址（仓常量 + tag + 资产名），
 * 或落在「回环 + http」这一条显式放行面上；本档用本地 http 桩跑正常腿（回环放行面），
 * 规范地址腿用 fetch 桩跑（不打网），非规范地址腿断言**零出站 + 不建目录**。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listenSafe } from '../helpers/safe-port.js'
import { tempDirTracked } from '../helpers/temp-dir.js'
import {
  downloadUpdateZip,
  isAcceptedReleaseUrl,
  releaseAssetUrl,
  releaseChecksumsUrl,
  sha256OfFile,
  type UpdateDownloadProgress,
} from '../../src/update/download.js'

const ZIP_BODY = Buffer.alloc(256 * 1024, 7) // 256KB：够跨多个读块，进度回调有事可报
const ZIP_SHA = createHash('sha256').update(ZIP_BODY).digest('hex')
const ASSET_NAME = 'CLWriting-1.0.0-x64.zip'
const TAG = 'v1.0.0'

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

/** 响应体假件（单块流形态；规范地址腿不打网，出站一律由 fetch 桩接住） */
function bodyOf(body: Buffer): ReadableStream<Uint8Array> {
  let sent = false
  return {
    getReader: () => ({
      read: async () =>
        sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(body) }),
    }),
  } as unknown as ReadableStream<Uint8Array>
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
      tag: TAG,
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
      tag: TAG,
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
      tag: TAG,
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
      tag: TAG,
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
    const r = await downloadUpdateZip({
      tag: TAG,
      url: `${base}/pkg.zip`,
      destDir: dir,
      fileName: 'x.zip',
      sha256: null,
    })
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
      tag: TAG,
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
      tag: TAG,
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
      tag: TAG,
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

describe('地址判据（规范地址单源 + 仅回环放行）', () => {
  it('规范地址与回环 http 放行；发布域主机上的非规范路径、https 回环、私网一律拒', () => {
    const canonical = releaseAssetUrl(TAG, ASSET_NAME)
    expect(canonical).toBe('https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-x64.zip')
    expect(isAcceptedReleaseUrl(canonical, canonical)).toBe(true)
    // 显式放行面：仅回环 + http（本机桩 / 离线镜像）
    expect(isAcceptedReleaseUrl('http://127.0.0.1:7301/pkg.zip', canonical)).toBe(true)
    expect(isAcceptedReleaseUrl('http://localhost:7301/pkg.zip', canonical)).toBe(true)
    expect(isAcceptedReleaseUrl('http://[::1]:7301/pkg.zip', canonical)).toBe(true)
    // 发布域主机 + 非规范路径：主机对得上、路径不是规范地址 → 拒（回退成只锁主机即本例红）
    expect(
      isAcceptedReleaseUrl('https://github.com/attacker/CLWriting/releases/download/v1.0.0/x.zip', canonical),
    ).toBe(false)
    expect(isAcceptedReleaseUrl('https://objects.githubusercontent.com/x.zip', canonical)).toBe(false)
    expect(isAcceptedReleaseUrl('https://api.github.com/repos/Jevanzhu/CLWriting/releases', canonical)).toBe(false)
    // 放行面不得外溢：https 回环、私网、非法 URL 皆不可信
    expect(isAcceptedReleaseUrl('https://127.0.0.1/x.zip', canonical)).toBe(false)
    expect(isAcceptedReleaseUrl('http://192.168.1.9/x.zip', canonical)).toBe(false)
    expect(isAcceptedReleaseUrl('not a url', canonical)).toBe(false)
  })

  it('发布域主机 + 攻击者仓路径 → 拒且零出站、不建目录（只锁主机挡不住这条路）', async () => {
    const parent = destDir()
    const dir = join(parent, 'sub') // 判据不过时不该被创建
    let outbound = 0
    const r = await downloadUpdateZip({
      tag: TAG,
      url: 'https://github.com/attacker/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-x64.zip',
      destDir: dir,
      fileName: ASSET_NAME,
      sha256: ZIP_SHA,
      fetchImpl: (async () => {
        outbound++
        return { ok: true, status: 200, headers: { get: () => null }, body: bodyOf(ZIP_BODY) }
      }) as unknown as typeof fetch,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('network')
    expect(outbound).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('校验清单地址非规范（同主机攻击者仓 / CDN）→ 拒且零出站、不建目录', async () => {
    const parent = destDir()
    const dir = join(parent, 'sub')
    let outbound = 0
    const fetchStub = (async () => {
      outbound++
      throw new Error('判据不过不该出站')
    }) as unknown as typeof fetch
    for (const sums of [
      'https://github.com/attacker/CLWriting/releases/download/v1.0.0/SHA256SUMS.txt',
      'https://objects.githubusercontent.com/SHA256SUMS.txt',
    ]) {
      const r = await downloadUpdateZip({
        tag: TAG,
        url: releaseAssetUrl(TAG, ASSET_NAME),
        destDir: dir,
        fileName: ASSET_NAME,
        sha256: null,
        checksumsUrl: sums,
        fetchImpl: fetchStub,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.failure.reason).toBe('network')
    }
    expect(outbound).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('规范地址 → 放行（包体与清单都只发往派生出的那两条地址）', async () => {
    const dir = destDir()
    const canonicalZip = releaseAssetUrl(TAG, ASSET_NAME)
    const canonicalSums = releaseChecksumsUrl(TAG)
    expect(canonicalSums).toBe('https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/SHA256SUMS.txt')
    const calls: string[] = []
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === canonicalSums) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => `${ZIP_SHA}  ${ASSET_NAME}\n` }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(ZIP_BODY.length) : null) },
        body: bodyOf(ZIP_BODY),
      }
    }) as unknown as typeof fetch
    const r = await downloadUpdateZip({
      tag: TAG,
      url: canonicalZip,
      destDir: dir,
      fileName: ASSET_NAME,
      sha256: null, // 走清单回落腿，校验清单地址也被判据覆盖
      checksumsUrl: canonicalSums,
      fetchImpl: fetchStub,
    })
    expect(r.ok).toBe(true)
    expect(calls).toEqual([canonicalZip, canonicalSums])
    expect(entries(dir)).toEqual([ASSET_NAME])
  })

  it('资产名含路径分隔符 / 相对段 / 控制字符 → 拒且零出站、不建目录（落盘路径纵深防御）', async () => {
    const parent = destDir()
    const dir = join(parent, 'sub')
    let outbound = 0
    const fetchStub = (async () => {
      outbound++
      throw new Error('判据不过不该出站')
    }) as unknown as typeof fetch
    for (const name of ['../evil.zip', 'a/b.zip', 'a\\b.zip', '..', '', 'CLWriting-1.0.0\nx.zip']) {
      const r = await downloadUpdateZip({
        tag: TAG,
        // 地址腿给合规值：把「拦下它的是文件名判据」与地址判据区分开
        url: releaseAssetUrl(TAG, ASSET_NAME),
        destDir: dir,
        fileName: name,
        sha256: 'x'.repeat(64),
        fetchImpl: fetchStub,
      })
      expect(r.ok, `坏名应被拒：${JSON.stringify(name)}`).toBe(false)
      if (!r.ok) {
        expect(r.failure.reason).toBe('network')
        expect(r.failure.detail).toContain('资产名')
      }
    }
    expect(outbound).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })
})
