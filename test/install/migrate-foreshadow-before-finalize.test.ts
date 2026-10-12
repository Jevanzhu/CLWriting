/**
 * R71-14（总七十一轮）回归：启动迁移链中 伏笔搬迁（migrateLegacyForeshadows）必须
 * 先于 定稿基线迁移（migrateFinalizedRevisionsAsync）执行。
 *
 * 缺陷形态：migrateLayoutV2 的清单路径改写已把 大纲/伏笔/* 指到 设定/伏笔/*，但物理
 * 文件靠 migrateLegacyForeshadows 搬——若 finalize 先跑，伏笔 entry 对 设定/伏笔/*
 * existsSync 落空被跳过，且幂等闸（任一 document entry 已有基线→整书跳过）此后不再
 * 补，git 时代书的伏笔永久缺定稿基线。
 *
 * 本文件按 server 启动链的实际顺序（V2→V3 略→伏笔→定稿基线）驱动两个纯迁移函数，
 * 断言伏笔 entry 拿到基线；同时以旧顺序（finalize 先跑）锚定缺陷形态（基线永久缺）。
 *
 * 启动链现由 install/layout-migrations.ts 的编排表承载（数组序 = 执行序，依赖声明
 * 从逐行注释收拢为表序）：本文件另锚表序契约与「按表驱动整链」的终局——表序若把伏笔
 * 搬迁排到定稿基线之后，链驱动用例即红（前两例只锚函数本身，表序改动测不到）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { migrateLayoutV2 } from '../../src/install/migrate-layout-v2.js'
import { migrateFinalizedRevisionsAsync } from '../../src/install/migrate-finalized-revision.js'
import { migrateLegacyForeshadows } from '../../src/document/foreshadow.js'
import { LAYOUT_MIGRATIONS, runLayoutMigrationsAsync } from '../../src/install/layout-migrations.js'
import { readManifest } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clw-r71-foreshadow-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 造 git 时代旧书：已 commit 全 clean，含 大纲/伏笔 document entry + 一章正文。 */
function scaffoldGitEraBook(): void {
  // 旧账本伏笔（文件名 <编号>-<标题>.md，与迁移目标命名一致）
  mkdirSync(join(tmp, '大纲', '伏笔'), { recursive: true })
  writeFileSync(
    join(tmp, '大纲', '伏笔', '伏笔-012-暗号.md'),
    [
      '---',
      '编号: 伏笔-012',
      '标题: 暗号',
      '类型: 悬念',
      '状态: 进行中',
      '开启章: 3',
      '---',
      '',
      '## 履历',
      '',
      '- 第3章 埋下：初次提到暗号',
      '',
    ].join('\n'),
    'utf-8',
  )
  // 一章正文（v2 路径，干净 committed）
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(tmp, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。',
    'utf-8',
  )
  // manifest：两条 document entry（伏笔 + 正文）
  mkdirSync(join(tmp, '项目'), { recursive: true })
  const header = JSON.stringify({ version: 1, type: 'header' })
  const entries = [
    JSON.stringify({ id: 'doc-fore', nodeType: 'document', path: '大纲/伏笔/伏笔-012-暗号.md', parentId: null }),
    JSON.stringify({ id: 'doc-ch1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }),
  ]
  writeFileSync(join(tmp, '项目', '文档清单.jsonl'), [header, ...entries].join('\n') + '\n', 'utf-8')
  // git 时代书库：全量 commit（clean）
  execSync('git init', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: tmp, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: tmp, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: tmp, stdio: 'pipe' })
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
}

function manifestOf() {
  return readManifest(join(tmp, '项目', '文档清单.jsonl'))
}

test('R71-14: 新顺序（伏笔先搬→定稿基线后跑）——伏笔 entry 拿到定稿基线', async () => {
  scaffoldGitEraBook()
  // 启动迁移链（新顺序）：V2 清单改写 → 伏笔物理搬迁 → 定稿基线
  expect(migrateLayoutV2(tmp).errors).toHaveLength(0)
  // 清单路径已改写而物理文件未搬（缺陷根源的中间态锚定）
  const mAfterV2 = manifestOf()
  expect([...mAfterV2.entries.values()].some((e) => e.path === '设定/伏笔/伏笔-012-暗号.md')).toBe(true)
  expect(existsSync(join(tmp, '设定', '伏笔', '伏笔-012-暗号.md'))).toBe(false)

  const fr = migrateLegacyForeshadows(tmp)
  expect(fr.migrated).toBe(1)
  expect(existsSync(join(tmp, '设定', '伏笔', '伏笔-012-暗号.md'))).toBe(true)
  // git 时代书的作者把迁移结果 commit（finalize 语义只对 clean 文件建基线；
  // untracked 新位按 draft 不设——不 commit 则伏笔/正文同理都不建，测不到顺序差）
  execSync('git add -A && git commit -m migrate', { cwd: tmp, stdio: 'pipe' })

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(2) // 正文 + 伏笔（干净 committed）都建基线
  const m = manifestOf()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get('设定/伏笔/伏笔-012-暗号.md')?.finalizedRevision).toBe(
    computeRevision(join(tmp, '设定', '伏笔', '伏笔-012-暗号.md')),
  )
})

