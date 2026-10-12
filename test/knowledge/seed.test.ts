/**
 * 书级知识层播种与升级(统一批)—— src/knowledge/seed.ts 单测。
 *
 * 锚定对外可观察行为:
 * 1) 建书播种:随包语料按要求铺进书根 知识层/(跳非语料项,幂等,已存在不覆盖);
 * 2) 升级不覆盖用户改动:哈希命中历史表(=未改动的旧版拷贝)→ 升级为当前随包;
 *    哈希不命中(=作者改过)→ 原样保留;
 * 3) 随包新增篇 → 补播;随包缺失/读失败 → 逐篇容错不拖死整轮。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { seedBookKnowledge, seedKnowledgeOnBookCreate, listBundledSeedRels } from '../../src/knowledge/seed.js'

let dir: string
let prevResourcesDir: string | undefined

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-seed-'))
  prevResourcesDir = process.env['CLWRITING_RESOURCES_DIR']
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevResourcesDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = prevResourcesDir
})

/** 造受限随包资源根:knowledge/<rel> 写正文 + versions 表(rel → 历史哈希)。 */
function stubBundled(files: Record<string, string>, versions: Record<string, string[]>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, 'knowledge', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'versions.json'), JSON.stringify(versions, null, 2))
  process.env['CLWRITING_RESOURCES_DIR'] = dir
}

describe('建书播种(seedKnowledgeOnBookCreate / seedBookKnowledge seedOnly)', () => {
  it('随包语料铺进书根 知识层/,非语料项(README/versions/许可)不铺', async () => {
    stubBundled(
      { '追读力/章节钩子速查.md': '钩子正文。', '方法论/人物与对话技法速查.md': '人物正文。' },
      { '追读力/章节钩子速查.md': [], '方法论/人物与对话技法速查.md': [] },
    )
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    seedKnowledgeOnBookCreate(bookRoot)
    expect(existsSync(join(bookRoot, '知识层', '追读力', '章节钩子速查.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '知识层', '方法论', '人物与对话技法速查.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '知识层', 'versions.json'))).toBe(false)
    expect(existsSync(join(bookRoot, '知识层', 'README.md'))).toBe(false)
  })

  it('幂等:重复播种不覆盖已存在的书级篇(作者改动安全)', () => {
    stubBundled({ '追读力/章节钩子速查.md': '随包原版。' }, { '追读力/章节钩子速查.md': [] })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者手改版。')
    const r = seedBookKnowledge(bookRoot, { seedOnly: true })
    expect(r.seeded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者手改版。')
  })
})

describe('升级不覆盖用户改动', () => {
  it('未改动的旧版拷贝(哈希命中历史表)→ 升级为当前随包', async () => {
    const oldBody = '旧版正文。'
    const newBody = '新版正文。'
    // 造随包:当前为新版,历史表含旧版哈希
    mkdirSync(join(dir, 'knowledge', '追读力'), { recursive: true })
    const bundledAbs = join(dir, 'knowledge', '追读力', '章节钩子速查.md')
    writeFileSync(bundledAbs, newBody)
    // 先算旧版哈希(临时文件)
    const tmpOld = join(dir, 'old.bin')
    writeFileSync(tmpOld, oldBody)
    const { hashBytes } = await import('../../src/fs/hash.js')
    const oldH = hashBytes(readFileSync(tmpOld))
    const newH = hashBytes(readFileSync(bundledAbs))
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ '追读力/章节钩子速查.md': [oldH, newH] }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir

    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, oldBody) // 书级 = 未改动的旧版拷贝
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual(['追读力/章节钩子速查.md'])
    expect(readFileSync(dst, 'utf-8')).toBe(newBody)
  })

  it('作者改过的篇(哈希不在历史表)→ 原样保留', async () => {
    const newBody = '随包新版。'
    mkdirSync(join(dir, 'knowledge', '追读力'), { recursive: true })
    const bundledAbs = join(dir, 'knowledge', '追读力', '章节钩子速查.md')
    writeFileSync(bundledAbs, newBody)
    const { hashBytes } = await import('../../src/fs/hash.js')
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ '追读力/章节钩子速查.md': [hashBytes(readFileSync(bundledAbs))] }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir

    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者大改过的正文。') // 哈希不在历史表
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者大改过的正文。')
  })

  it('无历史表条目 → 保守不覆盖(即便书级与随包不同)', () => {
    // versions 表里没有该 rel(如新篇尚未登记历史哈希)——无从判定书级副本是
    // 旧版原样拷贝还是作者改过,宁可留旧也不动(误覆盖会毁掉作者的写作口径)
    stubBundled({ '追读力/章节钩子速查.md': '随包新版。' }, {})
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '书级旧版(无从判定是否作者改过)。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('书级旧版(无从判定是否作者改过)。')
  })

  it('随包新增篇 → 补播(书级原本无此 rel)', () => {
    stubBundled({ '追读力/新篇.md': '新篇正文。' }, { '追读力/新篇.md': [] })
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    const r = seedBookKnowledge(bookRoot)
    expect(r.seeded).toContain('追读力/新篇.md')
    expect(existsSync(join(bookRoot, '知识层', '追读力', '新篇.md'))).toBe(true)
  })
})

