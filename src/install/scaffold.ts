/**
 * 书仓库 scaffold —— 从 init.ts 提取的共享模块（M7 #36 复用边界）。
 *
 * init（#30）和 import（#36）都通过这里建书仓库，保证 6.2 目录树、
 * 文风铁律模板、书级 AGENTS.md、git init + 身份隔离、init commit 完全一致。
 *
 * 行为契约：本模块只负责「建书仓库骨架」，不含工作目录 scaffold、
 * 不装角色壳、不登记 books.jsonl（那些是 doInit 编排层的事）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../format/yaml.js'
import { addEntry } from '../format/style-entry.js'
import { recommendShortChecks } from './data.js'
import { addCommit, git } from '../git/exec.js'
import type { BookConfig, LeadType } from '../format/types.js'

/** 书仓库 scaffold 入参（init 和 import 共用）。 */
export interface BookScaffoldOpts {
  name: string
  genre: string
  leadsEnabled: LeadType[]
  kind: 'long' | 'short'
  /** AI 宿主（决策 12/22，缺省 cc） */
  host?: 'cc' | 'codex'
  /** 全书目标字数（决策 14，落 book.yaml target_words，完成度直除） */
  targetWords?: number
  /** 简介（GUI 新增 5.1，落 简介.md，长篇简介/短篇集定位） */
  brief?: string
}

/**
 * 建书仓库骨架（独立 git + book.yaml + 6.2 目录 + 文风冷启动 + 初始 commit）。
 *
 * 产物：book.yaml、.gitignore、AGENTS.md、定稿/大纲/文风/工作区 全套目录、
 * `git commit -m "init"` 作为 HEAD（让 enter/状态机有 HEAD 可判）。
 */
export function scaffoldBookRepo(bookRoot: string, opts: BookScaffoldOpts): void {
  mkdirSync(bookRoot, { recursive: true })

  // git init + 身份（隔离，不污染全局 config）
  mustGit(bookRoot, ['init'])
  mustGit(bookRoot, ['config', 'user.email', 'author@clwriting.local'])
  mustGit(bookRoot, ['config', 'user.name', 'author'])
  mustGit(bookRoot, ['config', 'commit.gpgsign', 'false'])
  installBookPushGuard(bookRoot)

  // book.yaml（#9 schema，题材驱动 leads.enabled；短篇集走精简字段，M8 #25）
  const config: BookConfig = opts.kind === 'short'
    ? {
        ...DEFAULT_CONFIG,
        // 短篇集精简：无 leads.enabled（账本降级单篇清单 #27）、无 growth（无成长线）
        kind: 'short',
        host: opts.host ?? 'cc',
        workflow: 'free', // W0 §2 决策 1：新书默认自由模式
        book: { ...DEFAULT_CONFIG.book, title: opts.name, genre: opts.genre, ...(opts.targetWords ? { target_words: opts.targetWords } : {}) },
        short: recommendShortChecks(opts.genre),
      }
    : {
        ...DEFAULT_CONFIG,
        host: opts.host ?? 'cc',
        workflow: 'free', // W0 §2 决策 1：新书默认自由模式
        book: { ...DEFAULT_CONFIG.book, title: opts.name, genre: opts.genre, ...(opts.targetWords ? { target_words: opts.targetWords } : {}) },
        leads: { ...DEFAULT_CONFIG.leads, enabled: opts.leadsEnabled },
      }
  writeBookConfig(join(bookRoot, 'book.yaml'), config)

  // 母本 6.2 目录：定稿 / 大纲 / 文风 / 工作区
  scaffoldDirectories(bookRoot, opts)

  // .gitignore（工作区/临时区/缓存/RAG 向量库不进 git）
  writeFileSync(
    join(bookRoot, '.gitignore'),
    ['工作区/', '写作/草稿/', '.cache/', '.rag.db', ''].join('\n'),
    'utf-8',
  )

  // 简介（GUI 新增 5.1，落 简介.md；CLI init 无，仅 GUI 建书时写）
  if (opts.brief && opts.brief.trim()) {
    writeFileSync(join(bookRoot, '简介.md'), opts.brief.trim(), 'utf-8')
  }

  // 初始 commit（让 enter/状态机有 HEAD 可判，避开态 3 误判）
  const commit = addCommit(bookRoot, 'init')
  if (!commit.ok) throw new Error(commit.humanMsg)
}

