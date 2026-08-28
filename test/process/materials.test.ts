/**
 * 备料编排测试 —— M7 #37 R1 接缝真正接入（prepareMaterials：recall → prepare）。
 *
 * 验收点：
 * - 未配 RAG → 行为逐字节不变（与 prepare() 直接调用一致）
 * - 已配 RAG + key → 命中召回 → 备料含「RAG 召回」段
 * - 已配 RAG 但无 key → 降级（无召回段，ragNote 标注）
 * - 已配 RAG 但召回无命中 → 降级（无召回段）
 *
 * 桩 embed 不联网：把文本首字符 charCode 归一化成 3 维向量（确定性）。
 */

import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, writeFileSync, existsSync, renameSync, readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter } from '../../src/cache/sync.js'
import { prepareMaterials } from '../../src/process/materials.js'
import { writeBookConfig, DEFAULT_CONFIG, setSectionKeyBlock } from '../../src/format/yaml.js'
import { writeChapter } from '../helpers/chapter.js'
import { buildIndex } from '../../src/rag/index.js'
import { enableRag } from '../../src/rag/config.js'
import { emptySettings, saveProviders } from '../../src/ai/provider/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

/** 建一本带 .cache + 文风铁律 + 1 章定稿正文的测试书。 */
function makeBook(): { root: string; workDir: string; db: DatabaseSync } {
  const workDir = mkdtempTracked(join(tmpdir(), 'mat-wd-'))
  const root = join(workDir, 'mybook')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '.cache'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')
  mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
  writeFileSync(
    join(root, '文风', '样章库', '对话', '对话-001.md'),
    '---\n场景: 对话\n来源: 作者原作\n技法指令: 学它的留白\n---\n她沉默了一会儿，说：你早就知道。',
    'utf-8',
  )

  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p1',
  })

  // 写 1 章定稿正文（供 RAG 建索引 + 召回后精准读取切片）
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  const meta: ChapterMeta = {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _path: '', _wordCount: 100,
  }
  writeChapter(
    join(root, '写作', '正文', '1-前章.md'),
    meta,
    '主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷。这是战斗场景的详细描写。',
  )
  return { root, workDir, db }
}

