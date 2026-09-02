/**
 * 机检总 runner —— 依据 #10 机检规则 spec。
 *
 * 聚合 #10 第 2 节全部 11 项检查（红 4 项 + 黄 7 项）→ CheckReport。
 * 红 > 0 → 自愈打回（#10 第 6 节）。
 * 顺带产出账本变动清单 / 信息差候选 / 新专名候选（#10 第 2 节末，供阶段 6 三审）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { join, basename } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { CheckReport, CheckSectionResult } from './types.js'
import { hasRed, getRedItems } from './types.js'
import { checkLeadsForm } from './leads.js'
import { checkGrowth } from './growth.js'
import {
  checkFrontMatter,
  checkBannedWords,
  checkWordCount,
  checkRepeat,
  checkSentenceLength,
  checkNewNames,
  checkImagery,
  checkStyleMetrics,
  checkInfoLeak,
  checkPieceWordCount,
  checkBodyParts,
  checkSimile,
  checkSectionCount,
  checkOpeningNoEnv,
} from './count.js'
// P2-A1：parseIronRules 下沉到 format 层（消 format→check 循环依赖）
// RB-KN-P1-1：改用合并版 readIronRules（铁律 + 条目库禁词）——S5 迁移把禁词知识
// 搬进条目库并瘦身铁律，私有版只读铁律会让迁移书的禁词红项恒空。
import { readIronRules } from '../format/iron-rules.js'
import { deriveLeakKeywords } from './leak-derive.js'
import { checkPieceListForm } from './manifest-check.js'
import { readRealmDoc } from '../format/realms.js'
import { countWords, readChapterDir } from '../format/chapters.js'
import { readPieceList } from '../format/manifest.js'
// #10 项 7 数据源接线：高频意象内置种子表（三级供给的最底层）
import { DEFAULT_IMAGERY_WORDS } from './imagery-seed.js'
import type { ChapterMeta, BookConfig, RealmDoc, PieceList } from '../format/types.js'
// R37-9：章纲目录 readdirSync 容错降级留痕（同 run.ts 口径）
import { log } from '../log/index.js'

/** 机检输入 */
export interface CheckInput {
  /** 缓存 db（长篇必填；短篇无 db，不传） */
  db?: DatabaseSync
  bookRoot: string
  config: BookConfig
  chapter: ChapterMeta
  body: string // 正文
  fileName: string // 正文文件名
  targetWords?: number // 细纲目标字数
  bannedWords?: string[] // 禁词表
  declaredLeadIds?: string[] // 本章细纲声明推进的账本编号（两端闭合，#10 项 1）
  actualLeadIds?: string[] // 本章实际写入履历的账本编号（两端闭合对照侧）
  /** 高频意象表（#10 项 7）。三级供给的顶级：入参显式 > book.yaml checks.imagery_words
   *  > 内置种子表（imagery-seed.ts）。传了（含空数组）即整体生效不回落；readonly——
   *  直收种子表的 as const 字面量，免调用方拷贝 */
  imageryWords?: readonly string[]
  /** 信息差关键词（#10 项 11）。两级供给的顶级：入参 > book.yaml checks.leak_keywords；
   *  无内置默认（逐书的秘密无通用词表），未设 = 空表静默不启用 */
  leakKeywords?: readonly string[]
  /** 短篇严格模式：把短篇专属黄项提升为红项，用于真实生产硬闸 */
  strictShort?: boolean
  /**
   * 全书最高已定稿章号（可选）。账本「凭空声称未来章」#1 检查的参照基准：
   * 默认取当前章自身章号；多章循环检查（树红点聚合）时须传全书最高值，
   * 否则高章履历规划会被单章低章号误判为「未来章」（T9b 修复）。
   */
  maxWrittenChapter?: number
  /**
   * H-1（2026-08-21）：跳过账本三检的「全书性」条目（章号一致/引文命中/状态闭合）。
   * 树红点聚合专用——这些条目吃任意章正文，进章级缓存行会跨章陈旧；聚合侧改为
   * 本书一次计算 + 独立指纹缓存（run.ts collectTreeIssues）。单章机检端点不传
   * （报告完整）。章作用域的两端闭合条目不受影响，恒跑。
   */
  skipLeadsBookChecks?: boolean
}

