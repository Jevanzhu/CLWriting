/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：maxWrittenChapterOf 并入感知
 * （设计 §5.4 检查器改口——二轮评审 P2「缓存重建假红」回归）。
 *
 * 场景：合并最高定稿章后（源章摘除 + 目标章 fm 并入 登记 + manifest 源条目随软删
 * 移除），预扫扫不出源章号 → 既有履历行「第N章」若按旧基准被判 lead-chapter-future
 * 假红卡定稿。修复：future 基准 = max(现值, 并入 在档最大源章号)。
 * 引文命中同步覆盖：履历按源章号的证据经 chapter-lookup 回退在目标章正文命中。
 * .cache 删损重建形态同覆盖（删 index.db 强制 rebuild——rebuild 后 chapters 表已无
 * 被并章，基准仍由并入感知保住）。
 */
import { describe, it, expect } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBookWithChapters } from '../helpers/book.js'
import { readManifest, writeManifest } from '../../src/document/manifest.js'
import { runCheckForDocument } from '../../src/check/run.js'
import type { CheckReport } from '../../src/check/types.js'

/** 收集全报告 checkId */
const allCheckIds = (report: CheckReport): string[] => report.sections.flatMap((s) => s.items.map((i) => i.checkId))

describe('S2 maxWrittenChapterOf 并入感知（缓存重建假红回归）', () => {
  it('合并最高定稿章后：lead-chapter-future 零假红 + 源章号引文经回退命中', () => {
    const root = makeGitBookWithChapters(3)
    const ch1 = join(root, '写作', '正文', '0001-第1章.md')
    const ch2 = join(root, '写作', '正文', '0002-第2章.md')
    const ch3 = join(root, '写作', '正文', '0003-第3章.md')

    // 第 1 章正文补 001 履历证据「焦痕」（夹具默认正文不含，避免混入无关 miss）
    writeFileSync(
      ch1,
      '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第1章的正文内容。门框上有焦痕。\n',
    )

    // 改写 ch3 正文（带可核验证据句），模拟定稿后合并 3 → 2：
    writeFileSync(
      ch3,
      '---\n章号: 3\n标题: 第3章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n雪夜里的焦痕还没有散尽。\n',
    )
    // ① 目标章写入：fm 增 并入 + 拼接正文（svc.save origin 'external-merge' 的批 B 形态，
    //    本测试手工构造同形终态——读取层回归只依赖盘面形态）
    const ch2Raw = readFileSync(ch2, 'utf-8')
    const ch2Body = ch2Raw.split('---\n')[2] ?? '\n第2章的正文内容。\n'
    writeFileSync(
      ch2,
      `---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n并入: 3\n---\n\n${ch2Body.trim()}\n\n雪夜里的焦痕还没有散尽。\n`,
    )
    // ② 源章软删（文件摘除 + manifest 条目移除）
    rmSync(ch3)
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    for (const [id, e] of m.entries) {
      if (e.path === '写作/正文/0003-第3章.md') m.entries.delete(id)
    }
    writeManifest(manifestPath, m)
    // ③ .cache 删损重建形态：删缓存库强制 rebuild（rebuild 后 chapters 表已无被并章）
    rmSync(join(root, '.cache', 'index.db'), { force: true })

    // 履历行引用第 3 章（证据在并入后的目标章正文里）
    const lead = join(root, '布线', '悬念', '悬念-031-灭门真凶.md')
    writeFileSync(
      lead,
      '---\n编号: 悬念-031\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n- 第003章 推进：雪夜里的焦痕\n',
    )

    const outcome = runCheckForDocument(root, ch2)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const ids = allCheckIds(outcome.report)
    // 并入感知：future 基准保住第 3 章——零假红
    expect(ids).not.toContain('lead-chapter-future')
    // 引文命中：第 3 章证据经 chapter-lookup 回退在目标章正文命中——零 unverifiable/miss
    expect(ids).not.toContain('lead-evidence-unverifiable')
    expect(ids).not.toContain('lead-evidence-miss')
  })

  it('对照：无 并入 登记时同盘面（源章单纯被删）仍产 lead-chapter-future——感知面不越界', () => {
    const root = makeGitBookWithChapters(3)
    const ch1 = join(root, '写作', '正文', '0001-第1章.md')
    const ch2 = join(root, '写作', '正文', '0002-第2章.md')
    const ch3 = join(root, '写作', '正文', '0003-第3章.md')

    // 第 1 章正文补 001 履历证据（同上，隔离无关 miss）
    writeFileSync(
      ch1,
      '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第1章的正文内容。门框上有焦痕。\n',
    )

    // 源章被删但目标章无 并入 登记（非合并形态：单纯丢章）
    rmSync(ch3)
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    for (const [id, e] of m.entries) {
      if (e.path === '写作/正文/0003-第3章.md') m.entries.delete(id)
    }
    writeManifest(manifestPath, m)
    rmSync(join(root, '.cache', 'index.db'), { force: true })

    const lead = join(root, '布线', '悬念', '悬念-031-灭门真凶.md')
    writeFileSync(
      lead,
      '---\n编号: 悬念-031\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n- 第003章 推进：焦痕\n',
    )

    const outcome = runCheckForDocument(root, ch2)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 无并入登记 → 基准回落定稿最大章 2 → 第 3 章履历行照常产红（感知只对真实并入生效）
    expect(allCheckIds(outcome.report)).toContain('lead-chapter-future')
  })
})
