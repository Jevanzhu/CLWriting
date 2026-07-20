/**
 * W2A T9 §9.3 —— 大书扫描性能验证。
 *
 * 造 250 章（5 卷 × 50 章）大书 fixture，测 buildTree（含 frontmatter 读 + git 脏集 + 清单合并）
 * 与缓存命中耗时。方案预算：本地 SSD < 200ms；防回归阈值留余量（CI/慢机）。
 *
 * 不做：watcher（§9.2 守 0 依赖红线）、精确 SLA（性能验证非硬约束，宽松防严重回归）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  buildTree,
  scanBookTree,
  getBookTreeIndex,
  invalidateTreeIndex,
  type TreeNode,
} from '../../src/document/tree.js'

const VOL = 5
const CH = 50 // 250 章（方案「200+ 章」）
let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-perf-'))
  const lines = ['{"version":1,"type":"header"}']
  for (let v = 1; v <= VOL; v++) {
    const vol = `卷${v}`
    mkdirSync(join(root, '定稿', '正文', vol), { recursive: true })
    mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '卷纲', `${vol}.md`), `# ${vol} 卷纲\n`, 'utf-8')
    for (let c = 1; c <= CH; c++) {
      const n = (v - 1) * CH + c
      const ch = String(n).padStart(4, '0')
      const rel = `定稿/正文/${vol}/${ch}-章${n}.md`
      writeFileSync(
        join(root, ...rel.split('/')),
        `---\n章号: ${n}\n标题: 章${n}\n---\n第${n}章正文。`,
        'utf-8',
      )
      lines.push(
        JSON.stringify({ id: `doc_${n}`, nodeType: 'document', path: rel, parentId: null, status: 'final' }),
      )
    }
  }
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '项目', '文档清单.jsonl'), lines.join('\n') + '\n', 'utf-8')
  execSync(
    'git init -q && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false && git add -A && git commit -qm init',
    { cwd: root, stdio: 'pipe' },
  )
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 只数 定稿/正文/ 下的章（性能验证针对正文扫描规模；卷纲/清单不计）。 */
function countChapters(ns: TreeNode[]): number {
  let c = 0
  for (const n of ns) {
    if (!n.isDirectory && n.path.startsWith('定稿/正文/')) c++
    else if (n.isDirectory) c += countChapters(n.children)
  }
  return c
}

describe('tree 大书性能（§9.3）', () => {
  it(`扫描 ${VOL * CH} 章（${VOL} 卷）：buildTree 含派生 + 清单 + 卷纲关联`, () => {
    invalidateTreeIndex(root)
    const t0 = performance.now()
    const nodes = buildTree(root)
    const dt = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`  buildTree ${VOL * CH} 章: ${dt.toFixed(1)}ms`)
    expect(countChapters(nodes)).toBe(VOL * CH)
    // 方案本地目标 < 200ms；防回归阈值 1000ms（CI/慢机留余量，超标才告警优化）
    expect(dt).toBeLessThan(1000)
  })

  it('纯目录扫描 scanBookTree（无派生/清单/git）', () => {
    const t0 = performance.now()
    const nodes = scanBookTree(root)
    const dt = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`  scanBookTree ${VOL * CH} 章: ${dt.toFixed(1)}ms`)
    expect(countChapters(nodes)).toBe(VOL * CH)
  })

  it('缓存命中：二次 getBookTreeIndex 近瞬时（§9.1 缓存生效）', () => {
    invalidateTreeIndex(root)
    getBookTreeIndex(root) // 首次构建 + 入缓存
    const t0 = performance.now()
    getBookTreeIndex(root) // 命中
    const dt = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`  缓存命中: ${dt.toFixed(3)}ms`)
    expect(dt).toBeLessThan(5)
  })
})
