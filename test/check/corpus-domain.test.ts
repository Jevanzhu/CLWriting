/**
 * B1-B4（批 6）语料回归域测试：
 * - B1 误报端点：事件落库形状（checkId/chapter/excerpt 服务端切 ±50）、无命中 409、
 *   幂等（重复标记 append、查询侧最近一条口径）
 * - B4 信息差三级供给：显式入参 > book.yaml > 账本派生 > 空（未声明静默）
 * - B2 自举脚本（execSync 集成）：幸存者判定两路 + 候选 md 产出 + 误报率统计
 * - B2 corpus:commit：勾选行入库 round-trip（去重合并）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58：仓库根按 import.meta.url 解析（此前 execSync 用 cwd 相对脚本路径，非根目录跑即 ENOENT）
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { deriveLeakKeywords } from '../../src/check/leak-derive.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { writeVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** 造书：N 章正文 + 布线（含账本 leak_keywords 可选）+ 清单登记 */
function makeBook(chapters: number, opts: { wiring?: boolean; leakFm?: string } = {}): string {
  const root = tmpDir('clw-corpus-')
  if (opts.wiring) {
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-玉佩.md'),
      `---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n${opts.leakFm ?? ''}---\n\n## 履历\n`,
    )
  }
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 语料测试书\nhost: cc\nleads:\n  enabled: []\n')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapters; no++) {
    const pad = String(no).padStart(3, '0')
    const p = join(root, '写作', '正文', `${pad}-第${no}章.md`)
    writeFileSync(p, `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文。她的眼睛望着他，眼睛里映着火光，眼睛发烫，眼睛深处藏着话，那双眼睛像星火。\n`)
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  writeManifest(manifestPath, m)
  return root
}

function docIdOf(root: string, chapterFile: string): string {
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  for (const [id, e] of m.entries) {
    if (e.path === `写作/正文/${chapterFile}`) return id
  }
  throw new Error('docId not found')
}

// ── B4 信息差派生 ────────────────────────────────────────────────────

describe('B4 信息差词表派生（P6-①）', () => {
  it('账本 fm leak_keywords 两种形态（单行数组 / 逐行列表）都收集，去重', () => {
    const inline = makeBook(1, { wiring: true, leakFm: 'leak_keywords: [玉佩旧案, 血脉之秘]\n' })
    expect(deriveLeakKeywords(inline)).toEqual(['玉佩旧案', '血脉之秘'])
    const block = makeBook(1, {
      wiring: true,
      leakFm: 'leak_keywords:\n  - 玉佩旧案\n  - 血脉之秘\n  - 玉佩旧案\n',
    })
    expect(deriveLeakKeywords(block)).toEqual(['玉佩旧案', '血脉之秘'])
    // 未声明 → 空数组（X-P2-22 静默跳过语义）
    const none = makeBook(1, { wiring: true })
    expect(deriveLeakKeywords(none)).toEqual([])
    // 无布线书 → 空
    expect(deriveLeakKeywords(makeBook(1))).toEqual([])
  })

  // Q-14（第十五轮）：账本带 BOM/CRLF 毛边 → 仍收集（手写正则不处理 BOM 曾致
  // fm 整段丢失、info-leak 机检静默失效）
  it('Q-14: BOM + CRLF 账本 → leak_keywords 照常派生', () => {
    const root = tmpDir('clw-leak-bom-')
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-玉佩.md'),
      '\ufeff---\r\n编号: 悬念-001\r\nleak_keywords: [玉佩旧案, 血脉之秘]\r\n---\r\n\r\n## 履历\r\n',
    )
    expect(deriveLeakKeywords(root)).toEqual(['玉佩旧案', '血脉之秘'])
  })

  it('供给链三级回落：book.yaml checks.leak_keywords 未设时账本派生生效（经 runner 集成验证）', () => {
    // 供给链在 runner.ts：input > config > derive —— 单测层面验证派生函数 +
    // runAllChecks 集成在 harvest 端到端里覆盖；此处锚定派生输入形态
    const root = makeBook(1, { wiring: true, leakFm: 'leak_keywords: [眼睛]\n' })
    expect(deriveLeakKeywords(root)).toContain('眼睛')
  })

  it('单行数组引号内逗号不劈（K17 同构：["玉佩,旧案"] 是一个词）', () => {
    // 原实现 bare split(',') 会把引号项劈成「玉佩」「旧案」两个关键词
    const root = makeBook(1, { wiring: true, leakFm: 'leak_keywords: ["玉佩,旧案", 血脉之秘]\n' })
    expect(deriveLeakKeywords(root)).toEqual(['玉佩,旧案', '血脉之秘'])
  })
})

