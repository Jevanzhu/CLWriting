/**
 * R0916-5b（2026-09-16）：server-manager.test.ts（1430 行）按 describe 域拆分件之一——
 * 「studioToken 与 env 剥除面」域（U-6 A/二轮 F-5：token 首启生成 + 原子持久化 +
 * 跨 manager 复用 + manager 内内存复用 + 损坏重生成；N-1/R1W-6/R41-7/R43-26 宿主
 * 残留 env 剥除族）。用例自原文件 242-376 行整块原样搬移（describe/test 名称、断言、
 * mock 行为零变化）；共享假件与装置见 ./server-manager-fixtures.js。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mkHarness,
  mkUserData,
  envToken,
  UUID_RE,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'

describe('批 U1：studioToken（U-6 A / 二轮 F-5）', () => {
  it('首启生成 + 原子持久化 studio-token.json；跨 manager（跨 main 重启）token 不变', async () => {
    const ud = mkUserData()
    const h1 = mkHarness()
    const p1 = h1.manager.start({ workDir: null, userDataPath: ud })
    const token1 = envToken(h1.forkRecords[0]!)
    h1.forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await h1.manager.stopChild()
    const stored = JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')) as { token: string }
    expect(stored.token).toBe(token1)
    // 新 manager（模拟 main 重启后 fork）：读同一文件复用同一 token
    const h2 = mkHarness()
    const p2 = h2.manager.start({ workDir: null, userDataPath: ud })
    expect(envToken(h2.forkRecords[0]!)).toBe(token1)
    h2.forkRecords[0]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await h2.manager.stopChild()
  })

  it('manager 内内存复用：token 文件被改也不换（启动读入一次，fork 一律用内存值）', async () => {
    const ud = mkUserData()
    const { forkRecords, manager } = mkHarness()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    const token1 = envToken(forkRecords[0]!)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await manager.stopChild()
    // 会话中途文件损坏/被改 → 重启 child 仍用内存值（前端 token 不失效）
    writeFileSync(join(ud, 'studio-token.json'), JSON.stringify({ token: 'tampered' }))
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    expect(envToken(forkRecords[1]!)).toBe(token1)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await manager.stopChild()
  })

  it('文件损坏/缺失 → 重生成覆写（窄边只影响下次启动）', async () => {
    const ud = mkUserData()
    writeFileSync(join(ud, 'studio-token.json'), 'not-json{')
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: ud })
    const token = envToken(forkRecords[0]!)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    await manager.stopChild()
    expect(JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')).token).toBe(token)
  })

  // N-1（第五十四轮）：宿主 process.env 残留 CLW_STUDIO_TOKEN 不得穿透覆盖注入值——
  // fork env 拷贝上显式 delete 后再注入受控值（process.env 本身不动）
  it('N-1：宿主残留同名 env → child 收到的是注入 token（残留值不穿透、process.env 不动）', async () => {
    vi.stubEnv('CLW_STUDIO_TOKEN', 'stale-host-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const token = envToken(forkRecords[0]!)
      expect(token).not.toBe('stale-host-residue') // 残留值不穿透
      expect(token).toMatch(UUID_RE) // 注入的是受控生成/持久化值
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      expect(env['CLW_STUDIO_TOKEN']).toBe(token) // child env 侧即受控值
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
      await p
      await manager.stopChild()
      // 只动拷贝：宿主 process.env 的残留值原样保留
      expect(process.env['CLW_STUDIO_TOKEN']).toBe('stale-host-residue')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // R1W-6（win 平台专项复审 R1）：win 环境名大小写不敏感——残留的小写/混写变体
  // 此前躲过大写 delete 形成双重键、child 取值未指定。逐键 toUpperCase 清除后
  // 子 env 内只剩大写受控键（该断言跨平台成立：posix 上小写键也被循环清掉）。
  it('R1W-6：宿主残留小写变体 env → child env 无大小写双重键，仅大写受控值', async () => {
    vi.stubEnv('clw_studio_token', 'stale-lower-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      const tokenKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_STUDIO_TOKEN')
      expect(tokenKeys).toEqual(['CLW_STUDIO_TOKEN']) // 双重键清除，仅大写受控键
      expect(env['CLW_STUDIO_TOKEN']).not.toBe('stale-lower-residue')
      expect(Object.values(env)).not.toContain('stale-lower-residue')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 2 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // R41-7（四十一轮）：env 大小写清除面补 CLW_LOG_STDOUT——下方注入 CLW_LOG_STDOUT=1，
  // 残留混写变体（clw_log_stdout）同样双键穿透，child 日志形态被旧值劫持
  it('R41-7：宿主残留 clw_log_stdout 变体 → child env 无双重键，仅受控 CLW_LOG_STDOUT=1', async () => {
    vi.stubEnv('clw_log_stdout', 'stale-log-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      const logKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_LOG_STDOUT')
      expect(logKeys).toEqual(['CLW_LOG_STDOUT'])
      expect(env['CLW_LOG_STDOUT']).toBe('1')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 3 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // R43-26（四十三轮）：剥除面补 dev/资源定位变量——宿主残留 CLW_DEV_UI / CLW_DEV_CORS /
  // CLWRITING_RESOURCES_DIR（含 win 混写变体）不得穿透进 child env：dev 双变量会让打包
  // child 的 Origin 白名单放行 5173，资源变量会让 asar 内捆绑资源被宿主残留目录劫持
  //（resources.ts 无打包态检查，剥除即回落模块相对推导）。
  it('R43-26：宿主残留 CLW_DEV_UI/CLW_DEV_CORS/CLWRITING_RESOURCES_DIR（含混写变体）→ child env 全剥除', async () => {
    vi.stubEnv('CLW_DEV_UI', '1')
    vi.stubEnv('clw_dev_cors', '1') // 混写变体（win 大小写不敏感残留形态）同剥
    vi.stubEnv('CLWRITING_RESOURCES_DIR', '/stale/host/resources')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_DEV_UI')).toEqual([])
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_DEV_CORS')).toEqual([])
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLWRITING_RESOURCES_DIR')).toEqual([])
      expect(Object.values(env)).not.toContain('/stale/host/resources')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 4 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
