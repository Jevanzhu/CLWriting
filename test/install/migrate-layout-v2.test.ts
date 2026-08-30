import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV2 } from '../../src/install/migrate-layout-v2.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// R70-32（十八轮）：symlink 能力探测守卫（dangling 链用例——非特权 win 建链 EPERM；
// GH win runner 以管理员跑大概率可建，本地与 CI 口径对齐库内 skipIf 惯例）
const canSymlink = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'clw-symlink-probe-'))
    symlinkSync(join(d, 'a'), join(d, 'b'))
    rmSync(d, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
})()


let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-migrate-v2-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 写占位文件（自动建父目录）。 */
function write(rel: string, content = '占位'): void {
  const segs = rel.split('/')
  mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
  writeFileSync(join(tmp, ...segs), content, 'utf-8')
}

/** 判相对路径是否存在。 */
function has(rel: string): boolean {
  return existsSync(join(tmp, ...rel.split('/')))
}

// ── 长篇书库完整迁移 ──────────────────────────────

test('长篇书库：v1 目录 → v2', () => {
  write('定稿/正文/第一卷/0001-开篇.md')
  write('定稿/设定/角色/主角.md')
  write('定稿/设定/世界观.md')
  write('大纲/总纲.md')
  write('大纲/卷纲/第一卷.md')
  write('大纲/章纲/0001-开篇.md')
  write('大纲/悬念/001-谜团.md')
  write('大纲/感情线/001-初遇.md')
  write('工作区/草稿-1.md')
  write('工作区/细纲.md')
  // 运行时资产（不应被搬）
  write('工作区/.journal/doc_x.jsonl')
  write('工作区/.snapshots/doc_x/001.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])

  // 正文 + 卷子目录整体搬迁
  expect(has('写作/正文/第一卷/0001-开篇.md')).toBe(true)
  // 设定提升根级
  expect(has('设定/角色/主角.md')).toBe(true)
  expect(has('设定/世界观.md')).toBe(true)
  // 线索 → 布线
  expect(has('布线/悬念/001-谜团.md')).toBe(true)
  expect(has('布线/感情线/001-初遇.md')).toBe(true)
  // 大纲纲领类不动
  expect(has('大纲/总纲.md')).toBe(true)
  expect(has('大纲/卷纲/第一卷.md')).toBe(true)
  expect(has('大纲/章纲/0001-开篇.md')).toBe(true)
  // 草稿（R27-130：细纲.md 不再随迁，永久留在 工作区/——运行时 outline 端点写这里）
  expect(has('写作/草稿/草稿-1.md')).toBe(true)
  expect(has('工作区/细纲.md')).toBe(true)
  // 运行时资产保留原位
  expect(has('工作区/.journal/doc_x.jsonl')).toBe(true)
  expect(has('工作区/.snapshots/doc_x/001.md')).toBe(true)
})

// ── 短篇书库：篇即正文，迁到 写作/正文 ───────────

test('短篇书库：篇/ → 写作/正文/（篇即章）', () => {
  write('篇/001-雪夜.md')
  write('清单/001-雪夜.md')
  write('文风/铁律.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  expect(has('写作/正文/001-雪夜.md')).toBe(true)
  expect(has('大纲/章纲/001-雪夜.md')).toBe(true)
  // 文风保留原位（幕后资产）
  expect(has('文风/铁律.md')).toBe(true)
})

// ── 幂等 ──────────────────────────────────────────

test('幂等：第二次跑 migrated=0', () => {
  write('定稿/正文/0001-x.md')
  write('定稿/设定/世界观.md')
  write('大纲/悬念/001-x.md')

  const r1 = migrateLayoutV2(tmp)
  expect(r1.errors).toEqual([])
  expect(r1.migrated).toBeGreaterThan(0)

  const r2 = migrateLayoutV2(tmp)
  expect(r2.errors).toEqual([])
  expect(r2.migrated).toBe(0)
})

// ── 运行时资产不动 ────────────────────────────────

test('运行时资产保留原位，草稿搬走', () => {
  write('工作区/.trash/doc_x-旧.md')
  write('工作区/.journal/doc_x.jsonl')
  write('工作区/.snapshots/doc_x/001.md')
  write('工作区/待定稿/0001-x.md')
  write('工作区/草稿-1.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  // 运行时资产不动
  expect(has('工作区/.trash/doc_x-旧.md')).toBe(true)
  expect(has('工作区/.journal/doc_x.jsonl')).toBe(true)
  expect(has('工作区/.snapshots/doc_x/001.md')).toBe(true)
  expect(has('工作区/待定稿/0001-x.md')).toBe(true)
  // 草稿搬走
  expect(has('写作/草稿/草稿-1.md')).toBe(true)
  expect(has('工作区/草稿-1.md')).toBe(false)
})

// ── 空书库 no-op ──────────────────────────────────

test('空书库：no-op', () => {
  const r = migrateLayoutV2(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
})

// ── R65-38（第六十五轮）：同名跳过留痕 + statSync 容错不中断同目录迁移 ──────────

test('R65-38: 同名文件静默跳过 → push 到 errors（孤儿留痕）；同目录其余文件照常迁移', () => {
  // 定稿/正文/ 与 写作/正文/ 同名冲突（部分迁移过的断点形态）
  write('定稿/正文/0001-冲突.md', '旧目录内容（孤儿）')
  write('写作/正文/0001-冲突.md', '新目录已有内容')
  write('定稿/正文/0002-可迁.md', '可迁移文件')
  const r = migrateLayoutV2(tmp)
  // 同名跳过留痕：errors 含告警（旧文件残留旧目录成孤儿，提示手动核对）
  expect(r.errors.some((e) => e.includes('同名跳过') && e.includes('定稿/正文/0001-冲突.md'))).toBe(true)
  // 同目录其余文件照常迁移（修复前同名跳过本身也正常，此断言锁「不中断」）
  expect(has('写作/正文/0002-可迁.md')).toBe(true)
  // 双份内容均未被覆盖
  expect(readFileSync(join(tmp, '定稿', '正文', '0001-冲突.md'), 'utf-8')).toBe('旧目录内容（孤儿）')
  expect(readFileSync(join(tmp, '写作', '正文', '0001-冲突.md'), 'utf-8')).toBe('新目录已有内容')
})

test.skipIf(!canSymlink)('R65-38: statSync 抛错（dangling symlink 源 + 同名目标在位）→ 记 warn 跳过该条，同目录后续文件继续迁', () => {
  mkdirSync(join(tmp, '定稿', '正文'), { recursive: true })
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  // 坏条目：源是 dangling symlink（statSync 跟随 → ENOENT），目标同名文件已存在
  // → 进入同名分支的 statSync 即抛（修复前直穿外层 catch，同目录剩余条目整段跳过）
  symlinkSync(join(tmp, '不存在.md'), join(tmp, '定稿', '正文', '0000-坏链.md'))
  write('写作/正文/0000-坏链.md', '目标在位')
  write('定稿/正文/0001-后续.md', '后续文件')
  const r = migrateLayoutV2(tmp)
  expect(r.errors.some((e) => e.includes('0000-坏链.md') && e.includes('stat 失败'))).toBe(true)
  // 关键回归：坏条目之后的文件仍被迁移（修复前被跳过）
  expect(has('写作/正文/0001-后续.md')).toBe(true)
})

// ── R27-130 / R27-136（二十七轮）：moveDrafts 认领收窄 + 同名跳过留痕 ──────────
// 独立夹具（mkdtempTracked 兜底回收；不复用文件级 tmp，便于局部断言读写）

function r27Fixture(): {
  dir: string
  w: (rel: string, content?: string) => void
  has: (rel: string) => boolean
} {
  const dir = mkdtempTracked(join(tmpdir(), 'clw-migrate-v2-r27-'))
  const w = (rel: string, content = '占位'): void => {
    const segs = rel.split('/')
    mkdirSync(join(dir, ...segs.slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...segs), content, 'utf-8')
  }
  const has = (rel: string): boolean => existsSync(join(dir, ...rel.split('/')))
  return { dir, w, has }
}

/** 读 项目/文档清单.jsonl → Map<id, path>（直测清单投影，不引 manifest 模块）。 */
function manifestPaths(bookRoot: string): Map<string, string> {
  const raw = readFileSync(join(bookRoot, '项目', '文档清单.jsonl'), 'utf-8')
  const m = new Map<string, string>()
  for (const line of raw.trim().split('\n')) {
    const o = JSON.parse(line) as { id?: string; path?: string }
    if (o.id) m.set(o.id, o.path ?? '')
  }
  return m
}

test('R27-130: v2 不再认领 工作区/细纲.md——原地不动、草稿照搬、清单映射同步收窄', () => {
  const { dir, w, has } = r27Fixture()
  w('工作区/细纲.md', '细纲内容（运行时资产，outline 端点永久覆盖写 工作区/细纲.md）')
  w('工作区/草稿-1.md', '草稿内容')
  // 清单含两条旧路径 entry：草稿条目照常重映射；细纲条目须原样（文件不再随迁）
  w(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docA","nodeType":"document","path":"工作区/细纲.md","parentId":null}',
      '{"id":"docB","nodeType":"document","path":"工作区/草稿-1.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV2(dir)
  expect(r.errors).toEqual([])
  // 细纲原地不动（修复前被搬去 写作/草稿/、再由 v3 搬回——每启动两笔 rename + 建删目录）
  expect(has('工作区/细纲.md')).toBe(true)
  expect(has('写作/草稿/细纲.md')).toBe(false)
  // 草稿照搬
  expect(has('写作/草稿/草稿-1.md')).toBe(true)
  expect(has('工作区/草稿-1.md')).toBe(false)
  // 清单：细纲 entry 不再被改写到 写作/草稿/（防悬挂），草稿 entry 照常重映射
  const paths = manifestPaths(dir)
  expect(paths.get('docA')).toBe('工作区/细纲.md')
  expect(paths.get('docB')).toBe('写作/草稿/草稿-1.md')
})

test('R27-136: moveDrafts 同名跳过记 errors（对齐 moveTree R65-38① 口径），其余草稿照常迁移', () => {
  const { dir, w, has } = r27Fixture()
  // 断点形态：目标位已有同名（上次迁移中断/rename 失败），源残留 工作区/
  w('工作区/草稿-1.md', '旧目录孤儿')
  w('写作/草稿/草稿-1.md', '已在目标位')
  w('工作区/草稿-2.md', '可迁草稿')

  const r = migrateLayoutV2(dir)
  // 同名跳过留痕（修复前纯静默 continue，孤儿无告警）
  expect(r.errors.some((e) => e.includes('同名跳过') && e.includes('工作区/草稿-1.md') && e.includes('写作/草稿/草稿-1.md'))).toBe(true)
  // 双份内容均未被覆盖
  expect(readFileSync(join(dir, '工作区', '草稿-1.md'), 'utf-8')).toBe('旧目录孤儿')
  expect(readFileSync(join(dir, '写作', '草稿', '草稿-1.md'), 'utf-8')).toBe('已在目标位')
  // 同目录其余草稿照常迁移（不中断）
  expect(has('写作/草稿/草稿-2.md')).toBe(true)
})

// ── R30-22（三十轮）：清单改写只对实际搬移成功的文件——冲突跳过条目保持旧路径 ──

test('R30-22: moveTree 同名冲突跳过的文件清单条目保持旧路径，成功搬移的照改，errors 照记', () => {
  // 断点形态：定稿/正文/ 与 写作/正文/ 同名冲突 + 一件可迁文件
  write('定稿/正文/0001-冲突.md', '旧目录内容（孤儿）')
  write('写作/正文/0001-冲突.md', '新目录已有内容（冲突胜者）')
  write('定稿/正文/0002-可迁.md', '可迁移文件')
  write(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docConflict","nodeType":"document","path":"定稿/正文/0001-冲突.md","parentId":null}',
      '{"id":"docMoved","nodeType":"document","path":"定稿/正文/0002-可迁.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV2(tmp)
  // 搬移侧（R65-38① 既有口径不回归）：冲突留痕、旧文件未动、可迁文件照搬
  expect(r.errors.some((e) => e.includes('同名跳过') && e.includes('定稿/正文/0001-冲突.md'))).toBe(true)
  expect(has('定稿/正文/0001-冲突.md')).toBe(true)
  expect(has('写作/正文/0002-可迁.md')).toBe(true)
  // 清单侧（本修复核心）：冲突条目仍指旧路径（docId 不挂到冲突胜者内容上、
  // 旧文件不成无登记孤儿）；成功搬移的条目照常改写
  const paths = manifestPaths(tmp)
  expect(paths.get('docConflict')).toBe('定稿/正文/0001-冲突.md')
  expect(paths.get('docMoved')).toBe('写作/正文/0002-可迁.md')
})

test('R30-22: moveDrafts 同名冲突跳过的草稿条目保持旧路径，成功搬移的照改', () => {
  const { dir, w } = r27Fixture()
  w('工作区/草稿-1.md', '旧目录孤儿')
  w('写作/草稿/草稿-1.md', '已在目标位')
  w('工作区/草稿-2.md', '可迁草稿')
  w(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docSkip","nodeType":"document","path":"工作区/草稿-1.md","parentId":null}',
      '{"id":"docMove","nodeType":"document","path":"工作区/草稿-2.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV2(dir)
  expect(r.errors.some((e) => e.includes('同名跳过') && e.includes('工作区/草稿-1.md'))).toBe(true)
  const paths = manifestPaths(dir)
  // 跳过条目保持旧路径（登记与盘上旧文件一致）；成功搬移照改
  expect(paths.get('docSkip')).toBe('工作区/草稿-1.md')
  expect(paths.get('docMove')).toBe('写作/草稿/草稿-2.md')
})

test('R30-22: 伏笔前缀条目豁免 moved 过滤——物理搬移在 migrateLegacyForeshadows（R71-14 链序），清单维持无条件改写', () => {
  // 伏笔不经本文件 moveTree（moved 恒不含它）；若被过滤，R71-14 场景
  // （伏笔按改写后路径接定稿基线）即断链——锁定豁免不被误伤
  write('大纲/伏笔/001-钩子.md', '伏笔内容')
  write(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docLead","nodeType":"document","path":"大纲/伏笔/001-钩子.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  // 无条件改写（物理文件由 document/ 层迁移按 R71-14 链序处理）
  const paths = manifestPaths(tmp)
  expect(paths.get('docLead')).toBe('设定/伏笔/001-钩子.md')
})

test('R30-22: 清单先行盘上无文件 → 预改写落 v2（scaffold 新书首次保存契约，documents-api 依赖）', () => {
  // 只登记清单、不建物理目录/文件——server 启动迁移须把 v1 条目预改写到 v2，
  // 首次保存才按新路径落盘；「无残留文件」不得被误判为「冲突跳过保持旧值」
  write(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docNew","nodeType":"document","path":"定稿/正文/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  const paths = manifestPaths(tmp)
  expect(paths.get('docNew')).toBe('写作/正文/0001-开篇.md')
})
