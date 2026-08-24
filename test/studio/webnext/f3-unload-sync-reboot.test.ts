/**
 * F3（五十九轮）回归：flushSyncOnUnload 在 token null（boot 失败）时先同步 re-boot
 * （GET /api/boot 免鉴权）再 flush——修复前 token null 的同步 PUT 必 401，关窗兜底
 * 形同虚设；re-boot 失败 console.warn 留痕后放弃。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
const tokenMock = vi.fn<() => string | null>(() => 'test-token')
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  getToken: () => tokenMock(),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

interface XhrCall { method: string; url: string; headers: Record<string, string>; body: string }

/** 同步 XHR 桩：GET /api/boot 回 bootResponse（token 通道）；PUT 记录落盘请求。 */
function stubSyncXhr(bootResponse: string | null): XhrCall[] {
  const calls: XhrCall[] = []
  class FakeXHR {
    method = ''
    url = ''
    headers: Record<string, string> = {}
    responseText = ''
    open(method: string, url: string): void { this.method = method; this.url = url }
    setRequestHeader(k: string, v: string): void { this.headers[k] = v }
    send(body?: string): void {
      if (this.url === '/api/boot') {
        this.responseText = bootResponse ?? ''
        return
      }
      calls.push({ method: this.method, url: this.url, headers: this.headers, body: body ?? '' })
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  return calls
}

async function openDirty(): Promise<void> {
  const doc = useDocStore()
  doc.setBook('test-book')
  vi.mocked(getContent).mockResolvedValueOnce('a')
  await doc.open({
    path: '写作/正文/第1章.md',
    name: '第1章.md',
    isDirectory: false,
    role: 'chapter',
    docId: 'd1',
    children: [],
  } as TreeNode)
  doc.patch('d1', '未保存内容')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('F3: flushSyncOnUnload token null → 同步 re-boot 再 flush', () => {
  it('boot 取回新 token → PUT 携带新 token 落盘（修复前：无 token 必 401）', async () => {
    tokenMock.mockReturnValue(null)
    const calls = stubSyncXhr(JSON.stringify({ token: 'rebooted-token' }))
    await openDirty()
    useDocStore().flushSyncOnUnload()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.headers['x-studio-token']).toBe('rebooted-token') // 修复点：re-boot 后的 token
    const payload = JSON.parse(calls[0]!.body) as { content: string; origin: string }
    expect(payload.content).toBe('未保存内容')
    expect(payload.origin).toBe('autosave')
  })

  it('re-boot 失败（boot 也挂）→ console.warn 留痕 + 不发必 401 的 PUT', async () => {
    tokenMock.mockReturnValue(null)
    const calls = stubSyncXhr('{}') // boot 响应无 token
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openDirty()
    useDocStore().flushSyncOnUnload()
    expect(calls).toHaveLength(0) // 修复点：不留静默失败——发必 401 的请求只会白阻塞卸载
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('token')
    warn.mockRestore()
  })

  it('token 正常 → 不触发 re-boot（boot 通道不被无谓牵连）', async () => {
    tokenMock.mockReturnValue('ok-token')
    const calls = stubSyncXhr(null)
    await openDirty()
    useDocStore().flushSyncOnUnload()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['x-studio-token']).toBe('ok-token')
  })
})
