/**
 * 阶段 53 S1：更新检查客户端（stub fetch；设计 §6 验收口径：正常 / 超时 / 非 200 /
 * 限速 403 / 畸形 JSON——全静默返 null 不抛；开关短路不调用 fetch）。
 *
 * 出站面在单测里一律走注入桩，**不打网**：`fetchImpl` 由用例给，全局 fetch 不参与
 * （vitest setup 的 token 包装只对 `/api/` 前缀请求生效，与本面无关，但仍不依赖）。
 *
 * 阶段 55 扩资产面：结果随带便携 zip 资产（`asset`）与校验清单地址——解析纯函数
 * （asset.ts）与 check 的结果接线在同一档内测（同域并入，不新开碎片档）。地址面按规范
 * 地址单源：资产的响应地址非规范即降级 null，清单地址一律由 tag 派生（不回声响应）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runUpdateCheckOnce,
  resolveLatestRelease,
  getUpdateCheckResult,
  getUpdateCheckState,
  resolveAppVersion,
  applyUpdateCheckResult,
  parsePushedUpdateCheckResult,
  __resetUpdateCheckForTest,
  UPDATE_CHECK_DISABLE_ENV,
} from '../../src/update/check.js'
import { parseChecksums, pickPortableAsset, portableZipName, toUpdateAsset } from '../../src/update/asset.js'
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

/** 便携 zip 的假 digest（GitHub 资产 digest 字段形态：`sha256:<hex>`） */
const ZIP_SHA = 'a1'.repeat(32)

/** 规范地址（仓常量 + tag + 资产名）：响应该给的那一份，也是结果里该出现的那一份 */
const CANONICAL_ZIP = 'https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-x64.zip'
const CANONICAL_SUMS = 'https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/SHA256SUMS.txt'

