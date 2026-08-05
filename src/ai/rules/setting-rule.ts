/**
 * 设定一致规则（A3）——正文专名须与书库设定一致。
 *
 * 数据源：设定/ 下三处——
 * - 角色卡：设定/角色/*.md（front matter「姓名」字段）
 * - 物品卡：设定/物品/*.md（front matter「名称」字段）
 * - 名册：  设定/名册.md（自由文本，全文 includes 粗匹配）
 *
 * 设定/ 目录不存在（短篇集/新书）→ toPrompt 返回 null + check 返回空。
 *
 * 规则层只做确定性字面匹配（不调 AI）——引号内 2-4 字中文片段不在已知名称
 * 集合或名册全文中即报黄。语义判断（别名/化名/代称）留给审稿 AI。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from '../../format/frontmatter.js'
import type { WritingRule, RuleViolation } from './types.js'

/** 设定子目录/文件相对路径 */
const SETTING_DIR = '设定'
const ROLE_DIR = join(SETTING_DIR, '角色')
const ITEM_DIR = join(SETTING_DIR, '物品')
const ROSTER_FILE = join(SETTING_DIR, '名册.md')

/** 引号内 2-4 字中文片段正则（参考 check/count.ts checkNewNames） */
const QUOTED_NAME_RE = /[「『"]([^」』"]{2,4})[」』"]/g

/** 书库设定数据：离散名称 + 名册全文 */
interface SettingData {
  /** 角色卡姓名 + 物品卡名称（精确匹配用） */
  names: Set<string>
  /** 名册.md 全文（null = 无名册文件） */
  rosterText: string | null
}

/**
 * 加载书库设定数据。
 * 设定/ 目录不存在（短篇集/新书）→ 返回空数据。
 */
function loadSettingData(bookRoot: string): SettingData {
  const data: SettingData = { names: new Set(), rosterText: null }
  const settingRoot = join(bookRoot, SETTING_DIR)
  if (!existsSync(settingRoot)) return data

  // 角色卡：读 front matter「姓名」字段
  const roleDir = join(bookRoot, ROLE_DIR)
  if (existsSync(roleDir)) {
    for (const f of readdirSync(roleDir)) {
      if (!f.endsWith('.md')) continue
      const parsed = readFile(join(roleDir, f))
      if (!parsed.ok) continue
      const name = parseFlat(parsed.fmRaw).get('姓名')
      if (typeof name === 'string' && name.trim()) data.names.add(name.trim())
    }
  }

  // 物品卡：读 front matter「名称」字段
  const itemDir = join(bookRoot, ITEM_DIR)
  if (existsSync(itemDir)) {
    for (const f of readdirSync(itemDir)) {
      if (!f.endsWith('.md')) continue
      const parsed = readFile(join(itemDir, f))
      if (!parsed.ok) continue
      const name = parseFlat(parsed.fmRaw).get('名称')
      if (typeof name === 'string' && name.trim()) data.names.add(name.trim())
    }
  }

  // 名册：全文缓存（check 时 includes 粗匹配）
  const rosterPath = join(bookRoot, ROSTER_FILE)
  if (existsSync(rosterPath)) {
    data.rosterText = readFileSync(rosterPath, 'utf-8')
  }

  return data
}

/** 判定设定数据是否为空（无离散名称且无名册） */
function isEmpty(data: SettingData): boolean {
  return data.names.size === 0 && data.rosterText === null
}

/** 候选专名是否已登记（在离散名称集合或名册全文中） */
function isKnown(name: string, data: SettingData): boolean {
  if (data.names.has(name)) return true
  if (data.rosterText !== null && data.rosterText.includes(name)) return true
  return false
}

/** 设定一致规则（黄级：提示不卡流程） */
export const settingConsistencyRule: WritingRule = {
  id: 'setting-consistency',
  level: 'yellow',
  tasks: ['self-heal', 'spawn-write', 'rewrite'],

  toPrompt(ctx): string | null {
    const data = loadSettingData(ctx.bookRoot)
    if (isEmpty(data)) return null
    return '设定一致：文中人物/物品名称须与书库设定一致——已有角色卡和物品卡登记的名称不可篡改，新出场专名须有对应设定卡，不可凭空捏造'
  },

  check(body, ctx): RuleViolation[] {
    const data = loadSettingData(ctx.bookRoot)
    if (isEmpty(data)) return []

    const violations: RuleViolation[] = []
    const seen = new Set<string>()
    for (const m of body.matchAll(QUOTED_NAME_RE)) {
      const name = m[1]!.trim()
      if (name.length < 2 || name.length > 4) continue
      if (seen.has(name)) continue // 同名去重
      if (isKnown(name, data)) continue // 已登记，放行
      seen.add(name)
      violations.push({
        ruleId: 'setting-consistency',
        level: 'yellow',
        message: `疑似未登记专名「${name}」——若为新角色/物品，请先在 设定/ 中补建对应设定卡`,
      })
    }
    return violations
  },
}
