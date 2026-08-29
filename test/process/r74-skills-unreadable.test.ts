/**
 * R74-12（七十四轮批 D）：技巧包索引收录前试读——不可读文件不入索引。
 * 修复前 readFile 的 {ok:false}（读失败与无 front matter 混装）一律按裸 md 降级收录：
 * 不可读文件进索引而 loadSkill 对它恒 null——模型见目录取不到包。
 * - chmod 000 的 .md → 不入 listSkills 索引（win chmod 近似 no-op / root 越权不触发
 *   EACCES，跳过——同 books-delete-graveyard 的 permsReliable 口径）
 * - 可读的裸 md（无 front matter）照旧降级收录（回归：读失败与无 fm 两种形态已分离）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, loadSkill } from '../../src/process/skills.js'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const permsReliable = process.platform !== 'win32' && !isRoot

let root: string
let userDataPath: string
let bundledRoot: string
let savedResDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r74-skills-'))
  userDataPath = join(root, 'user')
  bundledRoot = join(root, 'bundled')
  mkdirSync(join(userDataPath, 'skills'), { recursive: true })
  mkdirSync(join(bundledRoot, 'skills'), { recursive: true })
  savedResDir = process.env['CLWRITING_RESOURCES_DIR']
  process.env['CLWRITING_RESOURCES_DIR'] = bundledRoot
})

afterEach(() => {
  if (savedResDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = savedResDir
  rmSync(root, { recursive: true, force: true })
})

describe('R74-12：不可读文件不入索引', () => {
  it('chmod 000 的 .md → 不入 listSkills（修复前按裸 md 降级收录，索引有名单正文取不到）', () => {
    if (!permsReliable) return // win chmod 近似 no-op；root 越权不触发 EACCES
    writeFileSync(join(userDataPath, 'skills', '坏文件.md'), '---\nname: 坏文件\n---\n正文')
    writeFileSync(join(userDataPath, 'skills', '好文件.md'), '---\nname: 好文件\nwhenToUse: 正常\n---\n好正文')
    chmodSync(join(userDataPath, 'skills', '坏文件.md'), 0o000)
    try {
      const metas = listSkills({ userDataPath })
      expect(metas.map((m) => m.name)).toEqual(['好文件']) // 坏文件不入索引
      expect(loadSkill('坏文件', { userDataPath })).toBeNull()
    } finally {
      chmodSync(join(userDataPath, 'skills', '坏文件.md'), 0o644)
    }
  })

  it('可读的裸 md（无 front matter）照旧降级收录——读失败与无 fm 两形态已分离', () => {
    writeFileSync(join(userDataPath, 'skills', '裸文档.md'), '没有 fm 的正文')
    const metas = listSkills({ userDataPath })
    expect(metas.map((m) => m.name)).toEqual(['裸文档'])
    expect(loadSkill('裸文档', { userDataPath })!.content).toBe('没有 fm 的正文')
  })
})