describe('随包缺失容错', () => {
  it('随包 knowledge/ 目录缺失 → 空报告不抛', () => {
    process.env['CLWRITING_RESOURCES_DIR'] = dir // 无 knowledge/
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    expect(seedBookKnowledge(bookRoot)).toEqual({ seeded: [], upgraded: [], kept: [], retired: [] })
  })

  it('真实仓随包:播种面 = 通用 9 + 长篇 10 + 短篇 7（33 篇减去许可件与旧件）', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const rels = listBundledSeedRels()
    // 语料重建批:播种 = 随包扫描（新篇不需另登记表）
    expect(rels.filter((r) => r.startsWith('通用/')).length).toBe(9)
    expect(rels.filter((r) => r.startsWith('长篇/')).length).toBe(10)
    expect(rels.filter((r) => r.startsWith('短篇/')).length).toBe(7)
    expect(rels).toContain('长篇/章节钩子速查.md')
    expect(rels).toContain('短篇/反转机制速查.md')
    // 退旧件（旧 4 随包 rel）不再在播种面——其书级副本由退役步处置
    expect(rels.some((r) => r.startsWith('追读力/'))).toBe(false)
    expect(rels.some((r) => r.startsWith('爽点/'))).toBe(false)
    expect(rels.some((r) => r.startsWith('方法论/'))).toBe(false)
    // 许可件不播种
    expect(rels.some((r) => r.startsWith('许可/'))).toBe(false)
  })

  it('真实仓退役段:旧 4 随包 rel 已登记(存量书升级即删未改动副本)', async () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const { readRetiredKnowledgeRels } = await import('../../src/knowledge/seed.js')
    const retired = readRetiredKnowledgeRels()
    for (const rel of [
      '追读力/章节钩子速查.md',
      '追读力/节奏与升级感速查.md',
      '爽点/反转设计速查.md',
      '方法论/人物与对话技法速查.md',
    ]) {
      expect(retired[rel], rel).toBeDefined()
      expect(retired[rel]!.length).toBeGreaterThan(0)
    }
    // 仍随包在位的现役篇不得进退役段（否则升级会删掉在役件）
    expect(retired['长篇/章节钩子速查.md']).toBeUndefined()
    expect(retired['通用/情节推演速查.md']).toBeUndefined()
  })
})

