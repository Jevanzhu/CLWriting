/**
 * 0918独立重评修复批（D002）回归门：saveProvidersLocked 锁内写前 revision 基线复验。
 *
 * 缺陷机理：跨进程锁争用时快路转异步排队（serializedLockedWrite 保调用序 = 落盘序），
 * 后到请求在先者落盘前 loadProviders 读到旧 revision，双方 expectedRevision 各自过闸，
 * 队列序落盘后到者按旧快照整态覆盖先者（丢更新）。
 *
 * 修法：saveProvidersLocked 写前读盘复验——盘上 revision ≠ 本操作基于的 revision
 * （store 快照的 revision；全部生产调用方均为 loadProviders 派生）即拒绝落盘并上抛
 * ProviderRevisionConflictError（API 层 saveProvidersOr500 映射既有 409 REVISION_CONFLICT）。
 *
 * 漂移模拟口径：「另一进程落盘」以直接改盘上文件表达（跨进程写不进本进程写链，注入
 * 本链反而会被串行到本写之后、无法构造漂移）——读盘 JSON bump revision + 加他写方
 * marker 行。损坏文件（读不出 revision）跳过复验的 bak 自愈通道单列钉死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import {
  loadProviders,
  saveProviders,
  emptySettings,
  processProviderRuntime,
  ProviderRevisionConflictError,
  type ProviderStore,
} from '../../../src/ai/provider/store.js'
import type { ProviderConf } from '../../../src/ai/provider/types.js'

function makeConf(overrides: Partial<ProviderConf> = {}): ProviderConf {
  return {
    id: 'prov-a',
    name: '测试供应商',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey: 'sk-d002-secret-0001',
    caps: null,
    sortIndex: 0,
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'd002-drift-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FP = (): string => join(dir, 'providers.json')

/** 直接改盘上文件模拟「另一进程已落盘」：revision +1 并追加他写方 marker 行。 */
function driftDiskByOtherWriter(): void {
  const raw = JSON.parse(readFileSync(FP(), 'utf8')) as {
    revision: number
    providers: Array<Record<string, unknown> & { id: string }>
  }
  raw.revision += 1
  raw.providers.push({ id: 'other-writer', name: '他写方', protocol: 'openai', auth: 'bearer', baseUrl: 'https://other.example.com', sortIndex: 99 })
  writeFileSync(FP(), JSON.stringify(raw, null, 2), 'utf8')
}

function seedOneProvider(id: string): ProviderStore {
  const s = emptySettings()
  s.providers = [makeConf({ id, apiKey: `sk-${id}-secret` })]
  s.currentId = id
  saveProviders(dir, s) // 文件缺失 → 基线 0，首写落盘 revision 1
  return s
}