test('R71-14: 旧顺序缺陷锚定（定稿基线先跑）——伏笔 entry 基线永久缺失', async () => {
  scaffoldGitEraBook()
  // 旧顺序：V2 → finalize 先 → 伏笔后
  expect(migrateLayoutV2(tmp).errors).toHaveLength(0)
  // 同一 clean 语义前提：正文在旧位 committed clean（finalize 建基线），伏笔位尚空
  execSync('git add -A && git commit -m v2', { cwd: tmp, stdio: 'pipe' })
  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(1) // 只有正文建基线；伏笔（设定/伏笔/* 物理不存在）被跳过
  migrateLegacyForeshadows(tmp)
  execSync('git add -A && git commit -m fore', { cwd: tmp, stdio: 'pipe' })
  // 物理文件已就位（且 committed clean）后重跑 finalize：幂等闸（正文已有基线→
  // 整书跳过）不再补——新顺序下同样的终局盘面伏笔本应有基线
  expect(await migrateFinalizedRevisionsAsync(tmp)).toBe(0)
  const m = manifestOf()
  const fore = [...m.entries.values()].find((e) => e.path === '设定/伏笔/伏笔-012-暗号.md')
  expect(fore?.finalizedRevision).toBeUndefined() // 旧顺序下永久缺基线（缺陷形态）
})

test('编排表序声明既有依赖：版式 v2 → 伏笔搬迁 → 定稿基线（表序即依赖声明）', async () => {
  const ids = LAYOUT_MIGRATIONS.map((s) => s.id)
  // id 唯一是表序断言与启动通告定位的前提
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toContain('layout-v2')
  expect(ids).toContain('legacy-foreshadows')
  expect(ids).toContain('finalized-revisions')
  // 依赖（原散落在 server 启动段的隐式契约，现收拢为表序）：
  // v2 的清单路径改写先于伏笔搬迁；伏笔物理文件就位先于定稿基线判定
  expect(ids.indexOf('layout-v2')).toBeLessThan(ids.indexOf('legacy-foreshadows'))
  expect(ids.indexOf('legacy-foreshadows')).toBeLessThan(ids.indexOf('finalized-revisions'))
})

test('按编排表驱动整链——伏笔 entry 拿到定稿基线，且整表重跑幂等零错误', async () => {
  scaffoldGitEraBook()
  for (const step of LAYOUT_MIGRATIONS) {
    expect((await step.run(tmp)).errors).toHaveLength(0)
    if (step.id === 'legacy-foreshadows') {
      // 作者把迁移中间态 commit：定稿基线只对 clean 文件建（不 commit 则两序都不建，
      // 测不到顺序差）——此刻伏笔物理文件已在新位且 clean，才轮到定稿基线判定。
      // 表序若把伏笔搬迁排到定稿基线之后，本用例终局断言即红。
      execSync('git add -A && git commit -m migrate', { cwd: tmp, stdio: 'pipe' })
    }
  }
  const forePath = join(tmp, '设定', '伏笔', '伏笔-012-暗号.md')
  const foreOf = () =>
    [...manifestOf().entries.values()].find((e) => e.path === '设定/伏笔/伏笔-012-暗号.md')
  expect(foreOf()?.finalizedRevision).toBe(computeRevision(forePath))

  // 生产入口（整表一次跑）在终局盘面上重跑：各步幂等——全步零错误且基线不丢
  const outcomes = await runLayoutMigrationsAsync(tmp)
  expect(outcomes).toHaveLength(LAYOUT_MIGRATIONS.length)
  expect(outcomes.filter((o) => o.errors.length > 0)).toEqual([])
  expect(foreOf()?.finalizedRevision).toBe(computeRevision(forePath))
})
