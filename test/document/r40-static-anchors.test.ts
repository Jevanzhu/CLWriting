/**
 * R40（四十轮）修复批静态锚：无法/不宜行为化的修复点以源码扫描钉住
 * （先例：r38-batch-f 的「零裸 renameSync」静态扫描）。
 *
 * - R40-20：executeSave 新 revision 从刚写入字节派生（computeRevisionBytes），不再写后重读盘
 * - R40-21：export warnings 全部走 relPosix（win 反斜杠不进警告文案）
 * - R40-24：save 新建分支 PATH_ESCAPE 消毒闸 + isSanitizedCreatePath 判定在位
 * - R40-38：inflightOpens 删键前 identity 比对（对齐 inflightSaves R33-12 口径）
 * - R40-42：⌘ tooltip 五处全走 mod-key 平台单源，静态写死清零
 * - R40-4：style-harvest 任务闸接线 + KNOWN_ACTIONS 登记（治理对账前提）
 * - R40-50：rag status 端点透出 indexState（RAG_RESET_MARKER_KEY 消费）
 * - R40-25：books.jsonl 读侧剥 BOM
 * - R40-45：CmHost getSelectionRect 死导出移除
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const read = (...segs: string[]): string => readFileSync(join(srcRoot, ...segs), 'utf-8')

describe('R40 静态锚：document/export', () => {
  it('R40-20：executeSave 用 computeRevisionBytes 从写入字节派生新 revision', () => {
    const src = read('document', 'service.ts')
    expect(src).toMatch(/R40-20（四十轮）：单写派生/)
    expect(src).toMatch(/computeRevisionBytes\(\s*typeof content === 'string'/)
  })

  it('R40-24：save 新建分支 PATH_ESCAPE 闸在位', () => {
    const src = read('document', 'service.ts')
    expect(src).toMatch(/isSanitizedCreatePath\(relPath\)/)
    expect(src).toContain("code: 'PATH_ESCAPE'")
  })

  it('R40-21：export/index.ts warnings 不再有裸 relative() 插值', () => {
    const src = read('export', 'index.ts')
    expect(src).not.toMatch(/warnings\.push\(`\$\{relative\(/)
    expect(src).toContain('relPosix(e.file)')
  })
})

describe('R40 静态锚：web-next', () => {
  it('R40-38：inflightOpens 删键前 identity 比对', () => {
    expect(read('studio', 'web-next', 'src', 'stores', 'doc.ts')).toMatch(/inflightOpens\.get\(docId\) === p/)
  })

  it('R40-42：⌘ 组合键 tooltip 五处全走 mod-key 单源（静态写死清零）', () => {
    expect(read('studio', 'web-next', 'src', 'shared', 'mod-key.ts')).toContain('export function modComboLabel')
    const head = read('studio', 'web-next', 'src', 'components', 'editor', 'EditorDocHead.vue')
    expect(head).toContain(':data-tip="saveTip"')
    expect(read('studio', 'web-next', 'src', 'components', 'shell', 'TabBar.vue')).toContain('focusKey')
    const ribbon = read('studio', 'web-next', 'src', 'components', 'shell', 'Ribbon.vue')
    expect(ribbon).toContain(':data-tip="treeTip"')
    expect(ribbon).toContain(':data-tip="settingsTip"')
    expect(read('studio', 'web-next', 'src', 'components', 'shell', 'WorkspaceShell.vue')).toContain(':title="focusExitTitle"')
    // 五个文件均不再有静态写死的 ⌘ tip/title
    for (const f of [
      'components/editor/EditorDocHead.vue',
      'components/shell/TabBar.vue',
      'components/shell/Ribbon.vue',
      'components/shell/WorkspaceShell.vue',
    ]) {
      expect(read('studio', 'web-next', 'src', ...f.split('/'))).not.toMatch(/(?:data-tip|title)="[^"]*⌘/)
    }
  })

  it('R40-45：CmHost getSelectionRect 死导出已移除', () => {
    // 只查定义/调用形态——R40-45 行内留有移除记档注释（字面量出现不算残留）
    expect(read('studio', 'web-next', 'src', 'editor', 'CmHost.vue')).not.toMatch(/getSelectionRect\s*[(:]/)
  })
})

describe('R40 静态锚：服务端与工程', () => {
  it('R40-4：收割端点任务闸接线 + KNOWN_ACTIONS 登记', () => {
    expect(read('studio', 'server', 'api', 'style.ts')).toMatch(/acquireTaskGate\(params\['name'\]!, 'style-harvest'\)/)
    const gate = read('studio', 'server', 'api', 'task-gate.ts')
    expect(gate).toContain("'style-harvest'")
  })

  it('R40-50：rag status 端点透出 indexState', () => {
    const src = read('studio', 'server', 'api', 'rag.ts')
    expect(src).toContain('RAG_RESET_MARKER_KEY')
    expect(src).toContain('indexState')
  })

  it('R40-25：books.jsonl 读侧剥 BOM', () => {
    expect(read('install', 'books.ts')).toContain("replace(/^\\uFEFF/, '')")
  })
})