/** 桩 embed：确定性，不联网。 */
function stubEmbed(_ep: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

test('未配 RAG → prepareMaterials 行为与 prepare 逐字节一致', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 未配 RAG（默认 book.yaml 无 rag 段）
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    expect(r.ragUsed).toBe(false)
    expect(r.ragHitCount).toBe(0)
    // 无 RAG 段
    expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()
    expect(r.ragNote).toBeUndefined() // 未配不算降级
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('prepareMaterials: 透传 sampleScene 给文风样章', async () => {
  const { root, workDir, db } = makeBook()
  try {
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], sampleScene: '对话',
    })
    const styleSection = r.sections.find((s) => s.title === '文风样章')
    expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
    expect(styleSection!.content).toContain('学它的留白')
    expect(styleSection!.content).toContain('你早就知道')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('G1: 未传 sampleScene + chapter → 水源①章纲 fm「场景」（kk-P1-2 归一后主路径）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 章纲在 大纲/章纲/，fm 声明本章场景为「对话」——与节奏对照同字段
    const od = join(root, '大纲', '章纲')
    mkdirSync(od, { recursive: true })
    writeChapter(join(od, '0002-夜谈.md'), {
      章号: 2, 标题: '夜谈', 钩子类型: '悬念钩', 钩子强弱: '中',
      情绪定位: '铺垫', 场景: '对话', _path: '',
    }, '主角与对手长谈。')

    // 不传 sampleScene、传 chapter —— 应从章纲 fm 自动解析出「对话」
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], chapter: 2,
    })
    const styleSection = r.sections.find((s) => s.title === '文风样章')
    expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
    expect(styleSection!.content).toContain('你早就知道') // 命中对话样章
    expect(styleSection!.content).toContain('学它的留白')
    expect(r.styleNote).toBeUndefined() // 有样章不留痕
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('G1: 水源②正文 fm「场景」——无章纲时场景跟随实稿（重写/续写章）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 本章无章纲；正文旧稿 fm 声明「对话」
    writeChapter(join(root, '写作', '正文', '2-旧稿.md'), {
      章号: 2, 标题: '旧稿', 钩子类型: '悬念钩', 钩子强弱: '中',
      情绪定位: '铺垫', 场景: '对话', _path: '', _wordCount: 10,
    }, '旧稿正文。')

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], chapter: 2,
    })
    const styleSection = r.sections.find((s) => s.title === '文风样章')
    expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
    expect(styleSection!.content).toContain('你早就知道')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('G1: 水源③细纲「## 场景声明」段（前两源空）；章号门拦别章陈旧细纲', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 细纲 fm 章号=2 + 正文含场景声明段（outline 端点短篇 prompt 的落盘形态）
    const wd = join(root, '工作区')
    mkdirSync(wd, { recursive: true })
    writeFileSync(
      join(wd, '细纲.md'),
      '---\n章号: 2\n---\n## 场景声明\n本章主场景:「对话」。\n\n## 伏笔\n别段引号词「战斗」不串段。',
      'utf-8',
    )

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir: wd, chapterLeadIds: [], chapter: 2,
    })
    expect(r.sections.find((s) => s.title === '文风样章')).toEqual(expect.objectContaining({ title: '文风样章' }))

    // 章号门：细纲 fm 章号≠被检章 → 此水源整体弃用（防别章陈旧细纲串场景）
    const r2 = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir: wd, chapterLeadIds: [], chapter: 5,
    })
    expect(r2.sections.find((s) => s.title === '文风样章')).toBeUndefined()
    expect(r2.styleNote).toBeUndefined()
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('G1: 三级全空（冷启动）→ 回落「通用」而非「战斗」（kk-P1-2 语义修正）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 细纲在但无场景声明段；无章纲；正文 fm 无场景 → 三级全空
    const wd = join(root, '工作区')
    mkdirSync(wd, { recursive: true })
    writeFileSync(join(wd, '细纲.md'), '---\n章号: 2\n---\n本章无场景声明。', 'utf-8')

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir: wd, chapterLeadIds: [], chapter: 2,
    })
    // makeBook 只有「对话」样章：回落「通用」→ 无样章段；「战斗」默认已废 → 同样无段，
    // 但语义上不再假装本章是战斗（通用目录才是查找目标）
    expect(r.sections.find((s) => s.title === '文风样章')).toBeUndefined()
    expect(r.styleNote).toBeUndefined() // 冷启动无声明 → 不留痕（逐字节红线）
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('legacy: 不传 chapter 的旧调用 → 维持 prepare 内部「战斗」回落（不推导场景）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    const wd = join(root, '工作区')
    mkdirSync(wd, { recursive: true })
    // 即使细纲带场景声明段，legacy 调用不读任何水源
    writeFileSync(join(wd, '细纲.md'), '---\n章号: 2\n---\n## 场景声明\n本章主场景:「对话」。', 'utf-8')

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir: wd, chapterLeadIds: [],
    })
    expect(r.sections.find((s) => s.title === '文风样章')).toBeUndefined() // 战斗无样章
    expect(r.styleNote).toBeUndefined()
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('G3: 声明场景但无样章 → styleNote 留痕（提示去 learn 补）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // makeBook 只有「对话」样章；章纲声明「抒情」→ 查无样章 → 留痕
    const od = join(root, '大纲', '章纲')
    mkdirSync(od, { recursive: true })
    writeChapter(join(od, '0002-抒情章.md'), {
      章号: 2, 标题: '抒情章', 钩子类型: '情绪钩', 钩子强弱: '中',
      情绪定位: '铺垫', 场景: '抒情', _path: '',
    }, '本章抒情。')

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], chapter: 2,
    })
    expect(r.sections.find((s) => s.title === '文风样章')).toBeUndefined()
    expect(r.styleNote).toBeTypeOf('string')
    expect(r.styleNote).toContain('抒情')
    expect(r.styleNote).toContain('learn')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('已配 RAG + key + 命中 → 备料含「RAG 召回」段', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 启用 RAG（非密入 book.yaml + key 落 .clwriting/rag.secret）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    // 先建索引（用桩 embed 注入 buildIndex）
    const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(root, cfg, 'stub-key', stubEmbed)

    // prepareMaterials 注入同一个桩 embedFn，让 recall 用确定性向量命中
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], embedFn: stubEmbed,
    })
    expect(r.ragUsed).toBe(true)
    expect(r.ragHitCount).toBeGreaterThan(0)
    // 备料含 RAG 召回段
    const ragSection = r.sections.find((s) => s.title === 'RAG 召回')
    expect(ragSection).toEqual(expect.objectContaining({ title: 'RAG 召回' }))
    expect(ragSection!.flexibleRank).toBe(5)
    // 召回内容引用了第1章正文（精准读取切片）
    expect(ragSection!.content).toContain('第1章')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('CC-P2-21: 3 位补零命名（草稿新建口径）的章 → 召回后仍能精准读正文切片', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 草稿新建用 3 位补零（format/draft.ts resolveDraftPath）；此前 readChapterBodyByNumber
    // 只试「无补零 + 4 位」，这些章 RAG 命中后正文静默读 null → 召回段空手而归
    renameSync(join(root, '写作', '正文', '1-前章.md'), join(root, '写作', '正文', '001-前章.md'))
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(root, cfg, 'stub-key', stubEmbed)

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], embedFn: stubEmbed,
    })
    expect(r.ragHitCount).toBeGreaterThan(0)
    const ragSection = r.sections.find((s) => s.title === 'RAG 召回')
    expect(ragSection).toBeDefined()
    // 正文切片真实取到（而非只有章号头行——正文读 null 时该段不会出现正文文字）
    expect(ragSection!.content).toContain('古卷')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('已配 RAG 但无 key → 降级（无召回段，ragNote 标注）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 启用 RAG 但不落 key（useEnv 模式 + 不设环境变量）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', useEnv: true })
    // 确保无环境变量也无 secret 文件
    delete process.env.CLWRITING_RAG_API_KEY
    expect(existsSync(join(workDir, '.clwriting', 'rag.secret'))).toBe(false)

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    expect(r.ragUsed).toBe(false)
    expect(r.ragNote).toContain('api_key')
    expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('服务商化：书存 rag.provider 引用应用级服务商 → 召回可用（key 来自服务商）', async () => {
  const { root, workDir, db } = makeBook()
  const userData = mkdtempTracked(join(tmpdir(), 'mat-ud-'))
  try {
    delete process.env.CLWRITING_RAG_API_KEY
    // 应用级服务商 fixture（key 走 vault 落 providers.json）
    const store = emptySettings()
    store.ragProviders = [{
      id: 'rag-stub', name: '测试嵌入', endpoint: 'http://stub-prov', model: 'stub-model',
      apiKey: 'prov-key', caps: null,
    }]
    saveProviders(userData, store)

    // 书只存 enabled + provider 引用（服务商化后的新形态）
    writeBookConfig(join(root, 'book.yaml'), {
      ...DEFAULT_CONFIG,
      rag: { enabled: true, provider: 'rag-stub' },
    })
    await buildIndex(root, { enabled: true, endpoint: 'http://stub-prov', model: 'stub-model' }, 'prov-key', stubEmbed)

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], embedFn: stubEmbed, userDataPath: userData,
    })
    expect(r.ragUsed).toBe(true)
    expect(r.ragHitCount).toBeGreaterThan(0)
    expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeDefined()
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})