function mustGit(cwd: string, args: string[]): void {
  const r = git(args, cwd)
  if (!r.ok) throw new Error(r.humanMsg)
}

/**
 * 书仓库默认禁止推送。
 *
 * 书仓库存的是作者正文、账本、大纲等私有创作资料；CLWriting 的默认安全模型是
 * 「本地 git 用来回滚，不等于远端备份」。如果作者明确要自行远程备份，需要显式设置
 * CLWRITING_ALLOW_BOOK_PUSH=1，这能避免误把小说正文推到 GitHub。
 */
export function installBookPushGuard(bookRoot: string): void {
  const hooksDir = join(bookRoot, '.git', 'hooks')
  if (!existsSync(hooksDir)) return
  const hookPath = join(hooksDir, 'pre-push')
  writeFileSync(hookPath, renderBookPushGuardHook(), 'utf-8')
  try {
    chmodSync(hookPath, 0o755)
  } catch {
    // Windows 权限位不稳定；Git for Windows 仍会按 hook 文件内容执行。
  }
}

export function renderBookPushGuardHook(): string {
  return [
    '#!/bin/sh',
    'if [ "$CLWRITING_ALLOW_BOOK_PUSH" = "1" ]; then',
    '  exit 0',
    'fi',
    'cat >&2 <<\'MSG\'',
    'CLWriting safety guard: this book repository contains private novel text.',
    'Push is blocked by default so drafts/final text are not sent to a remote.',
    '',
    'If you intentionally want to push this book repository, rerun with:',
    '  CLWRITING_ALLOW_BOOK_PUSH=1 git push',
    'MSG',
    'exit 1',
    '',
  ].join('\n')
}

/** 建母本 6.2 目录树（基础三类恒建 + 扩展类按 leadsEnabled 建）。短篇集走精简布局（M8 #25）。 */
export function scaffoldDirectories(bookRoot: string, opts: BookScaffoldOpts): void {
  if (opts.kind === 'short') {
    scaffoldShortDirectories(bookRoot, opts)
    return
  }
  // 写作区：正文（预置第一卷）+ 草稿
  mkdirSync(join(bookRoot, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '草稿'), { recursive: true })
  // 设定
  for (const d of ['设定/角色', '设定/物品', '设定/伏笔']) {
    mkdirSync(join(bookRoot, ...d.split('/')), { recursive: true })
  }
  writeFileSync(join(bookRoot, '设定', '世界观.md'), '# 世界观\n\n（待补）\n', 'utf-8')
  writeFileSync(join(bookRoot, '设定', '境界体系.md'), renderRealmRules(opts), 'utf-8')
  writeFileSync(join(bookRoot, '设定', '名册.md'), '# 人物名册\n\n（待补）\n', 'utf-8')

  // 大纲：卷纲/章纲/总纲（线索拆到 布线/）
  mkdirSync(join(bookRoot, '大纲', '卷纲'), { recursive: true })
  // §17 决策①：第一卷卷纲范例（与 写作/正文/第一卷/ 同名关联，树行显「✓卷纲」）
  writeFileSync(join(bookRoot, '大纲', '卷纲', '第一卷.md'), renderVolumeOutlineExample(), 'utf-8')
  // 块3.1：章纲目录 + 第一章范例（结构化 fm，引导 ChapterMeta 字段录入）
  mkdirSync(join(bookRoot, '大纲', '章纲'), { recursive: true })
  writeFileSync(
    join(bookRoot, '大纲', '章纲', '0001-开篇.md'),
    [
      '---',
      '章号: 1',
      '标题: 开篇',
      '钩子类型: 悬念钩',
      '钩子强弱: 中',
      '情绪定位: 铺垫',
      '场景: 叙事铺陈',
      '字数目标: 3000',
      '---',
      '',
      '本章情节要点（章纲正文，供作者规划或 AI 生成依据）。',
      '',
    ].join('\n'),
    'utf-8',
  )
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲\n\n（待补）\n', 'utf-8')
  // 布线：基础两类恒建 + 扩展类按启用
  mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '布线', '感情线'), { recursive: true })
  for (const lead of opts.leadsEnabled) {
    mkdirSync(join(bookRoot, '布线', lead), { recursive: true })
  }

  // 文风冷启动占位（O2）：五场景空目录 + 文风铁律骨架
  scaffoldSharedStyle(bookRoot, opts.genre)

  // 工作区（临时区，gitignore）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
}

