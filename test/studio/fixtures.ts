/**
 * 双轨测试 fixture 生成（#13.1）：造工作目录 + 长篇书 + 短篇书（小型书仓库）。
 *
 * 供 dual-track 回归测 + e2e 复用（mkdtemp 临时目录，内容在代码里，灵活可控）。
 * 内容是测试小说数据（无敏感；不涉 api_key）。覆盖各 API 端点所需结构：
 * - 长篇：book.yaml + 大纲/总纲 + 大纲/伏笔 + 定稿/正文(2章) + 设定(角色/境界) + 文风铁律
 * - 短篇：book.yaml + 篇(2篇 正文+清单) + 设定/集子定位 + 文风铁律
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const LONG_BOOK = '长篇测试书'
export const SHORT_BOOK = '短篇测试集'

/** 造工作目录（含 .clwriting/books.jsonl）+ 长篇书 + 短篇书，返 workDir 路径 */
export function makeDualTrackWorkdir(): string {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-dual-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [
      JSON.stringify({ name: LONG_BOOK, path: LONG_BOOK, kind: 'long' }),
      JSON.stringify({ name: SHORT_BOOK, path: SHORT_BOOK, kind: 'short' }),
    ].join('\n') + '\n',
  )
  makeLongBook(join(workDir, LONG_BOOK))
  makeShortBook(join(workDir, SHORT_BOOK))
  return workDir
}

function makeLongBook(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 长篇测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: [成长线]\nbudget:\n  calls_per_chapter: 8\nstyle:\n  injection: light\nauto:\n  confirm_outline: false\n  batch_size: 1\ngrowth: {}\n',
  )
  mkdirSync(join(root, '大纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲\n玄幻：少年林远修真，玉佩藏着旧案。')
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-001-玉佩.md'),
    '---\n编号: 伏笔-001\n标题: 玉佩\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n## 履历\n- 第1章 埋下：主角发现玉佩发光\n',
  )
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  writeFileSync(
    join(root, '定稿', '正文', '0001-初入宗门.md'),
    '---\n章号: 1\n标题: 初入宗门\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 对话\n---\n林远踏入宗门，玉佩微微发光。\n\n"你是新弟子？"长老问道。\n\n林远点头，心中疑惑玉佩的来历。',
  )
  writeFileSync(
    join(root, '定稿', '正文', '0002-玉佩之秘.md'),
    '---\n章号: 2\n标题: 玉佩之秘\n钩子类型: 危机钩\n钩子强弱: 强\n情绪定位: 小爽\n场景: 战斗\n---\n玉佩突然爆发灵光，击退来袭的妖兽。\n\n林远震惊，这玉佩竟有如此力量。',
  )
  mkdirSync(join(root, '定稿', '设定', '角色'), { recursive: true })
  writeFileSync(
    join(root, '定稿', '设定', '角色', '林远.md'),
    '---\n姓名: 林远\n身份: 新弟子\n目标: 查清玉佩来历\n境界: 练气\n关系: 赵长老(师徒)\n---\n性格沉稳，天赋异禀。',
  )
  writeFileSync(
    join(root, '定稿', '设定', '境界体系.md'),
    '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基, 金丹, 元婴]\n---\n修真境界说明。',
  )
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n- 正文纯文本\n- 对话标签占比 < 30%\n')
}

function makeShortBook(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: short\nbook:\n  title: 短篇测试集\n  genre: 悬疑\nhost: cc\nbudget:\n  calls_per_chapter: 8\nstyle:\n  injection: light\nshort:\n  word_min: 1000\n  word_max: 5000\n',
  )
  const p1 = join(root, '篇', '001-雨夜门铃')
  mkdirSync(p1, { recursive: true })
  writeFileSync(
    join(p1, '正文.md'),
    '---\n篇号: 1\n标题: 雨夜门铃\n目标情绪: 惊悚\n核心反转: 来客是三年前的死者\n---\n## 开头钩子\n\n门外没有脚印。\n\n## 反转\n\n来客笑了，他是死者。',
  )
  writeFileSync(
    join(p1, '清单.md'),
    '## 反转线索表\n- 核心反转：来客是三年前的死者\n- 铺垫点（≥3，反转可回溯）：\n  - [开头钩子] 门外没有脚印\n  - [铺垫] 旧收音机\n\n## 情绪曲线\n- [开头钩子] 惊悚 4/10\n- [反转] 后怕 9/10\n\n## 伏笔回收\n- 门外没有脚印 → 回收于 反转\n',
  )
  const p2 = join(root, '篇', '002-红伞')
  mkdirSync(p2, { recursive: true })
  writeFileSync(
    join(p2, '正文.md'),
    '---\n篇号: 2\n标题: 红伞\n目标情绪: 后怕\n核心反转: 红伞内侧写着主角名字\n---\n## 开头\n\n红伞靠在墙边滴水。\n\n## 反转\n\n伞内侧写着主角的名字。',
  )
  writeFileSync(
    join(p2, '清单.md'),
    '## 反转线索表\n- 核心反转：红伞内侧写着主角名字\n- 铺垫点（≥3，反转可回溯）：\n  - [开头] 红伞滴水\n\n## 情绪曲线\n- [开头] 不安 5/10\n- [反转] 后怕 8/10\n\n## 伏笔回收\n- 红伞 → 回收于 反转\n',
  )
  mkdirSync(join(root, '定稿', '设定'), { recursive: true })
  writeFileSync(join(root, '定稿', '设定', '集子定位.md'), '# 集子定位\n悬疑短篇集，母题：七号公寓。')
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n- 短篇正文纯文本\n')
}
