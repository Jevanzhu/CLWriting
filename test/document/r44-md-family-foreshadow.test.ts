/**
 * R44-7（四十四轮）回归：.md 扩展名大小写家族 5 落点收敛 isMdFileName。
 *
 * 大写扩展名（.MD）在此前 5 处字面 endsWith('.md') 过滤下对相应消费者静默失明：
 * - foreshadow migrateLegacyForeshadows：.MD 迁移源被滤掉 → 永久滞留旧目录（一次性
 *   迁移链无自愈通路）；
 * - foreshadow readForeshadows：.MD 伏笔对面板/足迹扫描隐形；
 * - settings-context readCharacterCards：.MD 角色卡不进 AI 上下文；
 * - skills scanRoot：.MD 技巧包不入索引（模型看不到即无从取用）。
 * （init.ts countMarkdownFiles 计数点在 test/install/r44-init-contract.test.ts 覆盖。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyForeshadows, readForeshadows } from '../../src/document/foreshadow.js'
import { readCharacterCards, clearCharacterCardCache } from '../../src/process/settings-context.js'
import { listSkills } from '../../src/process/skills.js'

let root: string
let savedResDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r44-md-family-'))
  // 隔离捆绑技巧包根（listSkills 恒扫捆绑根——空目录断言不受仓库内容影响）
  savedResDir = process.env['CLWRITING_RESOURCES_DIR']
  process.env['CLWRITING_RESOURCES_DIR'] = join(root, 'bundled-empty')
  mkdirSync(join(root, 'bundled-empty', 'skills'), { recursive: true })
})

afterEach(() => {
  if (savedResDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = savedResDir
  clearCharacterCardCache()
  rmSync(root, { recursive: true, force: true })
})

describe('R44-7：.MD 大写扩展名家族 5 落点', () => {
  it('migrateLegacyForeshadows：.MD 迁移源不再被滤掉（迁入 设定/伏笔 + 旧源删除）', () => {
    mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
    writeFileSync(
      join(root, '大纲', '伏笔', '伏笔-012-暗号.MD'),
      ['---', '编号: 伏笔-012', '标题: 暗号', '类型: 悬念', '状态: 进行中', '开启章: 3', '---', '', '## 履历', '', '- 第3章 埋下：初次提到暗号', ''].join('\n'),
      'utf-8',
    )
    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(1)
    // 新位落盘（迁移目标名恒小写 .md）、旧源删除（不再滞留旧目录）
    expect(existsSync(join(root, '设定', '伏笔', '伏笔-012-暗号.md'))).toBe(true)
    expect(existsSync(join(root, '大纲', '伏笔', '伏笔-012-暗号.MD'))).toBe(false)
  })

  it('readForeshadows：.MD 伏笔不再对面板隐形', () => {
    mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
    writeFileSync(
      join(root, '设定', '伏笔', '神秘玉佩.MD'),
      '---\n标题: 神秘玉佩\n状态: 未回收\n重要性: 高\n关联词: 玉佩\n---\n\n正文。',
      'utf-8',
    )
    const list = readForeshadows(root)
    expect(list).toHaveLength(1)
    expect(list[0]!.标题).toBe('神秘玉佩')
    expect(list[0]!.file).toBe('设定/伏笔/神秘玉佩.MD')
  })

  it('readCharacterCards：.MD 角色卡进 AI 上下文数据源', () => {
    mkdirSync(join(root, '设定', '角色'), { recursive: true })
    writeFileSync(
      join(root, '设定', '角色', '林九.MD'),
      '---\n姓名: 林九\n身份: 剑客\n---\n\n佩剑行走。',
      'utf-8',
    )
    const cards = readCharacterCards(join(root, '设定', '角色'), root)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.姓名).toBe('林九')
    expect(cards[0]!.身份).toBe('剑客')
  })

  it('skills scanRoot：.MD 技巧包入索引（大小写两形同命中）', () => {
    const dir = join(root, 'book', '设定', '技巧')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '场景描写.MD'), '---\nname: 场景描写\nwhenToUse: 大写扩展名\n---\n正文', 'utf-8')
    writeFileSync(join(dir, '对话节奏.md'), '---\nname: 对话节奏\nwhenToUse: 小写扩展名\n---\n正文', 'utf-8')
    const metas = listSkills({ bookRoot: join(root, 'book') })
    expect(metas.map((m) => m.name).sort()).toEqual(['场景描写', '对话节奏'])
    expect(metas.find((m) => m.name === '场景描写')).toMatchObject({ source: 'project', whenToUse: '大写扩展名' })
  })
})