// ── B1 误报端点 ──────────────────────────────────────────────────────

describe('B1 误报标记端点', () => {
  it('POST check-false-positive：事件落库（服务端切 excerpt ±50）、无命中 409、重复幂等', async () => {
    const workDir = tmpDir('clw-fp-wd-')
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '语料测试书', path: '语料测试书', kind: 'long' }) + '\n')
    const bookRoot = makeBook(1)
    // workDir 下建同名书目录链接式布局：直接把书放进 workDir
    rmSync(join(workDir, '语料测试书'), { recursive: true, force: true })
    execSync(`cp -R "${bookRoot}" "${join(workDir, '语料测试书')}"`)
    const targetRoot = join(workDir, '语料测试书')
    const ud = tmpDir('clw-fp-ud-')

    const server = startServer({ port: 0, workDir, userDataPath: ud })
    await new Promise<void>((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const token = ((await (await fetch(`${base}/api/boot`)).json()) as { token: string }).token
    try {
      const docId = docIdOf(targetRoot, '001-第1章.md')
      // 正文章含「眼睛」×5（阈值 5，>5 才报）……上面 fixture 恰 5 次不报黄。用 imagery？
      // 构造必然命中：直接用复_read 检查器？稳妥：把正文加长到眼睛×6
      const chapterFile = join(targetRoot, '写作', '正文', '001-第1章.md')
      writeFileSync(
        chapterFile,
        '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n她的眼睛望着他，眼睛里映着火光，眼睛发烫，眼睛深处藏着话，那双眼睛像星火，眼睛之外再无他物。\n',
      )
      const post = (body: unknown): Promise<Response> =>
        fetch(`${base}/api/books/语料测试书/documents/${docId}/check-false-positive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-studio-token': token },
          body: JSON.stringify(body),
        })
      // body-parts（眼睛×6 > 阈值 5）应命中
      const r1 = await post({ checkId: 'body-parts' })
      expect(r1.status).toBe(200)
      const j1 = (await r1.json()) as { ok: boolean; chapter: number; excerpt: string }
      expect(j1.ok).toBe(true)
      expect(j1.chapter).toBe(1)
      // excerpt 服务端切：含命中词 + 上下文，≤200
      expect(j1.excerpt).toContain('眼睛')
      expect(j1.excerpt.length).toBeLessThanOrEqual(200)
      // 无命中的 checkId → 409
      const r2 = await post({ checkId: 'not-a-check' })
      expect(r2.status).toBe(409)
      // 重复标记 → 仍 200（append 事件，幂等由查询侧最近一条口径保证）
      const r3 = await post({ checkId: 'body-parts' })
      expect(r3.status).toBe(200)
      // 空 checkId → 400
      const r4 = await post({ checkId: '' })
      expect(r4.status).toBe(400)

      // 事件落库验证：workspace 会话，(chapter, checkId) 去重取最近
      const store = openSessionStore(ud, targetRoot)!
      try {
        const events = store.listEvents(bookHash(targetRoot)).filter((e) => e.type === 'check/false-positive')
        expect(events.length).toBe(2) // 标两次 append 两条
        const data = events.map((e) => e.data as { checkId: string; chapter: number; excerpt: string })
        expect(data.every((d) => d.checkId === 'body-parts' && d.chapter === 1)).toBe(true)
        expect(data.every((d) => d.excerpt.includes('眼睛'))).toBe(true)
      } finally {
        store.close()
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

// ── B2 自举脚本 + corpus:commit（execSync 集成）──────────────────────

describe('B2 自举脚本（幸存者判定）与 corpus:commit', () => {
  it('幸存（误报候选）/ 被改掉（命中候选）两路 + 误报率统计 + 勾选入库 round-trip', () => {
    const root = makeBook(2)
    const docId = docIdOf(root, '001-第1章.md')
    const versionsDir = join(root, '工作区', VERSIONS_DIR_NAME)
    // 版本 A（旧稿）：身体部位词堆砌（眼睛×6）
    writeVersion(versionsDir, docId, '她的眼睛望着他，眼睛里映着火光，眼睛发烫，眼睛深处藏着话，那双眼睛像星火，眼睛之外再无他物。\n', {
      origin: 'ai-draft',
      reason: '旧稿',
    })
    // 定稿正文把「眼睛」清理成 1 次 → 该命中「被改掉」⇒ 命中候选
    writeFileSync(
      join(root, '写作', '正文', '001-第1章.md'),
      '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n她望了他一眼，火光在眼底一闪而过。\n',
    )
    // 第二章：版本里与定稿都保留同样的眼睛堆砌 → 「幸存」⇒ 误报候选
    const docId2 = docIdOf(root, '002-第2章.md')
    const kept = '他的眼睛眯起来，眼睛里有雪，眼睛深处是火，眼睛不发一言，眼睛替他说了全部，眼睛之外空无一物。\n'
    writeVersion(versionsDir, docId2, kept, { origin: 'ai-draft', reason: '旧稿' })
    writeFileSync(
      join(root, '写作', '正文', '002-第2章.md'),
      `---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${kept}`,
    )

    execSync(`npx tsx "${join(REPO_ROOT, 'scripts', 'harvest-corpus.ts')}" "${root}"`, { stdio: 'pipe' })
    const fp = join(root, '工作区', '语料候选', '误报候选.md')
    const hit = join(root, '工作区', '语料候选', '命中候选.md')
    expect(existsSync(fp)).toBe(true)
    expect(existsSync(hit)).toBe(true)
    const fpText = readFileSync(fp, 'utf8')
    const hitText = readFileSync(hit, 'utf8')
    expect(fpText).toContain('checkId: body-parts')
    expect(fpText).toContain('章号 2')
    expect(fpText).toContain('判定：幸存')
    expect(hitText).toContain('checkId: body-parts')
    expect(hitText).toContain('章号 1')
    expect(hitText).toContain('判定：改掉')
    // 误报率统计产出
    expect(existsSync(join(root, '工作区', '语料候选', '误报率统计.md'))).toBe(true)

    // 勾选两行 → corpus:commit 入库（tmp 输出目录）
    const outDir = tmpDir('clw-corpus-out-')
    const fpChecked = fpText.replace(/- \[ \] 章号 2/g, '- [x] 章号 2')
    writeFileSync(fp, fpChecked)
    const hitChecked = hitText.replace(/- \[ \] 章号 1/g, '- [x] 章号 1')
    writeFileSync(hit, hitChecked)
    execSync(`npx tsx "${join(REPO_ROOT, 'scripts', 'corpus-commit.ts')}" "${root}" "${outDir}"`, { stdio: 'pipe' })
    const jsonPath = join(outDir, 'body-parts.json')
    expect(existsSync(jsonPath)).toBe(true)
    const entries = JSON.parse(readFileSync(jsonPath, 'utf8')) as Array<{ excerpt: string; expect: string }>
    expect(entries.some((e) => e.expect === 'silent' && e.excerpt.includes('眼睛'))).toBe(true)
    expect(entries.some((e) => e.expect === 'fire' && e.excerpt.includes('眼睛'))).toBe(true)
    // 重跑合并去重（不翻倍）
    execSync(`npx tsx "${join(REPO_ROOT, 'scripts', 'corpus-commit.ts')}" "${root}" "${outDir}"`, { stdio: 'pipe' })
    const entries2 = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown[]
    expect(entries2.length).toBe(entries.length)
  })

  it('幸存者基准锚定 pinned finalize 版本——正文文件定稿后再改不改变判定', () => {
    // 原实现拿现行正文文件当定稿基准：定稿后作者继续起草（命中词又被改掉）会把
    // 「定稿时幸存」误判成「被作者改掉」。基准应是最后一次定稿内容（pinned
    // finalize 版本），从未定稿才退化为现行文件。
    const root = makeBook(1)
    const docId = docIdOf(root, '001-第1章.md')
    const versionsDir = join(root, '工作区', VERSIONS_DIR_NAME)
    const piled = '她的眼睛望着他，眼睛里映着火光，眼睛发烫，眼睛深处藏着话，那双眼睛像星火，眼睛之外再无他物。\n'
    // 旧稿命中身体部位堆砌；定稿版本（pinned）保留堆砌 ⇒ 命中词在定稿幸存 ⇒ 误报候选
    writeVersion(versionsDir, docId, piled, { origin: 'ai-draft', reason: '旧稿' })
    writeVersion(versionsDir, docId, piled, { origin: 'finalize', pinned: true })
    // 定稿后作者又改了正文文件（清掉「眼睛」）——旧实现会据此误判「被改掉」
    writeFileSync(
      join(root, '写作', '正文', '001-第1章.md'),
      '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n她望了他一眼，火光在眼底一闪而过。\n',
    )
    execSync(`npx tsx "${join(REPO_ROOT, 'scripts', 'harvest-corpus.ts')}" "${root}"`, { stdio: 'pipe' })
    const fpText = readFileSync(join(root, '工作区', '语料候选', '误报候选.md'), 'utf8')
    expect(fpText).toContain('判定：幸存')
    const hitText = readFileSync(join(root, '工作区', '语料候选', '命中候选.md'), 'utf8')
    expect(hitText).not.toContain('章号 1')
  })
})
