/**
 * R71-30（七十一轮）回归：sanitizeName 不拒绝 Windows 保留设备名
 * （CON/PRN/AUX/NUL/COM1-9/LPT1-9，含 CON.md 形态，大小写不敏感）。
 *
 * 修复：保留名表比对主文件名段（首个点前段，与 Win 实际语义对齐），
 * 命中返回 null；新建入口 onCreateCommit 文案补「Windows 保留名」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { sanitizeName } from '../../../src/studio/web-next/src/shared/chapter-tree'

// ---------- 用户入口桩（onCreateCommit 文案用，对齐 r64-switch-guards 惯例） ----------
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  grouped: [
    { path: '大纲', name: '大纲', isDirectory: true, role: '', children: [], docId: null },
  ] as never[],
  raw: [] as never[],
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
  getContent: vi.fn(async () => '内容'),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: vi.fn(), ask: vi.fn(async () => true) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  // E-3（二十九轮）：startCreate 自动展开改走 setTreeExpanded——mock 补该动作
  useWorkspaceStore: vi.fn(() => ({ openTab: vi.fn(), activeDocId: ref(null), treeExpanded: [], setTreeExpanded: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))

import { createDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const createMock = createDoc as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R71-30: sanitizeName 拒收 Windows 保留名（主文件名段、大小写不敏感）', () => {
  // 拒收：裸名 + 带扩展（含多段扩展——主文件名段命中即非法）
  it.each(['con.md', 'CON', 'Con', 'cOn', 'NUL', 'nul.md', 'PRN.md', 'aux.tar.gz', 'Com1.tar.md', 'com3', 'lpt9.md', 'LPT1'])(
    '「%s」被拒（null）',
    (name) => {
      expect(sanitizeName(name)).toBeNull()
    },
  )

  // 放行：console 不在保留表；中文正常；前后空白照旧 trim
  it.each([
    ['console.md', 'console.md'],
    ['联系.md', '联系.md'],
    ['第12章-冲突', '第12章-冲突'],
    ['  con风格的标题.md', 'con风格的标题.md'], // 主文件名段是「con风格的标题」≠ con
  ])('「%s」放行 → %s', (name, expected) => {
    expect(sanitizeName(name)).toBe(expected)
  })

  // 既有校验不回退（同一入口的老规则）
  it.each(['', '  ', 'a/b', 'a\\b', '.hidden', 'a\x01b'])('「%s」仍被既有规则拒收', (name) => {
    expect(sanitizeName(name)).toBeNull()
  })
})

describe('R71-30: 新建入口保留名报错文案', () => {
  it('inline 新建提交 con → openError 含「Windows 保留名」且不发请求', async () => {
    const openError = ref<string | null>(null)
    const actions = useChapterTreeActions({ bookName: () => '书A', openError })
    actions.startCreate('doc', '大纲', '大纲')
    await actions.onCreateCommit('con')
    expect(openError.value).toContain('Windows 保留名')
    expect(createMock).not.toHaveBeenCalled()
  })
})
