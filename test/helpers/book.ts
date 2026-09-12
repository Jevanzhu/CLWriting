/**
 * 书仓库测试 fixture 工具 —— M3 7 态测试共用。
 *
 * 迁自 test/finalize/commit.test.ts 的 makeGitBook（git init + book.yaml + 目录 + 账本 + 初始 commit），
 * 扩展为可造「多章多 commit」书（回滚测试用）+ 各态 fixture 的造态钩子。
 *
 * 设计：每个 make* 返回书仓库根路径，调用方用完自行 rmSync 清理（与现有测试一致）。
 * 全程中文目录名（验证中文路径全链路，沿用 rebuild.test 约定）。
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempTracked } from './temp-dir.js'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

/** 跑一条 git 命令（fixture 用，stdio pipe 免污染测试输出） */
export function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git ${args.join(' ')} failed`)
  return r.stdout
}

/**
 * 造一个干净的书仓库（git init + book.yaml + 目录骨架 + 1 条账本 + 初始 commit）。
 * 缓存按「可重建派生」原则**不**预建——状态机/重建器自己 rebuild。
 * 这是所有 fixture 的基础形态（对应状态机态 7：一切干净 → 起草新章）。
 *
 * R74-25（批E）：临时根迁 mkdtempTracked——断言失败时尾行 rmSync 不可达由
 * afterEach 兜底收走（与尾行清理幂等共存）。注意：因此本函数**不得**在
 * beforeAll 里调用共享跨用例（afterEach 会删掉共享目录）——现有 6 个调用方
 * 均在 it() 体内调用，新增调用方须沿用此形态。
 */
export function makeGitBook(opts?: { withCache?: boolean }): string {
  const root = mkdtempTracked(join(tmpdir(), '北境往事-'))

  // git init + 身份（fixture 隔离，不污染全局 git config）
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)

  // book.yaml
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)

  // 目录骨架（母本第 5 节数据形态，v2：正文在 写作/正文，线索在 布线/）
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '布线', '感情线'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true }) // 缓存目录常建（测试可直接建 db）

  // 1 条账本（基础类，恒启用）
  writeFileSync(
    join(root, '布线', '悬念', '悬念-031-灭门真凶.md'),
    '---\n编号: 悬念-031\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
    'utf-8',
  )

  // 可选：预建缓存（某些测试需要缓存已存在再造态，如「.cache 与 md 不一致」）
  if (opts?.withCache) {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    createAllTables(db)
    syncLead(db, {
      编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 1,
      履历: [{ 章号: 1, 动词: '埋下', 证据: '焦痕' }],
      _path: join(root, '布线', '悬念', '悬念-031-灭门真凶.md'),
    })
    db.close()
  }

  // 初始 commit（git 干净基线）
  git(['add', '-A'], root)
  git(['commit', '-m', 'init'], root)

  return root
}

/**
 * 造一个写了 N 章并逐章定稿的书仓库（态 5 卷末 / 态 7 下一章测试用）。
 * 每章：正文（含 #7 front matter）+ 登记 manifest 定稿基线（去 git 后正文 = final）。
 * 保留 `ch:<补零章号>` commit msg（对齐 #16 第 4 节 commit msg 规范；git 侧仅作历史留痕）。
 *
 * @param n 已定稿的章数（1..n）
 * @returns 书仓库根；正文区有 n 章定稿 + n 个 ch: commit（commitEach=false 时为单个 ch: commit）
 */
export function makeGitBookWithChapters(n: number, opts?: { commitEach?: boolean }): string {
  const root = makeGitBook()
  const commitEach = opts?.commitEach ?? true

  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })

  for (let i = 1; i <= n; i++) {
    const chNo = String(i).padStart(4, '0')
    const title = `第${i}章`
    const rel = `写作/正文/${chNo}-${title}.md`
    // 正文（含 #7 front matter）
    const abs = join(root, rel)
    writeFileSync(
      abs,
      `---\n章号: ${i}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${i}章的正文内容。\n`,
      'utf-8',
    )
    // 定稿基线 = 当前指纹（去 git 后正文 = final，不误判态 4 草稿）
    const m = readManifest(manifestPath)
    upsertEntry(m, {
      id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
      finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
    })
    writeManifest(manifestPath, m)
    if (commitEach) {
      // commit（#16 第 4 节前缀 + 章号，回滚按 ch:<章号> 反查）
      git(['add', '-A'], root)
      git(['commit', '-m', `ch:${chNo} ${title}`], root)
    }
  }

  if (!commitEach && n > 0) {
    const chNo = String(n).padStart(4, '0')
    git(['add', '-A'], root)
    git(['commit', '-m', `ch:${chNo} 第${n}章`], root)
  }

  return root
}

/**
 * 测试精简批（2026-09-12，台账 L181/L209 预登记项「makeBook 族参数化」）：
 * 收编各域本地 makeBook 的公共骨架——mkdtemp（tracked，幂等于调用方尾行清理）+
 * 可选 .clwriting 目录 + book.yaml + 目录/文件清单。域特有播种（db 行/账本/manifest）
 * 留在调用方。
 *
 * 语义红线：替换本地 makeBook 前必须核对本工厂能逐字节复现原脚手架（name/prefix/
 * config/files 与原文件一致）；有出入就维持本地实现，不为行数改测试盘面。
 */
export interface ScaffoldBookOptions {
  /** 书目录名（默认 'mybook'；全中文书名等既有专名请原样传入） */
  name?: string
  /** root 即临时目录本身（无书名子层）——document 域「root 即临时目录」族形态；与 name 互斥 */
  flatRoot?: boolean
  /** mkdtemp 前缀（默认 'book-scaffold-'；原文件有专名前缀的保持原样） */
  prefix?: string
  /** book.yaml：true = writeBookConfig(DEFAULT_CONFIG)；字符串 = 逐字节原样写入；缺省不写 */
  config?: boolean | string
  /** 预建 workDir/.clwriting 目录（books.jsonl 登记面由 studio-server.ts 的 bootStudio 管） */
  registryDir?: boolean
  /** 相对书根的目录清单（recursive 创建；书根本身随首个目录/文件创建） */
  dirs?: string[]
  /** 相对书根的文件清单（content 逐字节写入；目录自动递归创建） */
  files?: Array<{ rel: string; content: string }>
}

/** 造书脚手架（无 git、无缓存播种——那些属域特有逻辑，见各调用方） */
export function scaffoldBook(opts: ScaffoldBookOptions = {}): { root: string; workDir: string } {
  if (opts.flatRoot && opts.name !== undefined) {
    throw new Error('scaffoldBook：flatRoot 与 name 互斥（root 即临时目录时不得再指定书名子层）')
  }
  const workDir = mkdtempTracked(join(tmpdir(), opts.prefix ?? 'book-scaffold-'))
  if (opts.registryDir) mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  const root = opts.flatRoot ? workDir : join(workDir, opts.name ?? 'mybook')
  for (const rel of opts.dirs ?? []) mkdirSync(join(root, rel), { recursive: true })
  if (opts.config !== undefined) mkdirSync(root, { recursive: true })
  for (const f of opts.files ?? []) {
    const abs = join(root, f.rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content, 'utf8')
  }
  if (opts.config === true) writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  else if (typeof opts.config === 'string') writeFileSync(join(root, 'book.yaml'), opts.config, 'utf8')
  return { root, workDir }
}

/**
 * 在已有书仓库里「写一章但不定稿」（造态 4「工作区未完成」的中断场景）。
 * 写正文区草稿（含 front matter，避免 rebuild 收 ParseError）+ 细纲 + .confirm.json，不 finalize —— 模拟写作中断。
 * 去 git 后草稿直接落正文区（无 manifest 基线 = 未定稿）。
 */
export function stageIncompleteChapter(root: string, chapterNum: number): void {
  const workDir = join(root, '工作区')
  const bodyDir = join(root, '写作', '正文')
  mkdirSync(bodyDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, `第${chapterNum}章细纲`, 'utf-8')
  writeFileSync(
    join(bodyDir, `000${chapterNum}-草稿.md`),
    `---\n章号: ${chapterNum}\n标题: 草稿\n---\n\n第${chapterNum}章草稿`,
    'utf-8',
  )
  // .confirm.json（机器域，模拟已确认细纲但未定稿）
  writeFileSync(
    join(workDir, '.confirm.json'),
    JSON.stringify({
      chapter: chapterNum,
      outline_hash: 'sha256:fixture',
      confirmed_at: '2026-06-17T10:00:00.000Z',
      mode: 'manual',
    }),
    'utf-8',
  )
}