// ── 旧件退役（退役段驱动：只删登记在退役段且书级未改动的件）────────────────────
// 退役数据（旧 6 rel 入退役段）随 D2 收口落；本组造退役段直测机制。
describe('旧件退役（未改动删除 / 作者改过保留 / 未登记不误删 / 退役段空不删）', () => {
  /** 造随包 + 退役段；返回退役段所用哈希 */
  async function stubRetired(args: {
    live?: Record<string, string>
    retired: Record<string, string> // rel → 正文（哈希由本函数实算）
  }): Promise<Record<string, string[]>> {
    const { hashBytes } = await import('../../src/fs/hash.js')
    const live = args.live ?? {}
    for (const [rel, body] of Object.entries(live)) {
      const abs = join(dir, 'knowledge', ...rel.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, body)
    }
    const table: Record<string, string[]> = {}
    const retiredSeg: Record<string, string[]> = {}
    for (const [rel, body] of Object.entries(args.retired)) {
      const h = hashBytes(Buffer.from(body))
      table[rel] = [h]
      retiredSeg[rel] = [h]
    }
    for (const [rel, body] of Object.entries(live)) table[rel] = [hashBytes(Buffer.from(body))]
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ ...table, __retired__: retiredSeg }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir
    return retiredSeg
  }

  it('未改动的旧件（书级哈希命中退役段）→ 删除并记 retired', async () => {
    const OLD = '旧钩子篇正文。'
    await stubRetired({ live: { '通用/情节推演速查.md': '新篇。' }, retired: { '追读力/章节钩子速查.md': OLD } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, OLD) // 书级 = 未改动的原样拷贝
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual(['追读力/章节钩子速查.md'])
    expect(existsSync(dst)).toBe(false)
    // 新篇照常播种
    expect(r.seeded).toContain('通用/情节推演速查.md')
  })

  it('作者改过的旧件 → 保留并记 kept（永不删作者自有内容）', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者大改过的口径。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者大改过的口径。')
  })

  it('书级自发新件（不在退役段）不误删', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const mine = join(bookRoot, '知识层', '我的类目', '自建篇.md')
    mkdirSync(join(mine, '..'), { recursive: true })
    writeFileSync(mine, '作者自建。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(mine)).toBe(true)
  })

  it('退役段为空 → 不删任何件（机制在位、数据随批落）', () => {
    // versions 表只有主段（无 __retired__ 键）
    stubBundled({ '通用/情节推演速查.md': '新篇。' }, { '通用/情节推演速查.md': [] })
    const bookRoot = join(dir, 'book')
    const old = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(old, '..'), { recursive: true })
    writeFileSync(old, '旧件原样（退役段为空 → 留着）。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(old)).toBe(true)
  })

  it('建书播种（seedOnly）不退役——新书根无历史件，退役归升级链', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '旧版原样。')
    const r = seedBookKnowledge(bookRoot, { seedOnly: true })
    expect(r.retired).toEqual([])
    expect(existsSync(dst)).toBe(true)
  })

  it('退役段含仍在随包的 rel → 不删（同名换位交播种/升级步处置）', async () => {
    await stubRetired({
      live: { '追读力/章节钩子速查.md': '随包现役同 rel。' },
      retired: { '追读力/章节钩子速查.md': '旧版原样。' },
    })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '旧版原样。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(dst)).toBe(true)
  })
})