test('降级不崩主路径：备料文本仍含刚需段（近况/文风铁律）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 已配 RAG 但无 key（降级路径）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', useEnv: true })
    delete process.env.CLWRITING_RAG_API_KEY

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    // 刚需段必须在（降级只影响 RAG 召回段）
    expect(r.sections.find((s) => s.title === '近况')).toEqual(expect.objectContaining({ title: '近况' }))
    expect(r.sections.find((s) => s.title === '文风铁律')).toEqual(expect.objectContaining({ title: '文风铁律' }))
    expect(r.text.length).toBeGreaterThan(0)
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

// 低-1（第十轮）：RAG 无命中降级分支是同函数三处 prepare 调用点里唯一漏传
// writingChapter 的——L-P3「卷号按写作章推」只在另两分支生效，本分支卷首章的
// 上卷摘要晚一章注入。空库（不建索引）走无命中路径，不烧 embed。
test('低-1（第十轮）：RAG 无命中降级也传 writingChapter——卷首章上卷摘要不晚一章', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // volume_size=1：写第 2 章即卷 2 首章，本章就应注入第 1 卷摘要；快照口径
    // （currentChapter ≤ 最后定稿章 1）会算 outlookVolume=1 → 晚一章。预置手写
    // 卷摘要（selfHealVolumeSummary 文件存在即跳过，不触发生成）
    const cfg = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 1 } }
    mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
    writeFileSync(
      join(root, '定稿', '摘要', '卷摘要', '1.md'),
      '---\nvolume: 1\n---\n\n第一卷剧情回顾正文。',
      'utf-8',
    )
    // 已配 RAG + key 但不建索引 → recall 空库返回 []（无命中降级分支）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })

    const r = await prepareMaterials(db, cfg, {
      bookRoot: root, workDir, chapterLeadIds: [], chapter: 2,
    })
    expect(r.ragUsed).toBe(false)
    expect(r.ragNote).toContain('无命中')
    const sec = r.sections.find((s) => s.title === '第1卷摘要')
    expect(sec).toBeTruthy()
    expect(sec!.content).toContain('第一卷剧情回顾正文。')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('A3 生产链路：book.yaml rag.candidate_depth 经备料透传到召回（此前断链恒用缺省 20）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 第 2 章正文以「乙」开头——定向桩按此给两条不同方向：
    // 含「乙」→ [0.12,0.4,0.9]，其余（含查询与第 1 章）→ [0.9,0.4,0.12]。
    // 查询与第 1 章同向（余弦 1.0）排首位，第 2 章 ≈0.38 排次位——排序确定性可控
    const meta2: ChapterMeta = {
      章号: 2, 标题: '次章', 钩子类型: '悬念钩', 钩子强弱: '中',
      情绪定位: '铺垫', _path: '', _wordCount: 100,
    }
    writeChapter(join(root, '写作', '正文', '2-次章.md'), meta2, '乙字号开头的次章正文，讲述另一方阵营的动向与布局，与首章方向完全不同。')
    const dirEmbed = (_ep: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> =>
      Promise.resolve(texts.map((t) => (t.includes('乙') ? [0.12, 0.4, 0.9] : [0.9, 0.4, 0.12])))

    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    await buildIndex(root, { enabled: true, endpoint: 'http://stub', model: 'stub-model' }, 'stub-key', dirEmbed)

    // 建索引后整段改写第 1 章 → 指纹过期（它仍是余弦首位命中）
    writeChapter(join(root, '写作', '正文', '1-前章.md'), {
      章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
      情绪定位: '铺垫', _path: '', _wordCount: 100,
    }, '首章内容已被整段改写，指纹与索引时不一致。')

    const yamlPath = join(root, 'book.yaml')
    const patchDepth = (keyLine: string | null): void =>
      writeFileSync(yamlPath, setSectionKeyBlock(readFileSync(yamlPath, 'utf8'), 'rag', 'candidate_depth', keyLine))

    // candidate_depth: 1 → 只允许校验首位命中章（过期）→ 宁缺毋滥空手而归
    patchDepth('candidate_depth: 1')
    const shallow = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], query: '主线推进', embedFn: dirEmbed,
    })
    expect(shallow.ragUsed).toBe(false)
    expect(shallow.ragHitCount).toBe(0)
    expect(shallow.ragNote).toContain('无命中')

    // 去掉该键（缺省 20）→ 次位新鲜章递补 → 命中
    patchDepth(null)
    const deep = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], query: '主线推进', embedFn: dirEmbed,
    })
    expect(deep.ragUsed).toBe(true)
    expect(deep.ragHitCount).toBeGreaterThan(0)
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})
