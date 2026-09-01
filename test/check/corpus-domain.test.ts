/**
 * B1-B4（批 6）语料回归域测试：
 * - B1 误报端点：事件落库形状（checkId/chapter/excerpt 服务端切 ±50）、无命中 409、
 *   幂等（重复标记 append、查询侧最近一条口径）
 * - B4 信息差三级供给：显式入参 > book.yaml > 账本派生 > 空（未声明静默）
 * - B2 自举脚本（execSync 集成）：幸存者判定两路 + 候选 md 产出 + 误报率统计
 * - B2 corpus:commit：勾选行入库 round-trip（去重合并）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// R62-58：仓库根按 import.meta.url 解析（此前 execSync 用 cwd 相对脚本路径，非根目录跑即 ENOENT）
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { deriveLeakKeywords } from '../../src/check/leak-derive.js'
import { cutExcerpt } from '../../src/studio/server/api/check.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { writeVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const d = mkdtempTracked(join(tmpdir(), prefix))
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

    const server = await startServerSafe({ port: 0, workDir, userDataPath: ud })
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

  it('幸存者基准锚定 pinned finalize 版本——正文文件定稿后再改不改变判定', () => {    // 原实现拿现行正文文件当定稿基准：定稿后作者继续起草（命中词又被改掉）会把
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

// ── R63-13 / R63-11：corpus:commit 加固（拒绝路径穿越 + 存量坏档保护）──────────

describe('R63-13/R63-11：corpus:commit checkId 消毒与存量保护', () => {
  /** 造一本只含语料候选 md 的书（corpus:commit 只读 工作区/语料候选/*.md） */
  function makeCandidateBook(mdText: string): string {
    const root = tmpDir('clw-commit-hard-')
    mkdirSync(join(root, '工作区', '语料候选'), { recursive: true })
    writeFileSync(join(root, '工作区', '语料候选', '误报候选.md'), mdText)
    return root
  }

  function runCommit(root: string, outDir: string) {
    // R70-9 同款（J0 win 实测）：spawnSync('npx') 在 win 上只找 npx.exe（实为 npx.cmd）
    // → ENOENT；改 process.execPath 直跑 + tsx loader，跨平台一致
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'corpus-commit.ts'), root, outDir],
      { encoding: 'utf8' },
    )
  }

  it('R63-13：checkId 含 ../、/、\\ → 拒绝入库（不逃出 corpusDir），合法 checkId 照常入库', () => {
    const root = makeCandidateBook(
      [
        '### checkId: ../../evil',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："穿越正文"（注）',
        '',
        '### checkId: sub/dir-check',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："穿越正文"（注）',
        '',
        // R35-12：`a\b` 是本用例标题既有承诺——fixture 此前漏了反斜杠样本
        '### checkId: a\\b',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："穿越正文"（注）',
        '',
        '### checkId: body-parts',
        '- [x] 章号 2 ｜ 判定：幸存 ｜ 摘录："眼睛正文"（注）',
        '',
      ].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-hard-out-')
    const r = runCommit(root, outDir)
    expect(r.stderr).toContain('拒绝入库')
    expect(r.status).toBe(1) // 拒绝不静默——退出码标红
    // 合法 checkId 照常入库
    expect(existsSync(join(outDir, 'body-parts.json'))).toBe(true)
    // 穿越目标不落盘：outDir/../../evil.json 与 outDir 下的子目录形态都不存在
    expect(existsSync(join(outDir, '..', 'evil.json'))).toBe(false)
    expect(existsSync(join(outDir, 'sub'))).toBe(false)
    // 反斜杠形态零落盘：win 分隔符解释下的子目录与字面名都不存在（R35-12 前者漏网）
    expect(existsSync(join(outDir, 'a'))).toBe(false)
    expect(existsSync(join(outDir, 'a\\b.json'))).toBe(false)
  })

  it('R63-11：存量 .json 解析失败 → 跳过合并且原文件保持原样（不静默清空既有回归门）', () => {
    const root = makeCandidateBook(
      ['### checkId: body-parts', '- [x] 章号 2 ｜ 判定：幸存 ｜ 摘录："眼睛正文"（注）', ''].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-keep-out-')
    writeFileSync(join(outDir, 'body-parts.json'), 'NOT JSON {{{') // 手工弄坏的存量档
    const before = readFileSync(join(outDir, 'body-parts.json'), 'utf8')
    const r = runCommit(root, outDir)
    expect(r.stderr).toContain('存量语料解析失败')
    expect(r.status).toBe(1)
    // 原文件保持原样——不是按空数组整写覆盖（那会静默清掉既有条目）
    expect(readFileSync(join(outDir, 'body-parts.json'), 'utf8')).toBe(before)
  })

  // R34D-6（三十四轮）：空集路径退出码哨兵——勾选行全部摘录解析失败（droppedExcerpts>0、
  // all=[]）或全部落在被拒 checkId 节下时，原空列表分支无条件 exit(0) 短路尾部哨兵
  //（拒绝/丢条不静默），语料门入库端假成功。修复后空集路径同判哨兵条件：
  // 勾了但全军覆没 → exit 1（fail-closed）；真没勾 → exit 0 照旧。
  it('R34D-6：勾选行全部解析失败（all=[] 且 droppedExcerpts>0）→ exit 1，不误报「无勾选条目」', () => {
    // 摘录 JSON 坏形（\x 非法转义）：行匹配进解析但 JSON.parse 抛 → droppedExcerpts++
    const root = makeCandidateBook(
      ['### checkId: body-parts', '- [x] 章号 2 ｜ 判定：幸存 ｜ 摘录："眼睛\\x正文"（注）', ''].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-empty-poison-')
    const r = runCommit(root, outDir)
    expect(r.stderr).toContain('未被解析')
    expect(r.status).toBe(1) // 修复前：空集早退 exit(0) 短路尾部哨兵
    expect(r.stdout).not.toContain('无勾选条目') // 文案区分「真没勾」与「勾了但全解析失败」
    expect(r.stderr).toContain('0 条入库')
    expect(existsSync(join(outDir, 'body-parts.json'))).toBe(false) // 零入库
  })

  it('R34D-6：勾选行全部落在被拒 checkId 节下（all=[] 且 rejectedCheckIds>0）→ exit 1', () => {
    const root = makeCandidateBook(
      ['### checkId: ../../evil', '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："穿越正文"（注）', ''].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-empty-reject-')
    const r = runCommit(root, outDir)
    expect(r.stderr).toContain('拒绝入库')
    expect(r.status).toBe(1) // 修复前：空集早退 exit(0)——拒绝也不标红
    expect(existsSync(join(outDir, '..', 'evil.json'))).toBe(false)
  })

  it('R34D-6：真没勾（无 [x] 行、零告警计数）→ exit 0 照旧（空集哨兵不误伤干净路径）', () => {
    const root = makeCandidateBook(
      ['### checkId: body-parts', '- [ ] 章号 2 ｜ 判定：幸存 ｜ 摘录："眼睛正文"（注）', ''].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-empty-clean-')
    const r = runCommit(root, outDir)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('无勾选条目')
    expect(existsSync(join(outDir, 'body-parts.json'))).toBe(false)
  })

  // R35-12（三十五轮）：字符类转义错误使 `\` 实际漏拦（注释/报错文案/用例标题三方虚账，
  // 主评审 node 实验证实 `a\b` → reject false）——win 上 `a\b.json` 建子目录落盘而语料门
  // 非递归装载永远看不到；保留设备名整串判定可被 `sub\CON` 形态绕过
  it('R35-12：反斜杠与分量级保留设备名拒绝（a\\b、sub/CON、con），合法 id 口径不变', () => {
    const root = makeCandidateBook(
      [
        '### checkId: a\\b',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："反斜杠正文"（注）',
        '',
        '### checkId: sub/CON',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："穿越正文"（注）',
        '',
        '### checkId: con',
        '- [x] 章号 1 ｜ 判定：幸存 ｜ 摘录："设备名正文"（注）',
        '',
        '### checkId: body-parts',
        '- [x] 章号 2 ｜ 判定：幸存 ｜ 摘录："眼睛正文"（注）',
        '',
      ].join('\n'),
    )
    const outDir = tmpDir('clw-corpus-r3512-')
    const r = runCommit(root, outDir)
    expect(r.stderr).toContain('拒绝入库')
    expect(r.status).toBe(1)
    // 反斜杠形态零落盘：字面名与（win 分隔符解释下的）子目录形态都不存在
    expect(existsSync(join(outDir, 'a\\b.json'))).toBe(false)
    expect(existsSync(join(outDir, 'a'))).toBe(false)
    expect(existsSync(join(outDir, 'CON.json'))).toBe(false)
    // 合法 checkId 不受误伤，照常入库
    expect(existsSync(join(outDir, 'body-parts.json'))).toBe(true)
  })
})

describe('R64-11（十二轮）：cutExcerpt 堆砌锚点汉字段收编 HANZI 单源（基本区+扩展 A）', () => {
  it('扩展 A 区字（㐀=U+3400）锚点 ×N 定位命中（旧硬编码 \\u4e00-\\u9fff 漏判 → 回落开头）', () => {
    const body = '前'.repeat(120) + '㐀' + '后'.repeat(120)
    const out = cutExcerpt(body, ['㐀×6'])
    expect(out).toContain('㐀')
    expect(out.indexOf('㐀')).toBe(50) // ±50 窗口正中（锚定），而非回落正文开头
  })
  it('基本区锚点行为不变：眼睛×6 定位正文中的「眼睛」', () => {
    const body = '前'.repeat(120) + '眼睛' + '后'.repeat(120)
    const out = cutExcerpt(body, ['眼睛×6'])
    expect(out.indexOf('眼睛')).toBe(50)
  })
})
