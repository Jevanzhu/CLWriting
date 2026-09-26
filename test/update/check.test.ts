/**
 * 阶段 53 S1：更新检查客户端（stub fetch；设计 §6 验收口径：正常 / 超时 / 非 200 /
 * 限速 403 / 畸形 JSON——全静默返 null 不抛；开关短路不调用 fetch）。
 *
 * 出站面在单测里一律走注入桩，**不打网**：`fetchImpl` 由用例给，全局 fetch 不参与
 * （vitest setup 的 token 包装只对 `/api/` 前缀请求生效，与本面无关，但仍不依赖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runUpdateCheckOnce,
  fetchLatestStable,
  getUpdateCheckResult,
  getUpdateCheckState,
  resolveAppVersion,
  __resetUpdateCheckForTest,
  UPDATE_CHECK_DISABLE_ENV,
} from '../../src/update/check.js'
import { log } from '../../src/log/index.js'

/** 造 ok 响应：json 体为 GitHub releases 形的数组（只用到 tag_name / draft 两字段） */
function okFetch(body: unknown, opts: { status?: number } = {}): { fn: typeof fetch; calls: number } {
  const holder = { calls: 0 }
  const fn = (async () => {
    holder.calls++
    const status = opts.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: async () => {} },
      json: async () => body,
    }
  }) as unknown as typeof fetch
  return {
    fn,
    get calls() {
      return holder.calls
    },
  } as { fn: typeof fetch; calls: number }
}

/** 永不回、仅随 abort 拒绝的桩（超时路径） */
const hangingFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
  return await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    })
  })
}) as unknown as typeof fetch

const RELEASES = [
  { tag_name: 'v1.0.0-rc.0', draft: false },
  { tag_name: 'v1.0.0', draft: false },
  { tag_name: 'nightly', draft: false },
]

let savedEnv: string | undefined
let savedDisable: string | undefined

beforeEach(() => {
  __resetUpdateCheckForTest()
  savedEnv = process.env['CLW_APP_VERSION']
  savedDisable = process.env[UPDATE_CHECK_DISABLE_ENV]
  delete process.env['CLW_APP_VERSION']
  delete process.env[UPDATE_CHECK_DISABLE_ENV]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env['CLW_APP_VERSION']
  else process.env['CLW_APP_VERSION'] = savedEnv
  if (savedDisable === undefined) delete process.env[UPDATE_CHECK_DISABLE_ENV]
  else process.env[UPDATE_CHECK_DISABLE_ENV] = savedDisable
  __resetUpdateCheckForTest()
  vi.restoreAllMocks()
})

describe('resolveAppVersion', () => {
  it('env CLW_APP_VERSION 优先（含两端空白剔除）', () => {
    process.env['CLW_APP_VERSION'] = ' 2.3.4 '
    expect(resolveAppVersion()).toBe('2.3.4')
  })

  it('缺省回落 package.json 版本；空串 env 视为未注入', () => {
    const fromPkg = resolveAppVersion()
    expect(fromPkg).toMatch(/^\d+\.\d+\.\d+/) // 仓库 package.json 恒为三方组（rc 形态带 -rc.N）
    process.env['CLW_APP_VERSION'] = '   '
    expect(resolveAppVersion()).toBe(fromPkg)
  })
})

describe('runUpdateCheckOnce 正常路径', () => {
  it('rc 当前版 + 有正式版在架 → 置结果（version 去 v、url 指向该 tag）', async () => {
    const stub = okFetch(RELEASES)
    await runUpdateCheckOnce({ currentVersion: '1.0.0-rc.0', fetchImpl: stub.fn })
    expect(stub.calls).toBe(1)
    expect(getUpdateCheckState()).toBe('done')
    expect(getUpdateCheckResult()).toEqual({
      version: '1.0.0',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0',
    })
  })

  it('当前已是正式版 → 无更新（结果 null），且不重复调用', async () => {
    const stub = okFetch(RELEASES)
    await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: stub.fn })
    expect(getUpdateCheckResult()).toBeNull()
    expect(getUpdateCheckState()).toBe('done')
  })

  it('本地版本更高（dev 直跑）→ 不提示', async () => {
    const stub = okFetch(RELEASES)
    await runUpdateCheckOnce({ currentVersion: '1.1.0', fetchImpl: stub.fn })
    expect(getUpdateCheckResult()).toBeNull()
  })

  it('版本未知（0.0.0 回落）→ 不提示（防「读不到版本就报新版」）', async () => {
    const stub = okFetch(RELEASES)
    await runUpdateCheckOnce({ currentVersion: '0.0.0', fetchImpl: stub.fn })
    expect(getUpdateCheckResult()).toBeNull()
  })

  it('只有 rc 在架（无正式版）→ 不提示', async () => {
    const stub = okFetch([{ tag_name: 'v1.1.0-rc.0', draft: false }])
    await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: stub.fn })
    expect(getUpdateCheckResult()).toBeNull()
  })

  it('draft 条目被跳过', async () => {
    const stub = okFetch([
      { tag_name: 'v9.9.9', draft: true },
      { tag_name: 'v1.1.0', draft: false },
    ])
    await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: stub.fn })
    expect(getUpdateCheckResult()?.version).toBe('1.1.0')
  })
})

describe('runUpdateCheckOnce 静默失败面（不抛、不置结果）', () => {
  const cases: Array<[string, typeof fetch]> = [
    ['非 200（500）', okFetch({}, { status: 500 }).fn],
    ['限速 403', okFetch({}, { status: 403 }).fn],
    ['畸形 JSON（非数组）', okFetch({ message: 'Not Found' }).fn],
    [
      '网络抛错',
      (async () => {
        throw new Error('ENOTFOUND')
      }) as unknown as typeof fetch,
    ],
  ]

  for (const [name, fn] of cases) {
    it(`${name} → 结果 null + 一行 info（非 warn）`, async () => {
      const infoSpy = vi.spyOn(log, 'info')
      const warnSpy = vi.spyOn(log, 'warn')
      await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: fn })
      expect(getUpdateCheckResult()).toBeNull()
      expect(getUpdateCheckState()).toBe('done')
      expect(warnSpy).not.toHaveBeenCalled()
      const infoCalls = infoSpy.mock.calls.map((c) => `${String(c[0])} ${String(c[1] ?? '')}`).join('\n')
      expect(infoCalls).toContain('update')
    })
  }

  it('超时（abort）→ 结果 null，不抛', async () => {
    await expect(
      runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).resolves.toBeUndefined()
    expect(getUpdateCheckResult()).toBeNull()
  })

  it('开关 CLW_DISABLE_UPDATE_CHECK=1 → 不调用 fetch 且保持未完成态', async () => {
    process.env[UPDATE_CHECK_DISABLE_ENV] = '1'
    const stub = okFetch(RELEASES)
    await runUpdateCheckOnce({ currentVersion: '1.0.0-rc.0', fetchImpl: stub.fn })
    expect(stub.calls).toBe(0)
    expect(getUpdateCheckState()).toBe('idle')
    expect(getUpdateCheckResult()).toBeNull()
  })
})

describe('fetchLatestStable（薄包装面）', () => {
  it('取到最大正式版原串 / 失败返 null', async () => {
    expect(await fetchLatestStable(okFetch(RELEASES).fn)).toBe('v1.0.0')
    expect(await fetchLatestStable(okFetch({}, { status: 403 }).fn)).toBeNull()
    expect(await fetchLatestStable(okFetch([{ tag_name: 'nightly' }]).fn)).toBeNull()
  })
})
