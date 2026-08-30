/**
 * R66-21（十四轮）：v3 迁移回收站「登记先于移文件」回归。
 *
 * trashDraft 此前先 renameSync 进 .trash、后 appendTrashEntry——两步间崩溃留下
 * .trash 孤儿无登记（回收站 UI 失明、无法还原）。修复后对齐 doTrash 的 GG-P2-6
 * 纪律：登记成功后才移文件；反向残留（登记在而文件未动）为无害孤儿条目。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// renameSync 定点失败注入：只对「移入 .trash 的目标路径」抛错（精确匹配目标文件，
// 不误伤 atomicWriteFile 的临时文件 rename 与 trash 清单自身写入）
const FAIL = vi.hoisted(() => ({ enabled: false, dest: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: ((from, to) => {
      if (FAIL.enabled && to === FAIL.dest) {
        throw Object.assign(new Error('模拟崩溃：登记后 rename 前进程被杀（EIO 形态）'), { code: 'EIO' })
      }
      return (actual.renameSync as typeof renameSync)(from, to)
    }) as typeof renameSync,
  }
})

import { migrateLayoutV3 } from '../../src/install/migrate-layout-v3.js'
import { listTrash } from '../../src/document/trash.js'
// C-4（二十九轮）：回收站条目 originalPath 改记「迁移落点」（resolveDraftPath 结果，
// 不再是已退役的 写作/草稿/ 旧路径）——夹具正文区已有同章号章 0001-占位.md，即落点
const LANDING = '写作/正文/0001-占位.md'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r66-21-'))
  // 正文区已有同章号章（章号 1）→ 草稿-1 目标冲突 → 走 trashDraft 回收站路径
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-占位.md'),
    '---\n章号: 1\n标题: 占位\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n占位章正文。\n',
    'utf-8',
  )
  // 旧草稿目录 + 一份草稿
  mkdirSync(join(root, '写作', '草稿'), { recursive: true })
  writeFileSync(join(root, '写作', '草稿', '草稿-1.md'), '---\n标题: 冲突旧稿\n---\n旧稿正文。\n', 'utf-8')
  FAIL.enabled = false
  FAIL.dest = ''
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('R66-21: v3 迁移回收站登记先于移文件', () => {
  it('移动失败（模拟两步间崩溃）→ 登记已在回收站清单（顺序证据），源稿留草稿区待重试', () => {
    FAIL.enabled = true
    FAIL.dest = join(root, '工作区', '.trash', '草稿-1.md')
    const r = migrateLayoutV3(root)
    // 迁移记 error 但不丢稿
    expect(r.errors.some((e) => e.includes('草稿-1.md'))).toBe(true)
    expect(existsSync(join(root, '写作', '草稿', '草稿-1.md'))).toBe(true)
    // 关键断言：登记先于移动——rename 未执行而回收站清单已有条目（反向孤儿无害）
    expect(listTrash(root).some((e) => e.originalPath === LANDING)).toBe(true)
  })

  it('正常冲突迁移：登记与移动都完成（回收站可见 + 草稿区清空 + 下次幂等）', () => {
    const r = migrateLayoutV3(root)
    expect(r.errors).toEqual([])
    expect(r.migrated).toBe(1)
    expect(existsSync(join(root, '写作', '草稿', '草稿-1.md'))).toBe(false)
    expect(existsSync(join(root, '工作区', '.trash', '草稿-1.md'))).toBe(true)
    expect(listTrash(root).some((e) => e.originalPath === LANDING)).toBe(true)

    // 幂等：草稿区已空 → 二跑 no-op，不产生重复登记
    const again = migrateLayoutV3(root)
    expect(again.migrated).toBe(0)
    expect(listTrash(root).filter((e) => e.originalPath === LANDING).length).toBe(1)
  })
})
