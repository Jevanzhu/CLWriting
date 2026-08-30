// @vitest-environment happy-dom
/**
 * R30-26（三十轮）回归——开书梗概键收敛 shared/storage-keys 单一事实源。
 *
 * 缺陷：写入方 OnboardPremise.vue 局部常量 `clwriting:onboard-premise:${n}` 与清除方
 * useShelf 删书清扫各自硬编码同串——正是 R28-3 为 tree-first-open 键修掉的「写入/清除
 * 键名断裂」同族隐患（一侧改格式另一侧静默失配，删书清不掉旧梗概）。修复：新增
 * onboardPremiseKey 键工厂，写入/清除两侧共用。落盘格式（冒号形态）不变，历史数据兼容。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { onboardPremiseKey, treeFirstOpenKey } from '../../../src/studio/web-next/src/shared/storage-keys'
import OnboardPremise from '../../../src/studio/web-next/src/components/onboard/OnboardPremise.vue'

const SRC_ROOT = path.resolve(__dirname, '../../../src/studio/web-next/src')

// ── 键工厂 ──

describe('storage-keys · onboardPremiseKey（R30-26）', () => {
  it('产出历史冒号形态（落盘格式锁——改格式即丢历史草稿，禁止静默变更）', () => {
    expect(onboardPremiseKey('书A')).toBe('clwriting:onboard-premise:书A')
    expect(onboardPremiseKey('en-book-1')).toBe('clwriting:onboard-premise:en-book-1')
  })

  it('不同书名产出不同键（同名书共享、异名书隔离）', () => {
    expect(onboardPremiseKey('书A')).not.toBe(onboardPremiseKey('书B'))
    expect(onboardPremiseKey('')).toBe('clwriting:onboard-premise:')
  })

  it('与首开键工厂同源并存、互不串键（R28-3 回归不回退）', () => {
    expect(treeFirstOpenKey('书A')).toBe('clw2.tree-first-open.书A')
    expect(treeFirstOpenKey('书A')).not.toBe(onboardPremiseKey('书A'))
  })
})

// ── 仓内无残留硬编码（源码静态扫描）──

describe('storage-keys · 硬编码残留扫描（R30-26）', () => {
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) out.push(...(await walk(p)))
      else if (/\.(ts|vue)$/.test(ent.name)) out.push(p)
    }
    return out
  }

  it('src/** 内除 storage-keys.ts 外无 `clwriting:onboard-premise` 字面量（防双源再分叉）', async () => {
    const files = await walk(SRC_ROOT)
    expect(files.length).toBeGreaterThan(10) // 扫描路径有效性自证
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith(`${path.sep}shared${path.sep}storage-keys.ts`)) continue // 单一事实源本体
      const text = await fsp.readFile(f, 'utf8')
      if (text.includes('clwriting:onboard-premise')) offenders.push(path.relative(SRC_ROOT, f))
    }
    expect(offenders).toEqual([])
  })

  it('写入方与清除方均经键工厂取键（onboardPremiseKey 在两处出现）', async () => {
    const premise = await fsp.readFile(path.join(SRC_ROOT, 'components/onboard/OnboardPremise.vue'), 'utf8')
    const shelf = await fsp.readFile(path.join(SRC_ROOT, 'composables/useShelf.ts'), 'utf8')
    expect(premise).toContain('onboardPremiseKey(')
    expect(shelf).toContain('onboardPremiseKey(')
  })
})

// ── 写入/清除两侧同源（端到端：组件落盘 → 删书清扫）──

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({ clearFalsePositiveMarks: mocks.clearFalsePositiveMarks }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiJson: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（照 prefs-store 范型）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal('localStorage', createLocalStorage())

describe('R30-26: 梗概键写入/清除两侧同源（端到端）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** fake timers 下等 Vue 微任务调度排空（onMounted 回填 / watch flush） */
  async function nextTickFlush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }

  it('组件写入的键（工厂拼法）与 useShelf 删书清除的键一致 → 删书后不残留', async () => {
    // 写入侧：OnboardPremise 卸载冲刷落盘（键出自 onboardPremiseKey）
    const w = mount(OnboardPremise, { props: { bookName: '书测', modelValue: '' } })
    await nextTickFlush()
    await w.find('textarea').setValue('书测的设想')
    w.unmount() // R65-51 卸载冲刷：防抖在途也立即落盘
    expect(localStorage.getItem(onboardPremiseKey('书测'))).toBe('书测的设想')

    // 清除侧：useShelf.confirmDelete 用同一工厂拼键清扫
    mocks.deleteBook.mockResolvedValue(undefined)
    const { useShelf } = await import('../../../src/studio/web-next/src/composables/useShelf')
    const s = useShelf()
    s.requestDelete(['书测'])
    await s.confirmDelete()
    expect(localStorage.getItem(onboardPremiseKey('书测'))).toBeNull()
  })

  it('他书梗概键不受牵连（按书名精确清扫）', async () => {
    localStorage.setItem(onboardPremiseKey('书留'), '别书的设想')
    mocks.deleteBook.mockResolvedValue(undefined)
    const { useShelf } = await import('../../../src/studio/web-next/src/composables/useShelf')
    const s = useShelf()
    s.requestDelete(['书删'])
    await s.confirmDelete()
    expect(localStorage.getItem(onboardPremiseKey('书留'))).toBe('别书的设想')
  })
})
