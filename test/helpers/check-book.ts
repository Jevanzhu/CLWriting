/**
 * check 域（tree-issues 族）书夹具单源。
 *
 * 收编 tree-issues-async-parity / tree-issues-cache / tree-issues-epoch-fingerprint /
 * tree-issues-scan-count / rebuild-worker-effect 五档此前各自持有的逐字复制 makeBook：
 * 五份差异只在 mkdtemp 前缀与三个开关（禁词命中 / 布线 / 章纲），骨架逐字节相同。
 *
 * 不变量（调用方断言依赖，勿改）：
 * - 每章正文含硬禁词「玉佩」→ issues 必非空，证逐章 checkWithDb 真的跑了；
 * - manifest 只登记 id/nodeType/path/parentId，不落 finalizedRevision（未定稿口径）；
 * - 缓存目录不预建——rebuild 由被测实现自理（口径同 helpers/book.ts 的 makeGitBook）。
 *
 * 前缀由调用方传入：各档保留原专名前缀，失败现场仍可按档定位（不再各自复制骨架）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from './temp-dir.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

export interface CheckBookOptions {
  /** mkdtemp 前缀（原各档专名前缀原样传入） */
  prefix: string
  /** 正文落盘章数（1..chapterCount） */
  chapterCount: number
  /** 每章正文插「，玉佩，」制造硬禁词命中；false 插普通逗号（rebuild-worker-effect 的 banned 开关） */
  banned?: boolean
  /** false：布线/悬念 目录与悬念账本都不建（证接线缺失路径；scan-count 的 wiring 开关） */
  wiring?: boolean
  /** true：建 大纲/章纲 目录（章纲为纪元输入之一；rebuild-worker-effect 原盘面无此目录） */
  outlineDir?: boolean
  /** true：写 大纲/章纲/001-第1章.md（含字数目标，供 targetWords 接线断言） */
  outlineFile?: boolean
}

/**
 * 造一本带硬禁词红源的 N 章书（正文区 + manifest 登记），返回书根。
 * 默认形态 = 布线齐全 + 章纲目录 + 每章命中禁词；rebuild-worker-effect 形态传
 * `outlineDir: false`（无章纲目录）。
 */
export function makeCheckBook(opts: CheckBookOptions): string {
  const banned = opts.banned ?? true
  const wiring = opts.wiring ?? true
  const root = mkdtempTracked(join(tmpdir(), opts.prefix))

  if (wiring) mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  if (opts.outlineDir ?? true) mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })

  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  if (wiring) {
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
      '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
  }

  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= opts.chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    const sep = banned ? '，玉佩，' : '，'
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里${sep}连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  if (opts.outlineFile) {
    writeFileSync(
      join(root, '大纲', '章纲', '001-第1章.md'),
      '---\n章号: 1\n标题: 第1章\n字数目标: 50000\n---\n\n## 反转线索表\n- 核心反转：x\n',
      'utf-8',
    )
  }
  writeManifest(manifestPath, m)
  return root
}