/**
 * 短篇集目录布局（M8 #25 第 3 节）：一仓库一短篇集。
 * 建 `篇/`（正文）+ `清单/`（清单分离，与正文不混放）+ 整集共享 `文风/` + `工作区/`。
 * 不建 定稿/、大纲/、卷纲、设定、growth——短篇无长程载重。
 */
function scaffoldShortDirectories(bookRoot: string, _opts: BookScaffoldOpts): void {
  // 写作/正文/：多篇正文并存（短篇章，扁平，默认不用卷级）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })

  // 大纲/清单/：短篇清单（反转线索表/情绪曲线/伏笔回收），规划性质
  mkdirSync(join(bookRoot, '大纲', '清单'), { recursive: true })

  // 文风/：整集共享（条目库 + 文风铁律纯配置），长短同构
  scaffoldSharedStyle(bookRoot, _opts.genre)

  // 工作区/：临时区（当前在写的篇，态 4 续跑粒度=篇）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
}

/** 新书预置 AI 味禁词（旧铁律替换表同源；「AI味」标签=软禁词，只注入不机检） */
const PRESET_AI_FLAVOR: { 词: string; 替换: string }[] = [
  { 词: '深吸一口气', 替换: '具体动作（胸口起伏了一下 / 把烟摁灭）或删' },
  { 词: '缓缓 / 微微 / 轻轻 / 淡淡', 替换: '删，或给具体幅度' },
  { 词: '不禁 / 不由得', 替换: '删' },
  { 词: '嘴角勾起一抹弧度', 替换: '换具体表情或动作' },
  { 词: '空气仿佛凝固', 替换: '删，或写具体反应' },
  { 词: '抽象情绪总结句', 替换: '删，或换成具体动作 / 物件' },
]

/** 文风冷启动占位（O2，长短共用——整集/整本书共享笔感/禁词/机检）。 */
function scaffoldSharedStyle(bookRoot: string, genre: string): void {
  mkdirSync(join(bookRoot, '文风'), { recursive: true })
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), renderStyleRules(genre), 'utf-8')
  // 条目库骨架 + 预置 AI 味禁词（S5：禁词知识在条目库，铁律纯配置；
  // 条目目录存在 = 迁移幂等闸生效，新书不再走迁移）
  for (const row of PRESET_AI_FLAVOR) {
    addEntry(bookRoot, { 类型: '禁词', 场景: '通用', 来源: '导入', 标签: ['AI味'], 说明: row.替换, 正文: row.词 })
  }
}

/** 第一卷卷纲范例（§17 决策①，与 写作/正文/第一卷/ 同名关联，开箱引导卷结构）。 */
export function renderVolumeOutlineExample(): string {
  return [
    '# 第一卷 卷纲',
    '',
    '> 本卷主线规划。与 `写作/正文/第一卷/` 卷目录同名关联（树行显「✓卷纲」）。',
    '> 可手改（文件即真相）；AI 生成卷纲时会覆盖此处占位。',
    '',
    '## 本卷主线阶段',
    '',
    '（待补）',
    '',
    '## 核心冲突',
    '',
    '（待补）',
    '',
    '## 关键角色登场顺序',
    '',
    '（待补）',
    '',
    '## 章数预估',
    '',
    '30-50 章',
    '',
    '## 卷末钩子',
    '',
    '（待补：勾向第二卷）',
    '',
  ].join('\n')
}