// ── 存量书升级实测（真人字形：旧件字节 = 退件前随包发布体，哈希与退役表逐字对齐）──
// 这组用例的字面量不是手造的：内容取自退件前的随包发布体，故其 sha256 即真实书根
// 上「未改动旧副本」的哈希。退役表若有任何一位被改动、或退役步被摘除，本组即红——
// 这是「存量书升级后无新旧并存」这条验收判据的直接锚点。
describe('存量书升级实测（旧件字节 = 退件前随包发布体）', () => {
  /** rel → [旧件正文, 退役段登记哈希] */
  const LEGACY: Array<[string, string, string]> = [
    ["追读力/章节钩子速查.md", "---\nsource: Dev/oh-story-claudecode/skills/story-setup/references/agent-references/hooks-chapter.md\nsource_ref: db95ba2e972fd688cdada3a54747a5725c6b5f5b\nlicense: MIT\nadaptation: selected-extract\n---\n\n# 章节钩子速查\n\n用于 M4 真模型写稿阶段，帮助选择章首、章尾钩子。正文细节仍以本书大纲、账本和章节细纲为准。\n\n## 选择路由\n\n- 悬念/未知：突然揭示、神秘物品、留白。\n- 紧迫/危机：紧急危机、倒计时、未完成动作。\n- 反转/真相：身份反转、隐藏含义、回声钩子。\n- 情感/关系：两难抉择、承诺威胁、情感转折。\n- 氛围/日常：意象钩子、离奇消失、信息差。\n\n## 章首钩子\n\n- 直接冲击：未完成动作开局、倒计时开局。\n- 制造好奇：悬念对话、闪前碎片、神秘独白。\n- 对比冲击：反差场景、意象预示。\n\n## 章尾钩子\n\n- 突然揭示：抛出改变全局的信息。\n- 紧急危机：制造下章必须回应的威胁。\n- 未完成动作：动作被新变量打断。\n- 身份反转：某人或某事不是读者以为的样子。\n- 两难抉择：角色被迫在两个代价中选择。\n- 隐藏含义：表面正常，实际暗藏信息。\n- 回声钩子：章尾呼应章首，但关键细节改变。\n- 留白钩子：只展示反应，不解释发生了什么。\n\n## 使用原则\n\n- 看点负责吊起期待，爽点负责满足期待。\n- 铺垫比打脸更重要；打脸前必须把道具、人物或实力准备好。\n- 章末钩子要短，重点是把下章必须回答的问题钉住。\n- 钩子不能替代推进；本章必须有局势变化。\n\n", "sha256:effee39b755328f57c00b38227784554f6828dbd1fe046d41729d21b5dbb5807"],
    ["追读力/节奏与升级感速查.md", "---\nsource: Dev/oh-story-claudecode/skills/story-setup/references/agent-references/outline-rhythm.md\nsource_ref: db95ba2e972fd688cdada3a54747a5725c6b5f5b\nlicense: MIT\nadaptation: selected-extract\n---\n\n# 节奏与升级感速查\n\nPhase 3-4 节奏把控、升级感设计、期待感管理时加载。正文细节仍以本书大纲、账本为准。\n\n## 路由\n\n| 在设计什么 | 方法 |\n|---|---|\n| 升级感 / 升级节奏 | 升级感三步法 + 循环嵌套 + 对比表 |\n| 情绪节奏 | 情绪模块公式 + 桥段结构化 |\n| 高潮设计 | 高潮分类 + 反推四要素 |\n| 开篇节奏 | 黄金五章 + 开头精简法 + 节奏底线 |\n| 期待感管理 | 拉期待原则 + 真空期急救 |\n| 战斗 / 智斗 | 回合制卡牌 + 三步两线法 |\n\n## 升级感三步法\n\n1. **确立参照系**：读者要知道「现在多强」——给量化锚点（排名/境界/财富对比）。\n2. **制造落差**：新场景/新对手打破旧参照系，让读者感到「原来还有更强的」。\n3. **兑现跨越**：角色跨过落差，参照系更新；循环嵌套，每轮落差递增。\n\n## 期待感管理\n\n- **拉期待**：先让读者知道「可能得到什么」，再延迟兑现；期待值 = 价值 × 可能性。\n- **真空期急救**：主线推进间隙用副线/日常/伏笔填，但不能替代推进。\n- **章末钉问题**：每章结尾钉住一个「下章必须回答」的问题。\n\n## 节奏底线\n\n- 每章必须有局势变化（钩子不能替代推进）。\n- 黄金五章：前 5 章立人设、立金手指、立第一个爽点、立核心冲突。\n- 高潮反推：先定高潮要解决什么，再倒推需要哪些铺垫。\n", "sha256:4b0b6c7a075418e4fd0f0dc0611ca62a7535b5af99fd94549f8211b789ea7243"],
    ["爽点/反转设计速查.md", "---\nsource: Dev/oh-story-claudecode/skills/story-setup/references/agent-references/reversal-toolkit.md\nsource_ref: db95ba2e972fd688cdada3a54747a5725c6b5f5b\nlicense: MIT\nadaptation: selected-extract\n---\n\n# 反转设计速查\n\n设计反转、打脸节奏、误导嵌套时加载。反转类型与拆文 meta 的 reversal_type 字段一致。\n正文细节仍以本书大纲、账本为准。\n\n## 类型路由\n\n| 要设计什么 | 反转类型 | 关键操作 |\n|---|---|---|\n| 角色不是你以为的人 | 身份反转 | 埋 3 处行为细节暗示 |\n| 真相从另一角度完全不同 | 视角反转 | 引入另一角色视角打破认知 |\n| 做事的原因不是你以为的 | 动机反转 | 高压场景中二选一暴露真动机 |\n| 时间顺序与读者理解不同 | 时间线反转 | 不撒谎只调叙述顺序 |\n| 读者掌握了错误信息 | 信息反转 | 新证据直接否定旧「事实」 |\n| 对角色/关系的理解被颠覆 | 认知反转 | 全程铺感情色彩，结尾翻转 |\n| 甜宠/喜剧/报应型 | 无反转 | 走报应兑现或甜度递进，不硬塞 |\n| 要叠多层 | 嵌套反转 | 主次分明，间隔递减 |\n\n## 设置与揭示\n\n- **埋线**：反转前必须有至少 2-3 处「事后回看才懂」的细节，不能凭空翻。\n- **误导**：给读者一个「看起来更合理」的错误解释，真相反着走。\n- **揭示**：新证据一次性推翻旧认知，不挤牙膏；揭示后立刻有情绪兑现。\n\n## 打脸节奏\n\n- 打脸前必须铺垫（道具/人物/实力就位），铺垫比打脸更重要。\n- 打脸要分层：小打脸密集（每 1-2 章），大打脸间隔（卷末）。\n- 报应兑现型：恶有恶报的兑现要具体、可感，不能靠旁白宣告。\n\n## 自检\n\n- [ ] 反转前有埋线细节吗？（至少 2-3 处）\n- [ ] 反转后行为逻辑通顺吗？（不能只翻结论不翻动机）\n- [ ] 揭示后有情绪兑现吗？（爽感/震惊/唏嘘）\n", "sha256:37900d3b9eac39fa4a86f32f75bf9f98785d242a87d0b99cdb7913e501ba218b"],
    ["方法论/人物与对话技法速查.md", "---\nsource: Dev/oh-story-claudecode/skills/story-setup/references/agent-references/character-design-methods.md\nsource_ref: db95ba2e972fd688cdada3a54747a5725c6b5f5b\nlicense: MIT\nadaptation: selected-extract\n---\n\n# 人物与对话技法速查\n\n设计人物、写对话、处理人物关系时加载。合并自 character-design-methods 与 dialogue-mastery。\n正文细节仍以本书大纲、账本、名册为准。\n\n## 人物设计三维度\n\n1. **核心欲望**：角色最想要什么？欲望驱动一切行动，没有欲望的角色是工具人。\n2. **致命缺陷**：阻碍欲望实现的内在缺陷（骄傲/懦弱/执念），是成长弧的起点。\n3. **标志性细节**：一个让读者记住的外化细节（口头禅/小动作/物件），比大段外貌描写有效。\n\n## 人物弧线\n\n- 起点：缺陷 + 错误信念 → 经历：挑战 + 代价 → 终点：觉悟 + 改变（或悲剧性坚持）。\n- 弧线要付代价：没有代价的成长不可信。\n- 反派也要有欲望和逻辑：纯恶的工具人反派无法支撑长篇。\n\n## 对话技法\n\n- **潜台词**：角色说的不是想的；好对话有「水面下的意思」。\n- **冲突即对话**：每段对话应有权力/信息/情感的错位，纯信息传递的对话是废话。\n- **标签克制**：多用动作替代「他说/她问」；对话标签占比高 = 机器味重。\n- **声音区分**：不同角色的用词、句长、语气应可辨，不能换名字就一样。\n\n## 关系网\n\n- 每对核心关系都要有张力来源（利益/情感/信息差）。\n- 关系变化要有事件驱动，不能靠旁白「他们关系变好了」。\n- 名册里的专名要与关系网一致，设定校对会查。\n\n## 自检\n\n- [ ] 这个角色有核心欲望吗？（不是只有功能）\n- [ ] 对话有潜台词/冲突吗？（不是只传信息）\n- [ ] 对话标签是否过多？（文风铁律会查占比）\n", "sha256:c7ee3c48386688501df2f6705d93110dc2afd8dc300a669ad89d020679115d5e"],
  ]

  it('旧件字节哈希与退役段登记值逐字一致（表 ≠ 实即红）', async () => {
    const { hashBytes } = await import('../../src/fs/hash.js')
    const { readRetiredKnowledgeRels } = await import('../../src/knowledge/seed.js')
    delete process.env['CLWRITING_RESOURCES_DIR']
    const retired = readRetiredKnowledgeRels()
    for (const [rel, content, hash] of LEGACY) {
      expect(hashBytes(Buffer.from(content, 'utf8')), rel).toBe(hash)
      expect(retired[rel], rel).toContain(hash)
    }
  })

  it('存量书升级：未改动旧件删除、7+10+9 新篇补播、作者改过件保留（无新旧并存）', async () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const bookRoot = join(dir, 'legacy-book')
    // 书根铺 4 件旧副本（真实发布体字节 = 未改动）+ 1 件作者改过的旧件
    for (const [rel, content] of LEGACY) {
      const dst = join(bookRoot, '知识层', ...rel.split('/'))
      mkdirSync(join(dst, '..'), { recursive: true })
      writeFileSync(dst, content)
    }
    const edited = join(bookRoot, '知识层', '追读力', '作者改过的篇.md')
    writeFileSync(edited, '作者自有口径。')

    const r = seedBookKnowledge(bookRoot)
    // 未改动旧件全部退役删除
    expect(r.retired.sort()).toEqual(LEGACY.map(([rel]) => rel).sort())
    for (const [rel] of LEGACY) expect(existsSync(join(bookRoot, '知识层', ...rel.split('/'))), rel).toBe(false)
    // 新档篇目补播（通用 9 + 长篇 10 + 短篇 7 中新增到书根的）
    expect(r.seeded.filter((x) => x.startsWith('长篇/')).length).toBe(10)
    expect(r.seeded.filter((x) => x.startsWith('通用/')).length).toBe(9)
    expect(r.seeded.filter((x) => x.startsWith('短篇/')).length).toBe(7)
    expect(existsSync(join(bookRoot, '知识层', '长篇', '章节钩子速查.md'))).toBe(true)
    // 作者改过/自建件原样保留（未被扫进退役）
    expect(existsSync(edited)).toBe(true)
    expect(r.retired).not.toContain('追读力/作者改过的篇.md')
  })

  it('重复升级幂等：第二次跑零退役零补播', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const bookRoot = join(dir, 'legacy-book-2')
    for (const [rel, content] of LEGACY) {
      const dst = join(bookRoot, '知识层', ...rel.split('/'))
      mkdirSync(join(dst, '..'), { recursive: true })
      writeFileSync(dst, content)
    }
    const first = seedBookKnowledge(bookRoot)
    expect(first.retired.length).toBe(LEGACY.length)
    const second = seedBookKnowledge(bookRoot)
    expect(second.retired).toEqual([])
    expect(second.seeded).toEqual([])
  })
})
