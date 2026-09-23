/**
 * 起点记忆批：Electron 43 起 dialog 未传 defaultPath 时缺省落「下载」目录，且系统不再
 * 记忆上次目录（官方 breaking changes），「打开书库」选择器的起点须由本仓自记补回。
 *
 * 断言面：pickLibrary 传给 showOpenDialog 的 defaultPath = 上次用过的书库的**父目录**；
 * 无记忆源 / 预探失败 / 预探超时 → 该键不出现（fail-open，起点不拖对话框）。
 * mock 装置见 ./main-fixtures.js（showOpenDialog 假件新增 dialogOpenOpts 捕获面）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M,
  mkTmp,
  trustedEvent,
  captureMainTestEnvPrev,
  bootstrapMainFixture,
  restoreMainTestEnv,
  cleanupMainTmpDirs,
  fsPromisesMock,
} from './main-fixtures.js'
import {
  installMainProcessListenerHarness,
  removeTrackedProcessListeners,
  restoreMainProcessListenerHarness,
} from './main-process-harness.js'

installMainProcessListenerHarness()
const prevEnv = captureMainTestEnvPrev()

beforeAll(async () => {
  await bootstrapMainFixture()
})

afterAll(() => {
  removeTrackedProcessListeners()
  restoreMainProcessListenerHarness()
  restoreMainTestEnv(prevEnv)
  cleanupMainTmpDirs()
})

afterEach(() => {
  removeTrackedProcessListeners()
})

/** workdir.json 路径（M.userData 由 beforeAll 赋值，故惰性求值）。 */
const storeFp = (): string => join(M.userData, 'workdir.json')

/**
 * 重装 main 并冲刷 whenReady 链——bootstrap 按当前磁盘 store 采用 current 书库。
 * 记忆读的是 currentWorkDir()（bootstrap 实际值优先），同会话内切库不动它，故第 6 例
 * 必须以「重装 = 生产链的切库重启」来兑现刷新语义。
 */
async function reimportMain(): Promise<void> {
  vi.resetModules()
  await import('../../src/desktop/main.js')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

async function freshWithStore(store: unknown): Promise<void> {
  writeFileSync(storeFp(), JSON.stringify(store))
  await reimportMain()
}

/** 触发「打开书库」并返回本轮 showOpenDialog 实收选项（选项捕获面按调用序追加）。 */
async function openLibraryOpts(): Promise<Record<string, unknown>> {
  const n0 = M.dialogOpenOpts.length
  M.dialogOpen = { canceled: true, filePaths: [] }
  const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent(), {})) as {
    ok: boolean
    canceled?: boolean
  }
  expect(r).toEqual({ ok: false, canceled: true }) // 取消收口（起点用例只关心弹之前的计算）
  expect(M.dialogOpenOpts.length).toBe(n0 + 1) // 恰弹一次（封顶循环首轮即取消）
  return M.dialogOpenOpts[n0]!
}

describe('起点记忆：pickLibrary 的 defaultPath = 上次书库的父目录', () => {
  it('current 书库在位 → defaultPath 取其父目录（非书库自身、非 Electron 缺省）', async () => {
    const holder = mkTmp('clw-pickdef-root-') // 父目录（模拟「书库都放在这个文件夹里」）
    const lib = join(holder, '书库甲')
    mkdirSync(join(lib, '.clwriting'), { recursive: true }) // 合法书库（.clwriting 在位）
    await freshWithStore({ current: lib, recent: [] })

    const opts = await openLibraryOpts()
    expect(opts['defaultPath']).toBe(holder)
    // 取父目录的理由锚：停在书库内部看不见同级书库（要另选得先退出到上级）
    expect(opts['defaultPath']).not.toBe(lib)
  })

  it('welcome 态（current=null）回落 recent 首项 → 仍取父目录', async () => {
    const holder = mkTmp('clw-pickdef-recent-root-')
    const recentLib = join(holder, '书库乙')
    mkdirSync(join(recentLib, '.clwriting'), { recursive: true })
    await freshWithStore({ current: null, recent: [{ path: recentLib, label: '书库乙' }] })

    const opts = await openLibraryOpts()
    expect(opts['defaultPath']).toBe(holder)
  })

  it('无记忆源（welcome 态且 recent 空）→ 不写 defaultPath 键（交 Electron 缺省）', async () => {
    await freshWithStore({ current: null, recent: [] })

    const opts = await openLibraryOpts()
    expect(opts).not.toHaveProperty('defaultPath')
  })

  it('预探失败（stat 抛错：目录被删/权限）→ 不写 defaultPath 键，对话框照常弹出', async () => {
    const holder = mkTmp('clw-pickdef-stale-root-')
    const lib = join(holder, '书库丙')
    mkdirSync(join(lib, '.clwriting'), { recursive: true })
    await freshWithStore({ current: lib, recent: [] })
    fsPromisesMock.statGate = () => Promise.reject(new Error('ENOENT: 起点已失效'))
    try {
      const opts = await openLibraryOpts()
      expect(opts).not.toHaveProperty('defaultPath')
    } finally {
      fsPromisesMock.statGate = null
    }
  })

  it('预探超时（失联网络卷挂死）→ 不写 defaultPath 键且不拖住对话框（预算内返回）', async () => {
    const holder = mkTmp('clw-pickdef-hung-root-')
    const lib = join(holder, '书库丁')
    mkdirSync(join(lib, '.clwriting'), { recursive: true })
    await freshWithStore({ current: lib, recent: [] })
    // 挂死闸：stat 永不落定（模拟网络卷无响应）——起点探测须在预算内放弃，对话框照弹
    fsPromisesMock.statGate = () => new Promise<never>(() => {})
    try {
      const t0 = Date.now()
      const opts = await openLibraryOpts()
      expect(opts).not.toHaveProperty('defaultPath')
      expect(Date.now() - t0).toBeLessThan(5_000) // 预算 500ms；此处只锚「未挂死」
    } finally {
      fsPromisesMock.statGate = null
    }
  })

  it('记忆随落库刷新：切库落库 → 重启后 bootstrap 采用新 current，起点跟着换', async () => {
    const holderA = mkTmp('clw-pickdef-a-')
    const holderB = mkTmp('clw-pickdef-b-')
    const libA = join(holderA, '书库A')
    const libB = join(holderB, '书库B')
    for (const l of [libA, libB]) mkdirSync(join(l, '.clwriting'), { recursive: true })
    await freshWithStore({ current: libA, recent: [] })
    expect((await openLibraryOpts())['defaultPath']).toBe(holderA)

    // 切库落库（switch-library 链）→ workdir.json 的 current 换 libB
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean }
    expect(r.ok).toBe(true)
    // 生产链以重启兑现切库（relaunch 100ms 后武装）：重启后 bootstrap 读到的即新 current
    await reimportMain()
    expect((await openLibraryOpts())['defaultPath']).toBe(holderB)
  })
})
