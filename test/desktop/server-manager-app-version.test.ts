/**
 * 阶段 53 S2：server-manager 的 `CLW_APP_VERSION` 下发面（清洗 + 注入 + 缺省不注入）。
 *
 * 体例同 server-manager 拆分件族（R0916-5b）：共享假件与装置见
 * ./server-manager-fixtures.js；本件只覆盖版本 env 面（新建，非原文件搬移）。
 *
 * 口径（照 token / CLW_OS_KEK 的同款两级纪律）：宿主残留（含 win 混写变体）逐键
 * 大小写不敏感清除后再按 opts 注入；缺省（dev/测试形态）**不注入**——child 回落
 * 读 package.json（设计 §3.1）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkHarness, mkUserData, cleanupServerManagerTmpDirs } from './server-manager-fixtures.js'

function childEnv(record: { options: Record<string, unknown> }): Record<string, string | undefined> {
  return record.options['env'] as Record<string, string | undefined>
}

describe('阶段 53 S2：CLW_APP_VERSION 下发', () => {
  it('opts.appVersion → child env 注入同名键', async () => {
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: mkUserData(), appVersion: '3.2.1' })
    expect(childEnv(forkRecords[0]!)['CLW_APP_VERSION']).toBe('3.2.1')
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    await manager.stopChild()
  })

  it('宿主残留同名 → child 收到注入值（残留不穿透、process.env 不动）', async () => {
    vi.stubEnv('CLW_APP_VERSION', 'stale-host-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData(), appVersion: '1.0.0' })
      const env = childEnv(forkRecords[0]!)
      expect(env['CLW_APP_VERSION']).toBe('1.0.0') // 残留值不穿透
      expect(Object.values(env)).not.toContain('stale-host-residue')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
      await p
      await manager.stopChild()
      // 只动拷贝：宿主 process.env 原样保留
      expect(process.env['CLW_APP_VERSION']).toBe('stale-host-residue')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // win 环境名大小写不敏感——残留混写变体此前躲过大写 delete 形成双重键、child
  // 取值未指定（版本基准被旧值劫持）。逐键 toUpperCase 清除后只剩大写受控键。
  it('宿主残留混写变体 → child env 无双重键，仅大写受控值', async () => {
    vi.stubEnv('clw_app_version', 'stale-lower-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData(), appVersion: '1.0.0' })
      const env = childEnv(forkRecords[0]!)
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_APP_VERSION')).toEqual([
        'CLW_APP_VERSION',
      ])
      expect(env['CLW_APP_VERSION']).toBe('1.0.0')
      expect(Object.values(env)).not.toContain('stale-lower-residue')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('未传 opts.appVersion → 不注入（child 回落读 package.json）', async () => {
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const env = childEnv(forkRecords[0]!)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_APP_VERSION')).toEqual([])
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    await manager.stopChild()
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
