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
import { BASE_LEAD_TYPES } from './data.js'
import { addCommit, git } from '../git/exec.js'
import type { BookConfig, LeadType } from '../format/types.js'

/** 书仓库 scaffold 入参（init 和 import 共用）。 */
export interface BookScaffoldOpts {
  name: string
  genre: string
  leadsEnabled: LeadType[]
  kind: 'long' | 'short'
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
        book: { ...DEFAULT_CONFIG.book, title: opts.name, genre: opts.genre },
      }
    : {
        ...DEFAULT_CONFIG,
        book: { ...DEFAULT_CONFIG.book, title: opts.name, genre: opts.genre },
        leads: { ...DEFAULT_CONFIG.leads, enabled: opts.leadsEnabled },
      }
  writeBookConfig(join(bookRoot, 'book.yaml'), config)

  // 母本 6.2 目录：定稿 / 大纲 / 文风 / 工作区
  scaffoldDirectories(bookRoot, opts)

  // .gitignore（工作区/临时区/缓存/RAG 向量库不进 git）
  writeFileSync(
    join(bookRoot, '.gitignore'),
    ['工作区/', '.cache/', '.rag.db', ''].join('\n'),
    'utf-8',
  )

  // 书仓库层 AGENTS.md（书级指路，非 #21 派生）
  writeFileSync(join(bookRoot, 'AGENTS.md'), renderBookAgentsMd(opts), 'utf-8')

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
  // 定稿区
  for (const d of ['定稿/正文', '定稿/摘要/章摘要', '定稿/摘要/卷摘要', '定稿/设定/角色', '定稿/设定/时间线']) {
    mkdirSync(join(bookRoot, ...d.split('/')), { recursive: true })
  }
  writeFileSync(join(bookRoot, '定稿', '设定', '世界观.md'), '# 世界观\n\n（待补）\n', 'utf-8')
  writeFileSync(join(bookRoot, '定稿', '设定', '境界体系.md'), renderRealmRules(opts), 'utf-8')
  writeFileSync(join(bookRoot, '定稿', '设定', '名册.md'), '# 人物名册\n\n（待补）\n', 'utf-8')

  // 大纲：基础三类恒建 + 扩展类按启用
  mkdirSync(join(bookRoot, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '感情线'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲\n\n（待补）\n', 'utf-8')
  for (const lead of opts.leadsEnabled) {
    mkdirSync(join(bookRoot, '大纲', lead), { recursive: true })
  }

  // 文风冷启动占位（O2）：五场景空目录 + 文风铁律骨架
  scaffoldSharedStyle(bookRoot, opts.genre)

  // 工作区（临时区，gitignore）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
}

/**
 * 短篇集目录布局（M8 #25 第 3 节）：一仓库一短篇集。
 * 建 `篇/`（空，不预建篇）+ 整集共享 `文风/` + `工作区/`。
 * 不建 定稿/、大纲/、卷纲、设定、growth——短篇无长程载重。
 */
function scaffoldShortDirectories(bookRoot: string, _opts: BookScaffoldOpts): void {
  // 篇/：多篇并存，替代长篇 定稿/正文/；建空（第一篇走单篇流程创建，#27）
  mkdirSync(join(bookRoot, '篇'), { recursive: true })

  // 文风/：整集共享（样章库 few-shot + 文风铁律含禁词 + 金句库），长短同构
  scaffoldSharedStyle(bookRoot, _opts.genre)

  // 工作区/：临时区（当前在写的篇，态 4 续跑粒度=篇）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
}

/** 文风冷启动占位（O2，长短共用——整集/整本书共享笔感/禁词/机检）。 */
function scaffoldSharedStyle(bookRoot: string, genre: string): void {
  for (const scene of ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']) {
    mkdirSync(join(bookRoot, '文风', '样章库', scene), { recursive: true })
  }
  mkdirSync(join(bookRoot, '文风', '金句库'), { recursive: true })
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), renderStyleRules(genre), 'utf-8')
}

