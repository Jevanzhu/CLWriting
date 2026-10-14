/**
 * 阶段 55：便携包下载（流式落盘 + 校验 + 原子改名）。
 *
 * 契约四则：
 *  - **先落 `.part`**：全程写 `<目标名>.part`，校验通过才 `rename` 成正式名——正式名
 *    存在 ⟺ 该文件已过校验，助手进程可据此免检复用（续传/断点不在本期）。
 *  - **不明字节不解压**：下载链与助手都要求 sha256 锚定。校验值优先用 GitHub API 的
 *    资产 `digest`，缺失时回落发布同批的 `SHA256SUMS.txt`；两者皆无 → **失败**（宁可
 *    停在「去下载」降级态，也不把不可校验的包交出去）。
 *  - **失败/取消不留残迹**：`.part` 与半截文件一律删除（缓存目录不该越攒越脏）。
 *  - **出站走注入**：`fetchImpl` 缺省全局 fetch，主进程传 `net.fetch`（受系统代理，
 *    与 interface 一致），单测传桩——本模块自身不引入 Electron 依赖（可被 server 侧测试
 *    直接跑）。
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry } from '../fs/atomic.js'
import { errMsg } from '../log/index.js'
import { parseChecksums } from './asset.js'

/** 进度回调节流（毫秒）——300MB 的包按 64KB 块约五千次回调，逐块过 IPC 是纯噪音 */
const PROGRESS_THROTTLE_MS = 150

/** 校验清单请求超时（毫秒；清单是小文件，等太久不如失败） */
const CHECKSUMS_TIMEOUT_MS = 20000

export interface UpdateDownloadProgress {
  received: number
  /** 总字节（响应头 Content-Length 优先，其次调用方给的 size；皆缺 → null = 只报已收） */
  total: number | null
}

export type UpdateDownloadFailureReason =
  /** 请求失败/非 2xx/响应无体 */
  | 'network'
  /** 无可用校验值，或校验不匹配 */
  | 'checksum'
  /** 落盘/改名失败（含磁盘满） */
  | 'disk'
  /** 用户取消 */
  | 'canceled'

export interface UpdateDownloadFailure {
  reason: UpdateDownloadFailureReason
  /** 人话细节（日志与界面提示用；不含凭据） */
  detail: string
}

export type UpdateDownloadResult =
  { ok: true; zipPath: string; sha256: string } | { ok: false; failure: UpdateDownloadFailure }

export interface UpdateDownloadOptions {
  url: string
  /** 目标目录（不存在则创建） */
  destDir: string
  /** 本地文件名（缺省用资产名，由调用方传） */
  fileName: string
  /** 期望字节数（进度分母兜底；缺省 null） */
  size?: number | null
  /** 期望 sha256（小写 hex；GitHub digest）；缺省时回落 checksumsUrl */
  sha256?: string | null
  /** 校验清单地址（sha256 缺失时的来源） */
  checksumsUrl?: string | null
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (p: UpdateDownloadProgress) => void
}

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** 非 2xx 响应体不消费会挂住连接池：best-effort 取消（已断/已尽形态不阻断失败返回） */
async function drainBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  try {
    await body?.cancel()
  } catch {
    /* 见头注：取消是尽力而为 */
  }
}

/** 进度分母：响应头 Content-Length 优先，其次调用方给的 size，皆缺 → null（只报已收） */
function resolveTotal(headerLen: unknown, size: number | null | undefined): number | null {
  const head = Number(headerLen)
  if (Number.isFinite(head) && head > 0) return head
  if (typeof size === 'number' && size > 0) return size
  return null
}

/**
 * 流式落盘：读响应体 → 写 `.part` → 喂 hash；进度按 PROGRESS_THROTTLE_MS 节流上报。
 * 返回已收字节数；失败（含取消）原样抛出，由调用方统一分类与清理。
 */
async function pumpBodyToPart(
  body: ReadableStream<Uint8Array>,
  partPath: string,
  hash: Hash,
  total: number | null,
  onProgress: ((p: UpdateDownloadProgress) => void) | undefined,
): Promise<number> {
  const handle = await open(partPath, 'w')
  let received = 0
  let lastEmit = 0
  try {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      await handle.write(value)
      hash.update(value)
      received += value.byteLength
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
        lastEmit = now
        onProgress?.({ received, total })
      }
    }
    await handle.close()
  } catch (e) {
    try {
      await handle.close()
    } catch {
      /* 关闭失败不妨碍调用方删除残余 */
    }
    throw e
  }
  onProgress?.({ received, total: total ?? received })
  return received
}

