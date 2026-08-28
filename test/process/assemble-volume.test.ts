/**
 * GG-P2-6 回归：assembleStatus 第三参 volume_size 接线（缺省从生效配置收口）。
 *
 * 断链形态：chapter_status 工具按「只传 config 不传第三参」调用，第三参缺省
 * 硬编码 50——书级/global 配了别的卷大小时卷号仍按 50 算。修复后缺省回落
 * config.book.volume_size（调用方喂 applyGlobalDefaults 之后的生效配置时，
 * 此处即 书级 → global.json → 硬编码 三层链的收口点）。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter } from '../../src/cache/sync.js'
import { assembleStatus } from '../../src/process/assemble.js'
import { applyGlobalDefaults } from '../../src/format/global-defaults.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造写到第 maxN 章的缓存 db */
function makeDb(maxN: number): { db: DatabaseSync; dir: string } {
  const dir = mkdtempTracked(join(tmpdir(), 'clwriting-gg26-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  for (let n = 1; n <= maxN; n++) {
    syncChapter(db, {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '强',
      情绪定位: '铺垫', _wordCount: 2000, _path: `p${n}`,
    })
  }
  return { db, dir }
}

/** 造只含 defaultVolumeSize 的 global.json（书库级第二层；卷大小下界 5） */
function mkGlobal(volumeSize: number): string {
  const ud = mkdtempTracked(join(tmpdir(), 'clwriting-gg26-ud-'))
  writeFileSync(join(ud, 'global.json'), JSON.stringify({ defaultVolumeSize: volumeSize }), 'utf8')
  return ud
}

function cleanup(db: DatabaseSync, dir: string, ud?: string): void {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  if (ud) rmSync(ud, { recursive: true, force: true })
}

test('GG-P2-6：第三参缺省 + global 层打通——60 章 / global 卷 25 → 第 3 卷（断链旧行为=第 2 卷）', () => {
  const { db, dir } = makeDb(60)
  const ud = mkGlobal(25)
  // chapter_status 工具的真实调用形态：applyGlobalDefaults 后的生效 config，不传第三参
  const eff = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), ud)
  expect(eff.book.volume_size).toBe(25) // 前提：global 层确实生效
  const s = assembleStatus(db, eff)
  expect(s.currentChapter).toBe(60)
  expect(s.currentVolume).toBe(3) // ceil(60/25)=3；断链时按 50 算=2
  cleanup(db, dir, ud)
})

test('GG-P2-6：书级层打通——book.yaml 配 volume_size 30（无 global.json）→ 第 2 卷', () => {
  const { db, dir } = makeDb(60)
  const cfg: BookConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    book: { title: '', volume_size: 30 },
  }
  const s = assembleStatus(db, cfg)
  expect(s.currentVolume).toBe(2) // ceil(60/30)
  cleanup(db, dir)
})

test('GG-P2-6：显式第三参优先——调用方明确传 40 时不看 config（既有调用方行为不变）', () => {
  const { db, dir } = makeDb(60)
  const ud = mkGlobal(25)
  const eff = applyGlobalDefaults(structuredClone(DEFAULT_CONFIG), ud)
  const s = assembleStatus(db, eff, 40)
  expect(s.currentVolume).toBe(2) // ceil(60/40)
  cleanup(db, dir, ud)
})

test('GG-P2-6：全未设 → 硬编码 50 兜底（60 章 → 第 2 卷，旧行为不变）', () => {
  const { db, dir } = makeDb(60)
  const s = assembleStatus(db, structuredClone(DEFAULT_CONFIG))
  expect(s.currentVolume).toBe(2) // ceil(60/50)
  cleanup(db, dir)
})
