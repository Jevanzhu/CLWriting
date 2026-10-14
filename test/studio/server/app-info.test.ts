/**
 * 阶段 53 S2：`GET /api/app-info` 端点三态（有更新 / 无更新 / 未完成）+ 版本源。
 *
 * 判定方式：端点是**只读口**——不触发检查、不持状态，结果模块态由 update/check 持有。
 * 故三态用真跑一次（stub fetch，不打网）+ 测试注入口驱动，端点只验证「如实回读」。
 *
 * 阶段 55 加「上次更新尝试」结果条面：端点读共享根下的结果条（更新助手进程写在
 * `<home>/更新缓存/更新结果.json` 的一次性信箱）——aborted/rolled-back 原样回给前端，
 * applied 静默消费；无论哪种读后即删（第二次请求必为 null）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import {
  runUpdateCheckOnce,
  getUpdateCheckState,
  __resetUpdateCheckForTest,
  __setUpdateCheckResultForTest,
  UPDATE_CHECK_DISABLE_ENV,
} from '../../../src/update/check.js'
import { UPDATE_CACHE_DIRNAME, UPDATE_RESULT_FILENAME } from '../../../src/update/cache.js'

const servers: http.Server[] = []
const dirs: string[] = []

afterAll(() => {
  for (const s of servers) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

let savedVersion: string | undefined

beforeEach(() => {
  __resetUpdateCheckForTest()
  savedVersion = process.env['CLW_APP_VERSION']
  delete process.env['CLW_APP_VERSION']
})

afterEach(() => {
  if (savedVersion === undefined) delete process.env['CLW_APP_VERSION']
  else process.env['CLW_APP_VERSION'] = savedVersion
  __resetUpdateCheckForTest()
})

interface AppInfo {
  version?: string
  update?: { version: string; url: string; asset: unknown; checksumsUrl: string | null } | null
  updateAttempt?: { outcome: string; reason: string; from: string; to: string; at: string } | null
}

async function bootReady(): Promise<{ baseUrl: string; userData: string }> {
  const workDir = mkdtempTracked(join(tmpdir(), 'clw-appinfo-'))
  const userData = mkdtempTracked(join(tmpdir(), 'clw-appinfo-ud-'))
  dirs.push(workDir, userData)
  const server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
  servers.push(server)
  const addr = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${addr.port}`, userData }
}

/** 摆一条结果条（形态与更新助手写出的一致） */
function putNote(userData: string, note: Record<string, unknown>): string {
  const dir = join(userData, UPDATE_CACHE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, UPDATE_RESULT_FILENAME)
  writeFileSync(path, `${JSON.stringify(note)}\n`)
  return path
}

const BASE_NOTE = { at: '2026-10-14T10:00:00.000Z', from: '1.0.0-rc.4', to: '1.0.0' }

async function getAppInfo(baseUrl: string): Promise<{ status: number; body: AppInfo }> {
  const res = await fetch(`${baseUrl}/api/app-info`)
  return { status: res.status, body: (await res.json()) as AppInfo }
}

/** 只带 rc 的列表桩：跑完一次即「无更新」态（不打网） */
const rcOnlyFetch = (async () => ({
  ok: true,
  status: 200,
  body: { cancel: async () => {} },
  json: async () => [{ tag_name: 'v1.0.0-rc.0', draft: false }],
})) as unknown as typeof fetch

describe('GET /api/app-info（阶段 53 S2）', () => {
  it('未完成态：update 为 null，version 回落 package.json', async () => {
    const { baseUrl } = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.status).toBe(200)
    expect(r.body.update).toBeNull()
    expect(r.body.updateAttempt).toBeNull()
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('有更新态：update = { version, url, asset, checksumsUrl }（去 v + release tag 页）', async () => {
    __setUpdateCheckResultForTest({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
      asset: { name: 'CLWriting-1.2.3-x64.zip', url: 'https://dl.test/z.zip', size: 7, sha256: 'ab'.repeat(32) },
      checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
    })
    const { baseUrl } = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.body.update).toEqual({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
      asset: { name: 'CLWriting-1.2.3-x64.zip', url: 'https://dl.test/z.zip', size: 7, sha256: 'ab'.repeat(32) },
      checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
    })
    // 只读面：重复读一致（端点不改检查态）
    expect((await getAppInfo(baseUrl)).body.update).toEqual(r.body.update)
  })

  it('无更新态（检查已跑完但无新版）：update 仍为 null', async () => {
    // 全局 setup 置了不打网开关（test/helpers/disable-update-check-setup.ts）——本例要
    // 真跑一次检查（stub fetch，不出站）才能到「已跑完」态，故局部摘掉再还原
    const saved = process.env[UPDATE_CHECK_DISABLE_ENV]
    delete process.env[UPDATE_CHECK_DISABLE_ENV]
    try {
      await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: rcOnlyFetch })
    } finally {
      if (saved !== undefined) process.env[UPDATE_CHECK_DISABLE_ENV] = saved
    }
    expect(getUpdateCheckState()).toBe('done') // 非空基：确认检查真跑过（非开关短路）
    const { baseUrl } = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.body.update).toBeNull()
  })

  it('版本源：env CLW_APP_VERSION 优先于 package.json', async () => {
    process.env['CLW_APP_VERSION'] = '9.9.9-probe'
    const { baseUrl } = await bootReady()
    expect((await getAppInfo(baseUrl)).body.version).toBe('9.9.9-probe')
  })
})

describe('GET /api/app-info：上次更新尝试结果条（阶段 55）', () => {
  it('aborted 结果条：原样回给前端，且读后即删（第二次为 null）', async () => {
    const { baseUrl, userData } = await bootReady()
    const path = putNote(userData, { ...BASE_NOTE, outcome: 'aborted', reason: 'other-instances' })
    const first = await getAppInfo(baseUrl)
    expect(first.body.updateAttempt).toMatchObject({
      outcome: 'aborted',
      reason: 'other-instances',
      from: '1.0.0-rc.4',
      to: '1.0.0',
    })
    const second = await getAppInfo(baseUrl)
    expect(second.body.updateAttempt).toBeNull()
    expect(existsSync(path)).toBe(false) // 一次性信箱：取走即删
  })

  it('rolled-back 结果条：同样回给前端（换到一半已还原的现场说明）', async () => {
    const { baseUrl, userData } = await bootReady()
    putNote(userData, { ...BASE_NOTE, outcome: 'rolled-back', reason: 'swap-failed' })
    expect((await getAppInfo(baseUrl)).body.updateAttempt).toMatchObject({
      outcome: 'rolled-back',
      reason: 'swap-failed',
    })
  })

  it('applied（成功换新）与畸形结果条：静默消费，不回给前端', async () => {
    const { baseUrl, userData } = await bootReady()
    putNote(userData, { ...BASE_NOTE, outcome: 'applied', reason: 'relaunch-failed' })
    expect((await getAppInfo(baseUrl)).body.updateAttempt).toBeNull()

    const badPath = putNote(userData, { ...BASE_NOTE, outcome: 'weird', reason: 'nope' })
    expect((await getAppInfo(baseUrl)).body.updateAttempt).toBeNull()
    expect(existsSync(badPath)).toBe(false)
  })
})