/** 校验值解析：给定的 digest 优先，否则拉 SHA256SUMS.txt 解析；都没有 → null */
async function resolveExpectedSha256(
  opts: UpdateDownloadOptions,
  fetchImpl: typeof fetch,
): Promise<{ hex: string } | { error: string }> {
  const given = opts.sha256?.trim().toLowerCase()
  if (given) {
    if (!SHA256_HEX_RE.test(given)) return { error: '发布方给的校验值格式不合法' }
    return { hex: given }
  }
  if (!opts.checksumsUrl) return { error: '发布页未提供校验值（缺 SHA256SUMS.txt），已拒绝使用不可校验的包' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECKSUMS_TIMEOUT_MS)
  const onOuterAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort)
  try {
    const resp = await fetchImpl(opts.checksumsUrl, { signal: controller.signal })
    if (!resp.ok) {
      await drainBody(resp.body)
      return { error: `校验清单拉取失败（HTTP ${resp.status}）` }
    }
    const hex = parseChecksums(await resp.text(), opts.fileName)
    if (!hex) return { error: `校验清单内无 ${opts.fileName} 的行` }
    return { hex }
  } catch (e) {
    return { error: `校验清单拉取失败（${errMsg(e)}）` }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 下载便携包到 `destDir/fileName` 并校验。
 * 返回 `{ ok:true, zipPath, sha256 }`（sha256 = 实测值，供助手二次核验与复用锚）；
 * 失败三态见 `UpdateDownloadFailureReason`，任何失败路径都不留 `.part` 残迹。
 */
export async function downloadUpdateZip(opts: UpdateDownloadOptions): Promise<UpdateDownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const zipPath = join(opts.destDir, opts.fileName)
  const partPath = `${zipPath}.part`
  const dropPart = async (): Promise<void> => {
    try {
      await rm(partPath, { force: true })
    } catch {
      /* 残留 .part 不影响正确性：下次下载起手即清 */
    }
  }

  try {
    await mkdir(opts.destDir, { recursive: true })
  } catch (e) {
    return { ok: false, failure: { reason: 'disk', detail: `更新缓存目录创建失败：${errMsg(e)}` } }
  }
  await dropPart()

  const hash = createHash('sha256')
  let received: number
  try {
    const resp = await fetchImpl(opts.url, { ...(opts.signal ? { signal: opts.signal } : {}) })
    if (!resp.ok) {
      await drainBody(resp.body)
      return { ok: false, failure: { reason: 'network', detail: `HTTP ${resp.status}` } }
    }
    if (!resp.body) return { ok: false, failure: { reason: 'network', detail: '响应无可读内容' } }
    const total = resolveTotal(resp.headers.get('content-length'), opts.size)
    received = await pumpBodyToPart(resp.body, partPath, hash, total, opts.onProgress)
  } catch (e) {
    await dropPart()
    if (isAbort(e, opts.signal)) return { ok: false, failure: { reason: 'canceled', detail: '已取消下载' } }
    return { ok: false, failure: { reason: 'network', detail: errMsg(e) } }
  }

  if (received === 0) {
    await dropPart()
    return { ok: false, failure: { reason: 'network', detail: '下载内容为空' } }
  }

  const actual = hash.digest('hex')
  const expected = await resolveExpectedSha256(opts, fetchImpl)
  if ('error' in expected) {
    await dropPart()
    return { ok: false, failure: { reason: 'checksum', detail: expected.error } }
  }
  if (expected.hex !== actual) {
    await dropPart()
    return {
      ok: false,
      failure: {
        reason: 'checksum',
        detail: `校验不匹配（期望 ${expected.hex.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
      },
    }
  }
  try {
    renameWithRetry(partPath, zipPath)
  } catch (e) {
    await dropPart()
    return { ok: false, failure: { reason: 'disk', detail: `落盘失败：${errMsg(e)}` } }
  }
  return { ok: true, zipPath, sha256: actual }
}

/** 文件 sha256（小写 hex）——助手进程换目录前的包体二次核验用 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