/** 已启用账本类 = 基础两类 + book.yaml leads.enabled（与 rebuild.ts BASE_LEAD_TYPES 同口径；
 *  树红点聚合的全书性红项计算共用，防三处手抄漂移）。R33-41（三十三轮）：去重——
 *  book.yaml 重复登记类此前产生重复 IN 参数（无害但脏）。 */
export function enabledLeadTypes(config: BookConfig): string[] {
  return [...new Set(['悬念', '感情线', ...config.leads.enabled])]
}

/**
 * 跑全套机检（#10 第 2 节 11 项）→ CheckReport。
 *
 * 长短篇统一链路，按数据存在性条件开关：
 * - 有布线（账本/成长线）：账本形式三检 + 成长线 + 专名/信息差（db 强依赖）
 * - kind === 'short'：短篇专属项（五段节数/开头零环境）+ 清单形式检
 * - 通用项（禁词/复读/句式/文风/字数/AI 味=身体部位词+比喻）恒跑
 */
export function runAllChecks(input: CheckInput): CheckReport {
  const { db, bookRoot, config, chapter, body, fileName } = input
  const hasWiring = existsSync(join(bookRoot, '布线'))
  // R26-13（二十六轮）：短篇判定与路由侧 kind.ts 的 kind==='short' 单源对齐——此前用
  // config.short 段存在性判定，两处口径分裂：kind: short 而未写 short 段的书（合法，
  // 全部走缺省阈值）短篇专属机检整体失明；长篇误写 short 段反而跑短篇机检。空对象
  // （无 short 段）时 word_min/word_max 等传 undefined，由 checkPieceWordCount 等
  // 的缺省参数兜底（8000–20000/5 段/300 字，与既有缺省值机制一致）。
  const short = config.kind === 'short' ? (config.short ?? {}) : undefined
  const sections: CheckSectionResult[] = []

  // 未来章基准：默认取本章自身章号；调用方传了全书最高章号时用它
  // （账本「凭空声称未来章」检查是全书视角，单章低章号会误伤高章规划，T9b 修复）。
  // 注意：这只喂 checkLeadsForm 的未来章判定；collectByproducts 必须用被检章自身章号
  // （V-P1-4：两者曾共用一个变量，三审的「本章账本变动」错拿了最高已定稿章的履历）。
  // R69-17（十七轮）：零定稿书时 run.ts 侧已回退全书最高现存章号（maxWrittenChapterOf），
  // 本行 ?? chapter.章号 仅剩「调用方未传且无正文扫描结果」的兜底语义。
  const futureBaselineChapter = input.maxWrittenChapter ?? chapter.章号
  // 已启用类 = 基础两类 + book.yaml enabled（伏笔已独立为设定伏笔系统）
  const enabledTypes = enabledLeadTypes(config)

  // 有布线 → 账本类检查（db 强依赖；无布线 = 独立短篇，跳过）
  if (hasWiring) {
    if (!db) {
      throw new Error('runAllChecks: 有布线（账本/成长线）机检需要 db（缓存 index.db）')
    }
    // #10 项 1 账本形式三检（红）—— 章号一致 / 引文命中 / 状态闭合 / 两端闭合
    sections.push(
      checkLeadsForm(
        db,
        bookRoot,
        futureBaselineChapter,
        enabledTypes,
        input.declaredLeadIds,
        input.actualLeadIds,
        input.skipLeadsBookChecks === true,
        // R69-16（十七轮）：两端闭合红项的 chapter 字段用被检章自身章号——
        // futureBaselineChapter 在复检低章时是全书最高定稿章，红项错标最高章。
        chapter.章号,
      ),
    )

    // #10 项 2 成长线语义（红）—— 仅启用成长线时
    if (config.leads.enabled.includes('成长线')) {
      const realmPath = join(bookRoot, '设定', '境界体系.md')
      let realmDoc: RealmDoc | null = null
      if (existsSync(realmPath)) {
        const r = readRealmDoc(realmPath)
        if (r.ok) realmDoc = r.doc
      }
      const growthIds = (db.prepare(
        `SELECT id FROM leads WHERE type = '成长线'`,
      ).all() as { id: string }[]).map((r) => r.id)
      sections.push(checkGrowth(db, realmDoc, growthIds, config.growth.realm_span_max ?? 2))
    }
  }

  // #10 项 3 front matter 格式（红）（长短统一 ChapterMeta 口径）
  sections.push(checkFrontMatter(chapter, fileName))

  // 文风铁律（禁词红项 + 可量化黄项）
  const ironRules = readIronRules(bookRoot)

  // #10 项 4 禁词（红）—— R73-15：条目库里解析不出任何词的禁词条目产黄项提示
  //（此前静默失明：整段说明性正文作 includes 永不命中，作者无从知晓红闸失效）
  const bannedSection = checkBannedWords(body, mergeBannedWords(input.bannedWords, ironRules.bannedWords))
  for (const scene of ironRules.unparsedBannedEntries ?? []) {
    bannedSection.items.push({
      checkId: 'banned-entry-unparsed',
      level: 'yellow',
      message: `禁词条目「${scene}」解析不出有效禁词（整段说明性文本？），该条对本章禁词红闸未生效——请改写为逐行或顿号分隔的词条`,
      chapter: chapter.章号,
    })
  }
  sections.push(bannedSection)

  // 字数（黄）：有 config.short 用短篇阈值；否则用细纲目标
  if (short) {
    sections.push(checkPieceWordCount(chapter._wordCount ?? countWords(body), short.word_min, short.word_max))
  } else {
    sections.push(checkWordCount(chapter._wordCount ?? countWords(body), input.targetWords ?? 0))
  }

  // #10 项 6 复读（黄）
  sections.push(checkRepeat(body))

  // #10 项 7 高频意象（黄）—— 三级供给（数据源接线）：入参显式 > book.yaml
  // checks.imagery_words > 内置种子表（imagery-seed.ts）。?? 链上空数组非 nullish：
  // 入参/书级写了 []（显式关）就停在 [] 不回落种子表；书级非空词表整体替换不合并
  const imageryWords = input.imageryWords ?? config.checks?.imagery_words ?? DEFAULT_IMAGERY_WORDS
  sections.push(checkImagery(body, imageryWords))

  // #10 项 8 句式体检（黄）—— X-P2-23：铁律已配 maxSentenceLen 时，逐句铁律项（项 9）已覆盖
  // 超长句，汇总口径再跑一遍只是同一批句子两套黄项重复膨胀；铁律未配才兜底跑汇总
  if (!(ironRules.maxSentenceLen && ironRules.maxSentenceLen > 0)) {
    sections.push(checkSentenceLength(body))
  }

  // #10 项 9 文风可量化（黄）—— 读 文风铁律.md 的可量化硬约束阈值（#5 第 8 节）
  sections.push(checkStyleMetrics(body, ironRules))

  // 有布线 → #10 项 10 新专名候选（黄）+ #10 项 11 信息差泄密候选（黄）
  if (hasWiring) {
    const rosterPath = join(bookRoot, '设定', '名册.md')
    sections.push(checkNewNames(body, rosterPath))
    // 信息差三级供给（B4 批 6，P6-①）：入参 > book.yaml checks.leak_keywords >
    // 账本 front matter leak_keywords 派生；无内置默认（逐书的秘密无通用词表），
    // 三级都空 = 空表静默不启用（X-P2-22 语义不变）。账本扫描每章一次（布线目录
    // 小、md 数十级，stat+读 fm 成本可忽略；跨请求结果只随账本编辑变化）
    sections.push(checkInfoLeak(body, input.leakKeywords ?? config.checks?.leak_keywords ?? deriveLeakKeywords(bookRoot)))
  }

  // AI 味检查（通用项，长短篇都跑）：身体部位词堆砌 + 比喻密度。
  // 短篇有题材预设阈值用短篇的；长篇/未配置用内置默认（body≤5、比喻≤10）。
  sections.push(checkBodyParts(body, short?.body_part_threshold))
  sections.push(checkSimile(body, short?.simile_threshold))

  // 短篇专属项（#27 第 5.3 节，有 config.short 才跑）：五段节数 + 开头零环境（黄金 300 字）
  if (short) {
    sections.push(checkSectionCount(body, short.section_count))
    // R29-B7（二十九轮）：opening_env_chars 显式 0 = 作者关闭「开头零环境」检查
    // （与「未设 = 默认 300」区分，解析侧 yaml.ts 只对显式 0 落键）；undefined 走
    // checkOpeningNoEnv 的缺省参数
    if (short.opening_env_chars !== 0) {
      sections.push(checkOpeningNoEnv(body, short.opening_env_chars))
    }
  }

  // 清单形式检（#27 第 5 节 + #28 第 3 节分工）：章纲在 大纲/章纲/ 与正文同名，有 config.short 才跑
  let pieceList: PieceList | null = null
  if (short && chapter._path) {
    // R32-15（三十二轮）：章纲定位三口径——① 同名 basename（既有口径）；② 目录内按
    // fm 章号匹配（正文 4 位补零重命名/存量 3 位章纲不同名时 basename 恒 miss，清单
    // 形式检静默失明）；③ 文件名数字前缀匹配（无 fm 章号的裸文件兜底，覆盖 0005-标题
    // vs 005-标题 类补零差异）。三口径都空 → 黄项提示（缺失不再静默）。
    const outlineDir = join(bookRoot, '大纲', '章纲')
    let manifestPath: string | null = join(outlineDir, basename(chapter._path))
    if (!existsSync(manifestPath)) {
      const byFm = readChapterDir(outlineDir).chapters.find((o) => o.章号 === chapter.章号 && o._path)
      if (byFm?._path) {
        manifestPath = byFm._path
      } else if (existsSync(outlineDir)) {
        const prefixMatch = (f: string): boolean => {
          const m = /^(\d+)[^\d]/.exec(f)
          return f.endsWith('.md') && m !== null && Number(m[1]) === chapter.章号
        }
        // R37-9（三十七轮）：existsSync→readdirSync 间隙目录被瞬删/异常迁移（TOCTOU，
        // 同 R65-16 口径）或路径被文件占用（ENOTDIR——existsSync 对文件同为 true）时
        // 直穿炸整次机检——降级空列表 + warn 留痕（三口径都空 → 走既有 manifest
        // 缺失黄项提示，不静默），其余错误码照旧抛（失败可见）
        let byName: string | undefined
        try {
          byName = readdirSync(outlineDir).find(prefixMatch)
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            log.warn('check', `章纲目录读取失败（${outlineDir}，${code}），本轮按无章纲处理`)
          } else {
            throw e
          }
        }
        manifestPath = byName ? join(outlineDir, byName) : null
      } else {
        manifestPath = null // 大纲/章纲 目录整个不存在
      }
    }
    if (manifestPath && existsSync(manifestPath)) {
      const r = readPieceList(manifestPath)
      if (r.ok) {
        pieceList = r.list
        sections.push(checkPieceListForm(r.list))
      } else {
        // R62-9：章纲在盘但读取失败（占用/权限/瞬删竞态）不再静默消失——
        // manifest-no-reversal/emotion-curve-*/payoff-open 整体跳过且无提示
        sections.push({
          name: '清单形式检',
          items: [
            {
              checkId: 'piece-list-unreadable',
              level: 'yellow',
              message: `章纲 ${basename(manifestPath)} 读取失败（${r.error.message}），清单形式检本轮未跑，修复后重查。`,
              chapter: chapter.章号,
            },
          ],
        })
      }
    } else {
      // R32-15：本章章纲缺失 → 黄项（此前静默跳过，作者无感知清单形式检没跑）
      sections.push({
        name: '清单形式检',
        items: [
          {
            checkId: 'piece-list-outline-missing',
            level: 'yellow',
            message: `第 ${chapter.章号} 章未找到章纲（大纲/章纲/ 无同名/同章号文件），清单形式检未跑；补写章纲后重查。`,
            chapter: chapter.章号,
          },
        ],
      })
    }
  }

  let byproducts: CheckReport['byproducts'] = {}
  if (hasWiring) {
    byproducts = collectByproducts(sections, db!, chapter.章号, enabledTypes)
  }
  if (short && pieceList) {
    byproducts = { ...byproducts, pieceListChecks: collectPieceListChecks(pieceList) }
  }
  const report: CheckReport = { sections, byproducts }
  // R26-13：严格模式同样走统一后的 short 判定（kind==='short' 的书无 short 段时，
  // strict 由 applyGlobalDefaults 的保底实例化/defaultShortStrict 托底进来）
  if (input.strictShort || short?.strict) promoteStrictShort(report)
  return report
}

