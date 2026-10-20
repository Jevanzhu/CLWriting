/**
 * R0916-7-P3-26（0916-7 批）源码扫描回归：样式单源两道闸（防复活锚）。
 *
 * ① `.spin` 旋转——收敛前全库 8 处定义（styles/utilities.css 一份 + 7 个组件/视图内
 *    各一份），时长 0.8s / 0.9s / 1s 三档；同一旋转动作三档时长本无依据。收敛后
 *    animation 定义点唯一在 styles/utilities.css，组件内只可留颜色/尺寸覆盖
 *    （OnboardStepPanel 的强调色即此合法形态），不得再写 .spin 的 animation，也不得
 *    在别处新造异档（.save-btn-spin / .ai-btn-spin 是另名类，同受「全库同档」约束）。
 *
 * ② `--text-warning` 回退值——token 在 tokens.css 浅/暗两档均已定义，此前两处回退值
 *    互不同（StartupNoticeBanner 的 #d4a72c 与 WbDraftCard 的 #b8860b）且与 token 三方
 *    不一致；回退值只会掩盖拼写错误、让失配静默，全库清零。
 *
 * ③ 状态点色类（dot-green|red|yellow|gray）——原三色在 ChapterTreeItem 的 scoped 块、
 *    灰色在 styles/utilities.css，同属 CHAPTER_STATUS 一表的两处定义；现收归 utilities.css。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../helpers/repo-root.js'
import { CHAPTER_STATUS } from '../../../src/studio/web-next/src/shared/words'

// 仓根绝对锚（cwd 无关）——collectFiles 按 SRC.length 切片，绝对基址同样成立
const SRC = join(REPO_ROOT, 'src', 'studio', 'web-next', 'src')
const UTILITIES = 'styles/utilities.css'

/** 收集 web-next src 下全部 .vue/.css 源文件，返回相对 SRC 的 posix 路径。 */
function collectFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full))
      continue
    }
    if (/\.(vue|css)$/.test(name))
      out.push(
        full
          .slice(SRC.length + 1)
          .split('\\')
          .join('/'),
      )
    else if (name === 'main.ts') out.push(name)
  }
  return out
}

const read = (rel: string): string => readFileSync(`${SRC}/${rel}`, 'utf-8')
/** 去注释再解析：头注/说明注释里出现的 `.spin` 字样不得被当成选择器文本。 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const readRules = (rel: string): string => stripComments(read(rel))

/** 抽出源码里全部规则块（选择器文本 + 声明体；@media 等嵌套块的内层规则照常命中）。 */
function ruleBlocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!, body: m[2]! })
  }
  return out
}

const files = collectFiles()

describe('R0916-7-P3-26: .spin 旋转动画单源', () => {
  it('全库只有 utilities.css 一处 .spin 规则带 animation（组件内只可留颜色/尺寸覆盖）', () => {
    const definitions = files.filter((rel) =>
      ruleBlocks(readRules(rel)).some(
        // 选择器含独立类 .spin（`.` + spin，且后不接词/连字符——.save-btn-spin 不算）
        ({ selector, body }) => /\.spin(?![\w-])/.test(selector) && /animation/.test(body),
      ),
    )
    expect(definitions).toEqual([UTILITIES])
  })

  it('utilities.css 的 .spin 声明 0.9s（众数档定档处）', () => {
    const blocks = ruleBlocks(readRules(UTILITIES)).filter(({ selector }) => /\.spin(?![\w-])/.test(selector))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body.replace(/\s+/g, ' ').trim()).toBe('animation: clw-spin 0.9s linear infinite;')
  })

  it('全库 clw-spin 动画时长同档（异档 0.8s/1s 不得再出现）', () => {
    const durations = new Set<string>()
    for (const rel of files) {
      for (const m of read(rel).matchAll(/animation(-name)?\s*:\s*([^;]+);/g)) {
        const decl = m[2]!
        if (!decl.includes('clw-spin')) continue
        const dur = decl.match(/(\d+(?:\.\d+)?)s/)
        if (dur) durations.add(dur[0])
      }
    }
    expect([...durations]).toEqual(['0.9s'])
  })

  it('utilities.css 由 main.ts 全局装载（单源得其实效）', () => {
    expect(read('main.ts')).toContain("import './styles/utilities.css'")
  })
})

