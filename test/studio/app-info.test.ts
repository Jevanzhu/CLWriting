/**
 * 阶段 53 S2：`GET /api/app-info` 端点三态（有更新 / 无更新 / 未完成）+ 版本源。
 *
 * 判定方式：端点是**只读口**——不触发检查、不持状态，结果模块态由 update/check 持有。
 * 故三态用真跑一次（stub fetch，不打网）+ 测试注入口驱动，端点只验证「如实回读」。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  runUpdateCheckOnce,
  __resetUpdateCheckForTest,
  __setUpdateCheckResultForTest,
} from '../../src/update/check.js'

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
  update?: { version: string; url: string } | null
}

async function bootReady(): Promise<string> {
  const workDir = mkdtempTracked(join(tmpdir(), 'clw-appinfo-'))
  const userData = mkdtempTracked(join(tmpdir(), 'clw-appinfo-ud-'))
  dirs.push(workDir, userData)
  const server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
  servers.push(server)
  const addr = server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}`
}

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
    const baseUrl = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.status).toBe(200)
    expect(r.body.update).toBeNull()
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('有更新态：update = { version, url }（去 v + release tag 页）', async () => {
    __setUpdateCheckResultForTest({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
    })
    const baseUrl = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.body.update).toEqual({
      version: '1.2.3',
      url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.2.3',
    })
    // 只读面：重复读一致（端点不改状态）
    expect((await getAppInfo(baseUrl)).body.update).toEqual(r.body.update)
  })

  it('无更新态（检查已跑完但无新版）：update 仍为 null', async () => {
    await runUpdateCheckOnce({ currentVersion: '1.0.0', fetchImpl: rcOnlyFetch })
    const baseUrl = await bootReady()
    const r = await getAppInfo(baseUrl)
    expect(r.body.update).toBeNull()
  })

  it('版本源：env CLW_APP_VERSION 优先于 package.json', async () => {
    process.env['CLW_APP_VERSION'] = '9.9.9-probe'
    const baseUrl = await bootReady()
    expect((await getAppInfo(baseUrl)).body.version).toBe('9.9.9-probe')
  })
})
