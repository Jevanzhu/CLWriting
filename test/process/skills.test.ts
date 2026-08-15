/**
 * 写作技巧包（批次 C4 / DSH-18）单测：
 * - 三根发现 rank 覆盖序：项目 > 用户 > 捆绑（同名高 rank 覆盖，各根独有包保留）
 * - fm 缺字段降级：name ← basename；description/whenToUse ← 空串；裸 md（无 fm）同样降级收录
 * - formatSkillIndex：头行 + 一行一包、预算整行截断（通知行计价）、空列表空串
 * - loadSkill：命中取正文（高 rank 覆盖后）/ 名字未知 → null
 *
 * 捆绑根用 CLWRITING_RESOURCES_DIR 指向 tempdir（隔离真 resources/skills，
 * 覆盖序断言不依赖仓库内容）；用例间保存/还原 env。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, loadSkill, formatSkillIndex, type SkillMeta } from '../../src/process/skills.js'

let root: string
let bookRoot: string
let userDataPath: string
let bundledRoot: string
let savedResDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-skills-'))
  bookRoot = join(root, 'book')
  userDataPath = join(root, 'user')
  bundledRoot = join(root, 'bundled')
  mkdirSync(join(bookRoot, '设定', '技巧'), { recursive: true })
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

// ─── listSkills：三根覆盖序 ───────────────────────

describe('listSkills：三根 rank 覆盖序', () => {
  it('同名包取高 rank（项目 > 用户 > 捆绑），各根独有包保留', () => {
    writeFileSync(
      join(bundledRoot, 'skills', '场景描写.md'),
      '---\nname: 场景描写\nwhenToUse: 捆绑版提示\n---\n捆绑正文',
    )
    writeFileSync(
      join(userDataPath, 'skills', '场景描写.md'),
      '---\nname: 场景描写\nwhenToUse: 用户版提示\n---\n用户正文',
    )
    writeFileSync(
      join(bookRoot, '设定', '技巧', '场景描写.md'),
      '---\nname: 场景描写\nwhenToUse: 项目版提示\n---\n项目正文',
    )
    // 低 rank 独有包：用户独有 + 捆绑独有
    writeFileSync(
      join(userDataPath, 'skills', '对话节奏.md'),
      '---\nname: 对话节奏\nwhenToUse: 用户独有\n---\n对话',
    )
    writeFileSync(
      join(bundledRoot, 'skills', '黄金三章.md'),
      '---\nname: 黄金三章\nwhenToUse: 捆绑独有\n---\n黄金',
    )

    const metas = listSkills({ bookRoot, userDataPath })
    expect(metas.map((m) => m.name)).toEqual(['场景描写', '对话节奏', '黄金三章']) // name 排序稳定
    const byName = new Map(metas.map((m) => [m.name, m]))
    // 同名三根并存 → 项目版胜出（含 path 指向项目根）
    expect(byName.get('场景描写')).toMatchObject({ source: 'project', whenToUse: '项目版提示' })
    expect(byName.get('场景描写')!.path).toBe(join(bookRoot, '设定', '技巧', '场景描写.md'))
    // 各根独有包按来源标注
    expect(byName.get('对话节奏')).toMatchObject({ source: 'user' })
    expect(byName.get('黄金三章')).toMatchObject({ source: 'bundled' })
  })

  it('无用户根时同名包：项目 > 捆绑', () => {
    writeFileSync(
      join(bundledRoot, 'skills', '场景描写.md'),
      '---\nname: 场景描写\nwhenToUse: 捆绑版\n---\n捆绑',
    )
    writeFileSync(
      join(bookRoot, '设定', '技巧', '场景描写.md'),
      '---\nname: 场景描写\nwhenToUse: 项目版\n---\n项目',
    )
    const metas = listSkills({ bookRoot }) // 不传 userDataPath
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({ source: 'project', whenToUse: '项目版' })
  })

  it('根缺省/目录不存在 → 跳过该根不报错', () => {
    writeFileSync(join(bundledRoot, 'skills', '黄金三章.md'), '---\nname: 黄金三章\n---\n正文')
    expect(listSkills({}).map((m) => m.name)).toEqual(['黄金三章'])
    // bookRoot 指向不存在的目录同样只回捆绑根
    expect(listSkills({ bookRoot: join(root, 'nope') })).toHaveLength(1)
  })
})

// ─── listSkills：fm 缺字段降级 ────────────────────

describe('listSkills：fm 缺字段降级', () => {
  it('缺 name → 文件 basename；缺 description/whenToUse → 空串', () => {
    writeFileSync(join(userDataPath, 'skills', '打斗设计.md'), '---\n其他: 1\n---\n正文内容')
    const metas = listSkills({ userDataPath })
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({
      name: '打斗设计',
      description: '',
      whenToUse: '',
      source: 'user',
    })
  })

  it('无 front matter 的裸 md 降级收录（name=basename，正文可按需取）；非 .md 不扫描', () => {
    writeFileSync(join(userDataPath, 'skills', '裸文档.md'), '没有 fm 的正文')
    writeFileSync(join(userDataPath, 'skills', 'notes.txt'), '非 md')
    const metas = listSkills({ userDataPath })
    expect(metas.map((m) => m.name)).toEqual(['裸文档'])
    expect(metas[0]).toMatchObject({ source: 'user', description: '', whenToUse: '' })
    expect(loadSkill('裸文档', { userDataPath })!.content).toBe('没有 fm 的正文')
  })
})

// ─── formatSkillIndex ─────────────────────────────

describe('formatSkillIndex', () => {
  const mk = (name: string, whenToUse: string): SkillMeta => ({
    name,
    description: 'desc 不进索引',
    whenToUse,
    source: 'bundled',
    path: `/x/${name}.md`,
  })

  it('空列表 → 空串（不注入段）', () => {
    expect(formatSkillIndex([])).toBe('')
  })

  it('默认形态：头行（read_skill 指引）+ 一行一包 name：whenToUse', () => {
    const out = formatSkillIndex([mk('场景描写', '写场景时用'), mk('对话节奏', '对话尬时用')])
    expect(out).toContain('## 写作技巧包（需要时调用 read_skill 工具按名取全文）')
    expect(out).toContain('- 场景描写：写场景时用')
    expect(out).toContain('- 对话节奏：对话尬时用')
    expect(out).not.toContain('技巧包索引超长已截断')
    // description 字段不进索引行
    expect(out).not.toContain('desc 不进索引')
  })

  it('预算截断：整行丢弃（不切半行）+ 末尾截断通知，总长 ≤ 预算（code points）', () => {
    const metas = Array.from({ length: 50 }, (_, i) => mk(`包${i}`, '用'.repeat(30)))
    const out = formatSkillIndex(metas, { maxChars: 200 })
    expect(out).toContain('（技巧包索引超长已截断）')
    expect(out.endsWith('（技巧包索引超长已截断）')).toBe(true)
    expect(Array.from(out).length).toBeLessThanOrEqual(200)
    // 保留下来的每行都是完整的「- name：whenToUse」（截断粒度 = 整行）
    const lines = out.split('\n')
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith('- 包')).toBe(true)
      expect(line.endsWith('用'.repeat(30))).toBe(true)
    }
  })

  it('截断通知行自身计价：装不下则回退再丢整行（预算纪律，学 spill）', () => {
    // 头行 34 + 第一行（"- 甲："3 + 10 字）含换行 14 = 48：预算 48 恰容头行+第一行，
    // 但 + 通知行（换行+12 字）= 61 装不下 → 回退丢掉第一行给通知让位
    const metas = [mk('甲', 'x'.repeat(10)), mk('乙', 'y'.repeat(10))]
    const out = formatSkillIndex(metas, { maxChars: 48 })
    expect(out).toContain('（技巧包索引超长已截断）')
    expect(out).not.toContain('- 甲：')
    expect(Array.from(out).length).toBeLessThanOrEqual(48)
  })
})

// ─── loadSkill ────────────────────────────────────

describe('loadSkill', () => {
  it('命中 → meta（高 rank）+ 剥离 fm 的正文', () => {
    writeFileSync(
      join(bundledRoot, 'skills', '场景描写.md'),
      '---\nname: 场景描写\n---\n捆绑正文',
    )
    writeFileSync(
      join(bookRoot, '设定', '技巧', '场景描写.md'),
      '---\nname: 场景描写\n---\n\n项目正文\n\n',
    )
    const r = loadSkill('场景描写', { bookRoot, userDataPath })
    expect(r).not.toBeNull()
    expect(r!.meta.source).toBe('project')
    expect(r!.content).toBe('项目正文') // 覆盖序生效 + 正文 trim
  })

  it('仅捆绑根命中 → 捆绑正文', () => {
    writeFileSync(join(bundledRoot, 'skills', '黄金三章.md'), '---\nname: 黄金三章\n---\n黄金正文')
    const r = loadSkill('黄金三章', { bookRoot, userDataPath })
    expect(r).not.toBeNull()
    expect(r!.meta.source).toBe('bundled')
    expect(r!.content).toBe('黄金正文')
  })

  it('名字未知 → null', () => {
    writeFileSync(join(userDataPath, 'skills', '对话节奏.md'), '---\nname: 对话节奏\n---\n正文')
    expect(loadSkill('不存在的包', { bookRoot, userDataPath })).toBeNull()
  })
})