describe('R0916-7-P3-26: --text-warning 不留回退值', () => {
  it('tokens.css 浅/暗两档均定义 --text-warning', () => {
    const tokens = read('styles/tokens.css')
    const defs = tokens.match(/--text-warning\s*:\s*#[0-9a-fA-F]{3,8}/g) ?? []
    expect(defs.length).toBeGreaterThanOrEqual(2)
  })

  it('全库无 var(--text-warning, <回退值>) 形态', () => {
    const withFallback = files.filter((rel) => /--text-warning\s*,/.test(read(rel)))
    expect(withFallback).toEqual([])
  })
})

// 「已省略 N 条」提示行在 9 个组件里各写一份，收敛前实测漂移：字号 xs(11px)/xxs(10px)
// 两档混用、内距 padding 与 padding-left/padding-top/margin-left 四种写法、font-style
// 缺两处。同一语义的提示行给出四种视觉，读者无从判断是「样式不同」还是「含义不同」。
//
// 判据分两层，缺一层都漏：
//   ①语义属性（颜色/字号/斜体）只许在 utilities.css 出现——组件里再写即红；
//   ②布局属性（内距/外边距/cursor）各随容器，允许留，但必须留在组件里，不许写进
//     utilities.css（否则全局内距会串味到所有调用方）。
describe('省略提示行 .cap-hint 语义单源', () => {
  const SEMANTIC = ['color', 'font-size', 'font-style', 'font-weight']
  const UTILITIES_CAP = `${UTILITIES}`

  /** 取出某文件里 .cap-hint 规则块的声明体（无该块返回 null）。 */
  function capHintBody(rel: string): string | null {
    const block = ruleBlocks(readRules(rel)).find(({ selector }) => /^\.cap-hint$/.test(selector.trim()))
    return block?.body ?? null
  }

  it('语义属性只在 utilities.css 定义，组件内不得再出现', () => {
    const offenders: string[] = []
    for (const rel of files) {
      if (rel === UTILITIES_CAP) continue
      const body = capHintBody(rel)
      if (body === null) continue
      const hit = SEMANTIC.filter((prop) => new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(body))
      if (hit.length > 0) offenders.push(`${rel} 里 .cap-hint 仍声明 ${hit.join(' / ')}`)
    }
    expect(
      offenders,
      '省略提示行的颜色/字号/斜体是「同一语义同形」的部分，只能在 styles/utilities.css 定义；' +
        '组件 scoped 块只留内距/外边距/cursor 这类随容器变化的布局覆盖:\n' +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('utilities.css 的 .cap-hint 三项语义齐备（漏一项则组件必须自己补，单源即破）', () => {
    const body = capHintBody(UTILITIES_CAP)
    expect(body, `styles/utilities.css 缺 .cap-hint 定义`).not.toBeNull()
    for (const prop of ['color', 'font-size', 'font-style']) {
      expect(body, `utilities.css 的 .cap-hint 缺 ${prop}`).toMatch(new RegExp(`(?:^|[;{\\s])${prop}\\s*:`))
    }
  })

  it('内距类布局属性不得写进 utilities.css 的 .cap-hint（全局内距会串味到全部调用方）', () => {
    const body = capHintBody(UTILITIES_CAP) ?? ''
    const layout = ['padding', 'padding-left', 'padding-top', 'margin', 'margin-left', 'cursor'].filter((prop) =>
      new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(body),
    )
    expect(layout, `utilities.css 的 .cap-hint 不应带布局属性：${layout.join(' / ')}`).toEqual([])
  })
})

/**
 * 章节六态状态点的色类（dot-green|red|yellow|gray）单源。
 *
 * 收敛前分居两处：三色在 ChapterTreeItem.vue 的 scoped 块内、灰色在 styles/utilities.css。
 * 态→色 的判定源早已收敛到 shared/words 的 CHAPTER_STATUS 单表，色类却仍是两处定义
 * ——扩一态要改两个文件，漏改即点渲染成透明（无报错、无空态）。现四色唯一定义点在
 * utilities.css（回收站行不在 ChapterTreeItem 子树上，scoped 规则到不了它，故归全局）。
 *
 * 判据取「表列值 ↔ 定义点」双向闭合：单向「表里的色类都有定义」挡不住定义点散开，
 * 故两道断言并用。
 */
describe('章节状态点色类单源（CHAPTER_STATUS.dot）', () => {
  const DOT_CLASSES = ['dot-green', 'dot-red', 'dot-yellow', 'dot-gray']

  it('四色色类唯一定义点在 utilities.css（组件内不得再出现）', () => {
    const definitions = files.filter((rel) =>
      ruleBlocks(readRules(rel)).some(({ selector }) =>
        DOT_CLASSES.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(selector)),
      ),
    )
    expect(definitions).toEqual([UTILITIES])
  })

  it('CHAPTER_STATUS.dot 列与四色定义点闭合（新增态不得指向无色类可渲染的类名）', () => {
    const used = [...new Set(Object.values(CHAPTER_STATUS).map((m) => m.dot))].sort()
    expect(used).toEqual([...DOT_CLASSES].sort())
  })
})

// 书架有两壳（整页 Shelf.vue / 浮层 ShelfModal.vue），同交互两条挂载路径，不该强行合并
// ——但「同形」必须有判据。此前整页缺了「全选盖过渲染帽」提示而浮层有，两边各自看着都
// 正常，没人会发现；补一处后另一处再漏也一样。本组锚定成对出现的交互锚点：只改一壳即红。
describe('书架两壳交互同形（整页 / 浮层）', () => {
  const SHELLS = {
    page: 'pages/Shelf.vue',
    modal: 'components/ui/ShelfModal.vue',
  } as const

  it('两壳都把渲染帽传给 ShelfGrid（帽值单源 shared/render-cap）', () => {
    for (const [label, rel] of Object.entries(SHELLS)) {
      const src = read(rel)
      expect(src, `${label} 未从 shared/render-cap 取帽`).toContain('SHELF_RENDER_CAP')
      expect(src, `${label} 未把帽传给 ShelfGrid（整页不传＝全量挂载，与浮层性能口径不一）`).toContain(
        ':render-cap="SHELF_RENDER_CAP"',
      )
    }
  })

  it('两壳都有「全选盖过渲染帽」的如实提示（含文本与样式类，缺一壳即红）', () => {
    for (const [label, rel] of Object.entries(SHELLS)) {
      const src = read(rel)
      // 触发条件必须同在：只提示不判条件＝每次全选都喊；只判条件不提示＝作者看不见
      expect(src, `${label} 缺全选提示的触发条件（已全选 且 总数超帽）`).toContain(
        'selected.size === shelf.books.length && shelf.books.length > SHELF_RENDER_CAP',
      )
      expect(src, `${label} 缺提示文本`).toContain('已全选全部')
      expect(src, `${label} 缺提示文本里的「对全集生效」语义`).toContain('批量操作对全集生效')
      // 样式类两壳同名：形态不一致本身就是功能差（字号/颜色取舍不同）
      expect(src, `${label} 缺 .sel-all-hint 样式类`).toMatch(/\.sel-all-hint\s*\{/)
    }
  })
})

// 「智能分析」有两页：全局默认页（SettingsAnalysis）与本书覆盖页（SettingsBookAnalysis）。
// 两页**不是重复实现**——实测标签序列不同（全局 34 / 本书 25），全局直写 prefs store
// （0 处 saveConfig、含 5 个数值阈值项），本书走「本书使用独立设定」覆盖开关 + 15 处
// saveConfig 写 book.yaml，没有那 5 个阈值项。合并会把两条失败语义不同的写路径揉进同一个
// 组件的条件分支，去重收益为零。
//
// 但两页必须覆盖**同一组组名**（同一功能在两层各有入口）——一边加组、另一边忘加，作者在
// 那一层就找不到设置，而两页各自看着都正常。本组锚定这条同集约束。
describe('智能分析两页组名同集（全局默认 / 本书覆盖）', () => {
  const PAGES = {
    global: 'components/ui/SettingsAnalysis.vue',
    book: 'components/ui/SettingsBookAnalysis.vue',
  } as const

  /** 抽模板里 cfg-card-head 的组名文本（去掉尾部徽章等子元素）。 */
  function groupNames(rel: string): string[] {
    const src = read(rel)
    const out: string[] = []
    for (const m of src.matchAll(/class="cfg-card-head"[^>]*>([\s\S]*?)<\/div>/g)) {
      const text = (m[1] ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (text !== '') out.push(text)
    }
    return out
  }

  it('两页组名集合相同（顺序不限——全局页把知识层排在关系图之前）', () => {
    const g = groupNames(PAGES.global)
    const b = groupNames(PAGES.book)
    expect(g.length, `全局页没取到组名，扫描面可能失效`).toBeGreaterThan(0)
    expect([...g].sort(), `全局页组名：${g.join(' / ')}；本书页组名：${b.join(' / ')}`).toEqual([...b].sort())
  })

  it('四个已知组都在两页里各出现一次（组名改名即红）', () => {
    const expected = ['AI 机检', '关系图', '知识检索', '知识层']
    for (const [label, rel] of Object.entries(PAGES)) {
      const names = groupNames(rel)
      for (const name of expected) {
        expect(
          names.filter((n) => n === name),
          `${label} 缺组「${name}」（或重复）`,
        ).toHaveLength(1)
      }
    }
  })
})