describe('0918独立重评修复批 D002：写前 revision 基线复验', () => {
  it('正常路径（无漂移）：load→mutate→save 照常落盘，revision +1，行为不变', () => {
    seedOneProvider('a')
    const s = loadProviders(dir)
    expect(s.revision).toBe(1)
    s.providers.push(makeConf({ id: 'b', apiKey: 'sk-b-secret' }))
    saveProviders(dir, s)
    const disk = JSON.parse(readFileSync(FP(), 'utf8')) as { revision: number; providers: Array<{ id: string }> }
    expect(disk.revision).toBe(2)
    expect(disk.providers.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('快路漂移：load 后他写方落盘 → save 同步拒绝（冲突错误）+ 盘上不被覆盖 + 基线不 bump', () => {
    seedOneProvider('a')
    const stale = loadProviders(dir) // 基线 revision 1
    expect(stale.revision).toBe(1)
    stale.providers.push(makeConf({ id: 'stale-row', apiKey: 'sk-stale-secret' }))

    driftDiskByOtherWriter() // 盘上 revision 2 + other-writer 行

    expect(() => saveProviders(dir, stale)).toThrow(ProviderRevisionConflictError)
    // 盘上保持他写方内容：revision 未被 stale 快照整态覆盖、stale-row 未混入
    const disk = JSON.parse(readFileSync(FP(), 'utf8')) as { revision: number; providers: Array<{ id: string }> }
    expect(disk.revision).toBe(2)
    expect(disk.providers.map((p) => p.id)).toEqual(['a', 'other-writer'])
    // 被拒 store 的 revision 不被写后 +1（调用方刷新重读后可重放）
    expect(stale.revision).toBe(1)
  })

  it('冲突错误形态：人话文案对齐既有 REVISION_CONFLICT 口径，带盘上/基线诊断字段', () => {
    seedOneProvider('a')
    const stale = loadProviders(dir)
    driftDiskByOtherWriter()
    let err: unknown
    try {
      saveProviders(dir, stale)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProviderRevisionConflictError)
    const conflict = err as ProviderRevisionConflictError
    expect(conflict.message).toBe('配置已在其他窗口被修改，请刷新')
    expect(conflict.diskRevision).toBe(2)
    expect(conflict.baseRevision).toBe(1)
  })

  it('排队写窗口漂移：在途段落盘前他写方先行 → 排队段执行时拒绝 + warn 留痕 + 盘上保留他写方内容', async () => {
    seedOneProvider('a')
    const stale = loadProviders(dir) // 基线 revision 1
    stale.providers.push(makeConf({ id: 'queued-row', apiKey: 'sk-queued-secret' }))

    // 模拟跨进程锁争用：注入在途段 → 本写转排队（serializedLockedWrite 排队分支）
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    processProviderRuntime().__seedProvidersWriteChainForTest(dir, gate)
    const queued = saveProviders(dir, stale)

    // 在途窗口内「另一进程」完成落盘（直改盘文件；本进程写链被 gate 占住，恰好表达跨进程时序）
    driftDiskByOtherWriter()

    release() // 在途段结束 → 排队段执行：基线复验读盘见漂移 → 拒绝

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(queued).rejects.toBeInstanceOf(ProviderRevisionConflictError)
      // 排队段失败旁挂 warn 留痕（不静默吞——serializedLockedWrite queuedWarn 口径）
      expect(warn.mock.calls.some((c) => String(c[0]).includes('排队'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
    // 盘上保持他写方内容：revision 2 + other-writer 在、queued-row 未覆盖混入
    const disk = JSON.parse(readFileSync(FP(), 'utf8')) as { revision: number; providers: Array<{ id: string }> }
    expect(disk.revision).toBe(2)
    expect(disk.providers.map((p) => p.id)).toEqual(['a', 'other-writer'])
    expect(stale.revision).toBe(1)
  })

  it('legacy 文件无 revision 键：load 基线 0 = 盘上 0，save 照常写（兼容不破）', () => {
    const conf = makeConf({ id: 'legacy-a', apiKey: 'sk-legacy-secret' })
    writeFileSync(FP(), JSON.stringify({ providers: [{ ...conf, apiKey: undefined }], currentId: 'legacy-a' }, null, 2), 'utf8')
    const s = loadProviders(dir)
    expect(s.revision).toBe(0)
    saveProviders(dir, s) // 盘上无 revision 键 → 0，基线一致 → 放行
    const disk = JSON.parse(readFileSync(FP(), 'utf8')) as { revision: number }
    expect(disk.revision).toBe(1)
  })

  it('盘上文件损坏（读不出 revision）→ 复验跳过，save 照常落盘（bak 自愈通道不被挡死）', () => {
    seedOneProvider('a')
    writeFileSync(FP(), '{ broken json !!!', 'utf8')
    const s = emptySettings()
    s.providers = [makeConf({ id: 'heal', apiKey: 'sk-heal-secret' })]
    s.currentId = 'heal'
    saveProviders(dir, s) // 基线读失败 → null → 跳过复验（损坏文件无有意义基线可护）
    const disk = JSON.parse(readFileSync(FP(), 'utf8')) as { revision: number; providers: Array<{ id: string }> }
    expect(disk.revision).toBe(1)
    expect(disk.providers.map((p) => p.id)).toEqual(['heal'])
  })
})