/** 文风铁律模板（冷启动占位，作者后续按本书调性补）。 */
export function renderStyleRules(_genre: string): string {
  return [
    '# 文风铁律',
    '',
    '> 本书的文风硬约束 + AI 味防御。可手改（文件即真相）；机检按下方「可量化约束」实时核对。',
    '',
    '## 反和解段（AI 味防御）',
    '',
    '（待作者补：本章不可出现的套话/硬禁词清单——写进这里的词命中即报红）',
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
    '## AI 味替换参考',
    '',
    '软约束，写稿与去 AI 味时用，**非硬禁词**（高频才换，低频或有剧情功能可留；保留创作意图 > 机械替换）：',
    '',
    '| AI 味表达 | 替换方向 |',
    '|---|---|',
    '| 深吸一口气 | 具体动作（胸口起伏了一下 / 把烟摁灭）或删 |',
    '| 缓缓 / 微微 / 轻轻 / 淡淡 | 删，或给具体幅度 |',
    '| 不禁 / 不由得 | 删 |',
    '| 嘴角勾起一抹弧度 | 换具体表情或动作 |',
    '| 空气仿佛凝固 | 删，或写具体反应 |',
    '| 抽象情绪总结句 | 删，或换成具体动作 / 物件 |',
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

/** 书仓库层 AGENTS.md（书级指路；长短分轨文案）。 */
export function renderBookAgentsMd(opts: BookScaffoldOpts): string {
  if (opts.kind === 'short') {
    return [
      `# ${opts.name}`,
      '',
      `这是 CLWriting 短篇集仓库。题材：${opts.genre || '（未指定）'}。`,
      '',
      '## 配置',
      '',
      '`book.yaml` 是机器域配置（`kind: short`，经对话改，不手编）。',
      '短篇集无长程账本（账本降级为单篇 `清单.md`，#27）、无卷/体检/分层摘要。',
      '',
      '## 结构',
      '',
      '- `篇/<篇号3位>-<标题>/`：已定稿篇（`正文.md` + `清单.md`），只进不改',
      '- `文风/`：整集共享（样章库 / 文风铁律 / 金句库）',
      '- `工作区/`：当前在写的篇（定稿后移入 `篇/`）',
      '',
      '## 单篇创作流程（P1–P4，情绪为目标函数）',
      '',
      '短篇目标从「持续追读力」换成「单篇情绪爆破」：先定情绪 → 一反转撑全篇 → 五段结构。',
      '',
      '- **P1 定情绪+反转**：作者拍板目标情绪 + 一句话梗概 + 核心反转 → 写入工作区细纲；`clwriting confirm <篇号>` 绑哈希',
      '- **P2 排五段大纲**：开头钩子(约300字) / 铺垫(30-40%) / 升级(20-30%) / 反转(10-15%) / 余韵(5-10%)；反转线索表(≥3铺垫)写入 `清单.md`；确认细纲',
      '- **P3 写正文**：按段写，文风样章贴笔感；`clwriting check` 跑短篇机检（身体部位词≤5 / 「像」≤10 / 节数守恒 / 开头零环境）',
      '- **P4 三审定稿**：`clwriting review` 满审三视角（钩子审/情绪反转审/设定收尾审）→ 通过 → `clwriting finalize` 按篇原子提交（pc: 前缀）',
      '',
      '`清单.md` 记反转线索表（核心反转 + ≥3 铺垫点）+ 伏笔回收，范围限单篇、写完即归档；设定收尾审对它清单驱动核对。',
      '',
      '### 清单.md 格式（机检按此解析，**勿用表格**）',
      '',
      '```markdown',
      '## 反转线索表',
      '- 核心反转：<一句话>',
      '- 铺垫点（≥3，反转可回溯）：',
      '  - [位置1] <铺垫内容>',
      '  - [位置2] <铺垫内容>',
      '  - [位置3] <铺垫内容>',
      '',
      '## 伏笔回收',
      '- <伏笔A> → 回收于 <位置>',
      '- <伏笔B>（未回收）   ← 弃坑标记，设定收尾审会报',
      '```',
      '',
      '> 解析靠 `- 核心反转：`、`- [位置] 内容`、`- 伏笔 → 回收于 位置` 这些行首标记；写成 Markdown 表格机检读不到，会误报「缺核心反转/铺垫 0 处」。',
      '',
      '## 下一步',
      '',
      '运行 `clwriting enter` 看这个集写到哪、下一步干啥。',
      '',
    ].join('\n')
  }
  const leadsList = [...BASE_LEAD_TYPES, ...opts.leadsEnabled]
  return [
    `# ${opts.name}`,
    '',
    `这是 CLWriting 书仓库。题材：${opts.genre || '（未指定）'}。`,
    '',
    '## 配置',
    '',
    '`book.yaml` 是机器域配置（经对话改，不手编）。当前启用账本类：',
    `- ${leadsList.join('、')}`,
    '',
    '## 下一步',
    '',
    '运行 `clwriting enter` 看这本书写到哪、下一步干啥。逐章手动流程：',
    '',
    '1. 在 `工作区/细纲.md` 写细纲，并在 front matter 声明 `场景` 和 `推进`。',
    '2. 作者确认后运行 `clwriting confirm <章号>`，再运行 `clwriting prepare` 生成 `工作区/本章写作材料.md`。',
    '3. 正文草稿固定写到 `工作区/草稿-1.md`（这里的 1 是候选序号，不是章号），草稿必须带章节 front matter。',
    '4. 写 `工作区/账本推进.md` 兑现本章实际推进的账本，再运行 `clwriting check`、`clwriting review`、`clwriting finalize`。',
    '',
    '### 草稿 front matter 模板',
    '',
    '```markdown',
    '---',
    '章号: 1',
    '标题: 开脉',
    '钩子类型: 悬念钩',
    '钩子强弱: 中',
    '情绪定位: 铺垫',
    '---',
    '正文从这里开始。',
    '```',
    '',
    '### 样章格式',
    '',
    '`文风/样章库/<场景>/<场景>-001.md` 必须带 front matter，至少写 `场景:`：',
    '',
    '```markdown',
    '---',
    '场景: 对话',
    '来源: 作者原作',
    '---',
    '样章正文。',
    '```',
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