/** 文风铁律模板（S5 瘦身为纯配置：阈值 + 删除分级；禁词知识在条目库）。 */
export function renderStyleRules(_genre: string): string {
  return [
    '# 文风铁律',
    '',
    '> 本书的文风硬约束（纯配置）。可手改（文件即真相）；机检按下方「可量化约束」实时核对；禁词在 文风/条目/禁词/ 维护。',
    '',
    '## 可量化约束',
    '',
    '机检阈值（黄项，只提示不拦，可按本书调性改；默认值待 beta 校准）：',
    '',
    '- 单句上限字数: 60',
    '- 形容词连续堆叠上限: 3',
    '- 对话标签占比: 50%',
    '- 排比连续数: 3',
    '- 结尾总结体: 避免',
    '',
    '人工参考（不进机检）：对话占比目标 30–50%、平均句长 15–25 字。',
    '',
    '## 删除上限分级（去 AI 味安全网·自愈不门禁）',
    '',
    '去 AI 味按等级控制删除比例，超限不擅删：',
    '',
    '- 轻度 ≤15% / 中度 ≤25% / 重度 ≤35%',
    '- 超过对应比例 → 报告标「超限风险」+ 分段方案，不整段删',
    '- 拿不准是否 AI 味 → 标 `[需复核]`，不删、不塞进正文',
    '- 任何情况都不删伏笔 / 钩子 / 角色特征 / 关键信息 / 必要转折',
    '',
  ].join('\n')
}

/** 境界体系模板：成长线启用时给可解析序列，避免 growth 检测静默空跑。 */
export function renderRealmRules(opts: Pick<BookScaffoldOpts, 'genre' | 'leadsEnabled'>): string {
  if (!opts.leadsEnabled.includes('成长线')) {
    return [
      '# 境界体系',
      '',
      '本书未启用成长线；如后续启用，请补充 front matter：',
      '',
      '```yaml',
      '---',
      '体系:',
      '  - 名称: 成长阶段',
      '    序列: [起步, 小成, 大成, 圆满]',
      '---',
      '```',
      '',
    ].join('\n')
  }

  const isCultivation = /玄幻|仙侠|修仙|修真/.test(opts.genre)
  const systemName = isCultivation ? '修真境界' : '成长阶段'
  const sequence = isCultivation
    ? ['炼气一层', '炼气二层', '炼气三层', '炼气四层', '炼气五层', '炼气六层', '炼气七层', '炼气八层', '炼气九层', '筑基', '金丹', '元婴', '化神']
    : ['起步', '小成', '大成', '圆满']

  return [
    '---',
    '体系:',
    `  - 名称: ${systemName}`,
    `    序列: [${sequence.join(', ')}]`,
    '---',
    '',
    '# 境界体系',
    '',
    '机检读取上方 front matter 的「体系/序列」做成长线跳跃、回退检测；正文只写说明，不参与机检。',
    '',
  ].join('\n')
}

/**
 * 向上查找最近的含 .git 的祖先目录（git 仓库定位）。
 * 命中返回该目录路径，否则 null。
 *
 * 用途：建书仓库前防护——工作目录不能位于某个 git 仓库内，
 * 否则书仓库的 git init 会被外层 git 当子模块/嵌入仓库，破坏隔离模型。
 */
export function findGitAncestor(startDir: string): string | null {
  let dir = resolve(startDir)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  for (;;) {
    const gitPath = join(dir, '.git')
    if (isGitMarker(gitPath)) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isGitMarker(gitPath: string): boolean {
  if (!existsSync(gitPath)) return false
  try {
    const stat = statSync(gitPath)
    if (stat.isDirectory()) {
      return existsSync(join(gitPath, 'HEAD'))
    }
    if (stat.isFile()) {
      return readFileSync(gitPath, 'utf-8').trimStart().startsWith('gitdir:')
    }
    return false
  } catch {
    return false
  }
}