const RELEASES = [
  { tag_name: 'v1.0.0-rc.0', draft: false },
  {
    tag_name: 'v1.0.0',
    draft: false,
    assets: [
      {
        name: 'CLWriting-1.0.0-x64.zip',
        browser_download_url: CANONICAL_ZIP,
        size: 4096,
        digest: `sha256:${ZIP_SHA}`,
      },
      {
        name: 'CLWriting-1.0.0-arm64.zip',
        browser_download_url:
          'https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-arm64.zip',
        size: 4096,
      },
      // 清单地址故意给成非规范形态：结果里的地址必须来自 tag 派生（不回声响应）
      {
        name: 'SHA256SUMS.txt',
        browser_download_url: 'https://objects.githubusercontent.com/SHA256SUMS.txt',
        size: 120,
      },
    ],
  },
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
      // 资产面与版本同响应解析：便携 zip（x64）+ 校验清单地址（结果里是派生值，
      // 不是响应里那条非规范的 objects.githubusercontent.com）
      asset: {
        name: 'CLWriting-1.0.0-x64.zip',
        url: CANONICAL_ZIP,
        size: 4096,
        sha256: ZIP_SHA,
      },
      checksumsUrl: CANONICAL_SUMS,
    })
  })

  it('响应给非规范资产地址（发布域主机上的攻击者仓）→ asset 降级 null，清单地址仍取派生值', async () => {
    const tampered = okFetch([
      {
        tag_name: 'v1.0.0',
        draft: false,
        assets: [
          {
            name: 'CLWriting-1.0.0-x64.zip',
            browser_download_url:
              'https://github.com/attacker/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-x64.zip',
            size: 4096,
            digest: `sha256:${ZIP_SHA}`,
          },
          {
            name: 'SHA256SUMS.txt',
            browser_download_url: 'https://github.com/attacker/CLWriting/releases/download/v1.0.0/SHA256SUMS.txt',
          },
        ],
      },
    ])
    await runUpdateCheckOnce({ currentVersion: '1.0.0-rc.0', fetchImpl: tampered.fn })
    // 名字、尺寸、digest 都齐（唯一不合格的是地址）——回退成「只锁主机」时 asset 会非空，本例即红
    expect(getUpdateCheckResult()).toEqual({
      version: '1.0.0',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0',
      asset: null,
      checksumsUrl: CANONICAL_SUMS,
    })
  })

  it('正式版无 assets / 无匹配资产 → asset 与 checksumsUrl 均 null（只给发布页链接的降级态）', async () => {
    const noAssets = okFetch([{ tag_name: 'v1.0.0', draft: false }])
    await runUpdateCheckOnce({ currentVersion: '1.0.0-rc.0', fetchImpl: noAssets.fn })
    expect(getUpdateCheckResult()).toMatchObject({ version: '1.0.0', asset: null, checksumsUrl: null })

    __resetUpdateCheckForTest()
    const armOnly = okFetch([
      {
        tag_name: 'v1.0.0',
        draft: false,
        assets: [
          {
            name: 'CLWriting-1.0.0-arm64.zip',
            browser_download_url:
              'https://github.com/Jevanzhu/CLWriting/releases/download/v1.0.0/CLWriting-1.0.0-arm64.zip',
          },
        ],
      },
    ])
    await runUpdateCheckOnce({ currentVersion: '1.0.0-rc.0', fetchImpl: armOnly.fn })
    expect(getUpdateCheckResult()).toMatchObject({ asset: null, checksumsUrl: null })
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

describe('resolveLatestRelease（三态：下载链按 kind 分流文案）', () => {
  it('有正式版 → release（同响应带 assets，下载链据此定位资产）', async () => {
    const outcome = await resolveLatestRelease(okFetch(RELEASES).fn)
    expect(outcome.kind).toBe('release')
    const release = outcome.kind === 'release' ? outcome.release : null
    expect(release?.tag).toBe('v1.0.0')
    expect(pickPortableAsset(release?.assets, '1.0.0')?.url).toBe(CANONICAL_ZIP)
  })

  it('发布集里全是 rc → none（网络正常，只是没有正式版；与 error 必须分开）', async () => {
    const outcome = await resolveLatestRelease(okFetch([{ tag_name: 'v1.0.0-rc.4', draft: false }]).fn)
    expect(outcome.kind).toBe('none')
  })

  it('取不到（非 2xx / 响应不是数组 / 抛错）→ error 带原因', async () => {
    expect(await resolveLatestRelease(okFetch({}, { status: 500 }).fn)).toMatchObject({ kind: 'error' })
    expect(await resolveLatestRelease(okFetch({ not: 'array' }).fn)).toMatchObject({ kind: 'error' })
    const boom = (async () => {
      throw new Error('econnreset')
    }) as unknown as typeof fetch
    expect(await resolveLatestRelease(boom)).toMatchObject({ kind: 'error' })
  })
})

describe('主进程下发结果落态（applyUpdateCheckResult / parsePushedUpdateCheckResult）', () => {
  it('落态后端点读口如实回读（含 asset 全字段）', () => {
    applyUpdateCheckResult({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
      asset: { name: 'CLWriting-1.2.3-x64.zip', url: 'https://dl.test/z.zip', size: 7, sha256: ZIP_SHA },
      checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
    })
    expect(getUpdateCheckState()).toBe('done')
    expect(getUpdateCheckResult()).toEqual({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
      asset: { name: 'CLWriting-1.2.3-x64.zip', url: 'https://dl.test/z.zip', size: 7, sha256: ZIP_SHA },
      checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
    })
  })

  it('下发「无新版」（result null）同样落「已检查」态——与「未完成」在端点语义上不可混同', () => {
    __resetUpdateCheckForTest()
    expect(getUpdateCheckState()).toBe('idle')
    applyUpdateCheckResult(null)
    expect(getUpdateCheckState()).toBe('done')
    expect(getUpdateCheckResult()).toBeNull()
  })

  it('载荷形状抽查：不合形一律落 null（不把半截对象漏进端点响应）', () => {
    // 合法三态：完整 / asset null / checksumsUrl null
    expect(parsePushedUpdateCheckResult(null)).toBeNull()
    expect(parsePushedUpdateCheckResult({ version: '1.0.0', url: 'u', asset: null, checksumsUrl: null })).toEqual({
      version: '1.0.0',
      url: 'u',
      asset: null,
      checksumsUrl: null,
    })
    // 缺 version/url 或空串 → null
    expect(parsePushedUpdateCheckResult({ url: 'u' })).toBeNull()
    expect(parsePushedUpdateCheckResult({ version: '', url: 'u' })).toBeNull()
    expect(parsePushedUpdateCheckResult({ version: '1.0.0', url: '' })).toBeNull()
    expect(parsePushedUpdateCheckResult('not-an-object')).toBeNull()
    // asset 缺 name/url 或类型漂移 → null；size/sha256 类型漂移 → 落 null 字段（asset 仍成立）
    expect(parsePushedUpdateCheckResult({ version: '1.0.0', url: 'u', asset: { url: 'z' } })).toBeNull()
    expect(
      parsePushedUpdateCheckResult({ version: '1.0.0', url: 'u', asset: { name: 'a', url: 'z', size: 'x' } }),
    ).toEqual({
      version: '1.0.0',
      url: 'u',
      asset: { name: 'a', url: 'z', size: null, sha256: null },
      checksumsUrl: null,
    })
    // checksumsUrl 非串非 null → null
    expect(parsePushedUpdateCheckResult({ version: '1.0.0', url: 'u', checksumsUrl: 7 })).toBeNull()
  })
})

describe('发布资产解析（asset.ts 纯函数面）', () => {
  it('portableZipName：版本去前导 v，架构后缀与 electron-builder artifactName 对齐', () => {
    expect(portableZipName('1.2.3')).toBe('CLWriting-1.2.3-x64.zip')
    expect(portableZipName('v1.2.3')).toBe('CLWriting-1.2.3-x64.zip')
  })

  it('toUpdateAsset：digest 只认 sha256:<64hex>（其余形态 → sha256 null，asset 仍成立）', () => {
    expect(
      toUpdateAsset({ name: 'a.zip', browser_download_url: 'u', size: 3, digest: `sha256:${ZIP_SHA}` })?.sha256,
    ).toBe(ZIP_SHA)
    expect(toUpdateAsset({ name: 'a.zip', browser_download_url: 'u', digest: 'sha512:deadbeef' })?.sha256).toBeNull()
    expect(toUpdateAsset({ name: 'a.zip', browser_download_url: 'u', digest: 'sha256:zz' })?.sha256).toBeNull()
    // 名字/地址缺失或非串 → 整条作废（不可下载的资产不进来）
    expect(toUpdateAsset({ browser_download_url: 'u' })).toBeNull()
    expect(toUpdateAsset({ name: 'a.zip' })).toBeNull()
    expect(toUpdateAsset('not-an-object')).toBeNull()
  })

  it('pickPortableAsset：版本串（带/不带 v）命中同名资产；尺寸缺失 → null 而非 0', () => {
    const assets = [{ name: 'CLWriting-2.0.0-x64.zip', browser_download_url: 'u' }]
    expect(pickPortableAsset(assets, 'v2.0.0')?.size).toBeNull()
    expect(pickPortableAsset(assets, '2.0.1')).toBeNull()
    expect(pickPortableAsset('not-an-array', '2.0.0')).toBeNull()
  })

  it('parseChecksums：命中行取 hex；容忍 * 二进制标记与含空格文件名；无该行 → null', () => {
    const sum = [
      `${'b'.repeat(64)}  other.zip`,
      `${'C'.repeat(64)} *CLWriting-1.0.0-x64.zip`,
      `${'d'.repeat(64)}  my app.zip`,
    ].join('\r\n')
    expect(parseChecksums(sum, 'CLWriting-1.0.0-x64.zip')).toBe('c'.repeat(64))
    expect(parseChecksums(sum, 'my app.zip')).toBe('d'.repeat(64))
    expect(parseChecksums(sum, 'missing.zip')).toBeNull()
    expect(parseChecksums('', 'CLWriting-1.0.0-x64.zip')).toBeNull()
  })
})
