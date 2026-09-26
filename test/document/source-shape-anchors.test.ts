/**
 * R40（四十轮）修复批静态锚：无法/不宜行为化的修复点以源码扫描钉住
 * （先例：r38-batch-f 的「零裸 renameSync」静态扫描）。
 *
 * - R40-20：executeSave 新 revision 从刚写入字节派生（computeRevisionBytes），不再写后重读盘
 * - R40-21：export warnings 全部走 relPosix（win 反斜杠不进警告文案）
 * - R40-24：save 新建分支 PATH_ESCAPE 消毒闸 + isSanitizedCreatePath 判定在位
 * - R40-38：inflightOpens 删键前 identity 比对（对齐 inflightSaves R33-12 口径）
 * - R40-42：⌘ tooltip 五处全走 mod-key 平台单源，静态写死清零
 * - R40-4：style-harvest 任务闸接线（action token 由调用点固定；登记表已随 R0916-7-P3-14 删除）
 * - R40-50：rag status 端点透出 indexState（RAG_RESET_MARKER_KEY 消费）
 * - R40-45：CmHost getSelectionRect 死导出移除
 *
 * 保留为源码锚的理由：下列修复点的「修复前/外部行为」等价——新 revision 无论从写入字节
 * 派生还是写后重读盘都返回同一值；export warnings 走 relPosix 与否在单平台下文案相同；
 * 死导出移除对运行期零影响；UI 组件（web-next）无组件级测试面——外部无可观测面可分辨，
 * 只能钉形态。已有行为面覆盖的锚点一律删除、不留空转断言（R40-25 books.jsonl 剥 BOM 已
 * 由 test/install/books-store-primitives.test.ts 的读侧行为直测覆盖，故本文件删除该锚）。
 * 形态断言一律容错到「语义锚」粒度（如闸的取用形态可从模块函数演进为注入对象），
 * 只锚意图不锚字面排版。
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
    // 标签行随注释清理批删除（批号标签不再回填源码），锚改挂下面两行派生调用本体
    // PM-4（性能与内存专项·2026-09-05）：单次 Buffer 化（contentBytes）与写盘共用同一份
    // 字节——锚从「内联 typeof content 三元」改挂新形，意图不变：新 rev 派生自写入字节
    // 而非写后重读盘。
    expect(src).toMatch(
      /const contentBytes = typeof content === 'string' \? Buffer\.from\(content, 'utf-8'\) : content/,
    )
    expect(src).toMatch(/const newRev = computeRevisionBytes\(contentBytes\)/)
    expect(src).not.toMatch(/computeRevisionBytes\(\s*typeof content === 'string'/)
  })

  it('R40-24：save 新建分支 PATH_ESCAPE 闸在位', () => {
    const src = read('document', 'service.ts')
    expect(src).toMatch(/isSanitizedCreatePath\(relPath\)/)
    expect(src).toContain("code: 'PATH_ESCAPE'")
  })

  it('R40-21：export/index.ts warnings 路径一律走 relPosix 家族（无裸 relative 插值）', () => {
    const src = read('export', 'index.ts')
    // R0916-7-P3-2：导出拆六阶段后 helper 带 bookRoot 参数改名 relPosixIn，
    // 语义锚（warnings 里出现路径即走该 helper）不变——正断言改锚 helper 定义件 + 插值点
    expect(src).not.toMatch(/warnings\.push\(`\$\{relative\(/)
    expect(src).toContain('function relPosixIn(')
    expect(src).toMatch(/warnings\.push\(`\$\{relPosixIn\(/)
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
    expect(read('studio', 'web-next', 'src', 'components', 'shell', 'WorkspaceShell.vue')).toContain(
      ':title="focusExitTitle"',
    )
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
  it('R40-4：收割端点任务闸接线（action token 由调用点固定）', () => {
    // R0916-7-P3-14：原第二断言钉 task-gate.ts 内的 KNOWN_ACTIONS 登记表——该表已
    // 随「锁文件名改 ${action}.${hash(book)}.lock、列目录即枚举」删除；对账门改
    // action token 门（扫 acquireTaskGate 调用点字面量），见 test/governance/known-actions-audit.test.ts
    // 形状容错：闸入口从模块函数 acquireTaskGate 演进为组装根注入的 ctx.gate.acquire
    // （P3-6 依赖注入化）——锚的是「action token 字面量固定在调用点」，不锚闸的取用形态
    expect(read('studio', 'server', 'api', 'style.ts')).toMatch(/\.acquire\(params\['name'\]!, 'style-harvest'\)/)
  })

  it('R40-50：rag status 端点透出 indexState', () => {
    const src = read('studio', 'server', 'api', 'rag.ts')
    expect(src).toContain('RAG_RESET_MARKER_KEY')
    expect(src).toContain('indexState')
  })

  // R40-25（books.jsonl 读侧剥 BOM）的静态锚已删除：行为面直测已覆盖该修复点——
  // test/install/books-store-primitives.test.ts「坏行跳过 + BOM 前缀剥除」以 BOM 开头的
  // books.jsonl 直读 readBooks，断言条目照常解析（修复前该臂整表判坏、回落空表）。
})