/** 收集机检顺带产出（#10 第 2 节末）：本章账本变动清单 + 信息差/新专名候选。
 *  checkedChapter = 被检章自身章号（V-P1-4：三审 ledger_checks 据此核对「本章」账本变动，
 *  不得用全书最高已定稿章号）。 */
function collectByproducts(
  sections: CheckSectionResult[],
  db: DatabaseSync,
  checkedChapter: number,
  enabledTypes: string[],
): CheckReport['byproducts'] {
  const infoLeakCandidates: string[] = []
  const newNames: string[] = []
  for (const s of sections) {
    for (const i of s.items) {
      if (i.checkId === 'info-leak-candidate') infoLeakCandidates.push(i.message)
      else if (i.checkId === 'new-name') newNames.push(i.message)
    }
  }

  // 本章账本变动清单（被检章已入库的履历，按已启用类）
  const placeholders = enabledTypes.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT lh.lead_id AS leadId, lh.chapter AS chapter, lh.verb AS verb, lh.evidence AS evidence
     FROM lead_history lh JOIN leads l ON l.id = lh.lead_id
     WHERE lh.chapter = ? AND l.type IN (${placeholders})
     ORDER BY lh.lead_id`,
  ).all(checkedChapter, ...enabledTypes) as Record<string, unknown>[]
  const leadChanges = rows.map((r) => ({
    leadId: r['leadId'] as string,
    chapter: r['chapter'] as number,
    verb: r['verb'] as string,
    evidence: r['evidence'] as string,
  }))

  return { leadChanges, infoLeakCandidates, newNames }
}

/** 导出 hasRed/getRedItems 方便调用方 */
export { hasRed, getRedItems }

const STRICT_SHORT_CHECK_IDS = new Set([
  'piece-word-short',
  'piece-word-long',
  'body-parts',
  'simile-density',
  'section-count-heading-missing',
  'section-count',
  'opening-env',
  'manifest-no-reversal',
  'manifest-setup-short',
  'manifest-payoff-open',
  'emotion-curve-short',
  'emotion-curve-strength',
  'emotion-curve-no-reversal',
  'emotion-curve-peak-low',
])

function promoteStrictShort(report: CheckReport): void {
  for (const section of report.sections) {
    for (const item of section.items) {
      if (item.level === 'yellow' && STRICT_SHORT_CHECK_IDS.has(item.checkId)) {
        item.level = 'red'
        item.message = `短篇严格模式：${item.message}`
      }
    }
  }
}

function mergeBannedWords(...lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).filter(Boolean))]
}

function collectPieceListChecks(list: PieceList): NonNullable<CheckReport['byproducts']>['pieceListChecks'] {
  const checks: NonNullable<CheckReport['byproducts']>['pieceListChecks'] = []
  const core = list.反转线索表.核心反转
  for (const setup of list.反转线索表.铺垫点) {
    checks.push({
      type: 'reversal',
      subject: core || '核心反转',
      location: setup.位置,
      detail: setup.内容,
    })
  }
  for (const payoff of list.伏笔回收) {
    // R36-30（三十六轮）：payoff 条目 detail 不再无条件复制 location——清单.md 伏笔回收
    // 仅承载 伏笔/回收位置/未回收 三字段，无独立「证据指向」列；detail 缺省时回退
    // location（渲染侧既有 c.detail 口径兜底即可），两字段不再强制同值。未回收条目
    // location 为空，detail 显式标记状态（唯一非空信息点）。
    const location = payoff.回收位置
    checks.push({
      type: 'payoff',
      subject: payoff.伏笔,
      location,
      detail: payoff.未回收 ? '未回收' : location,
    })
  }
  return checks
}
