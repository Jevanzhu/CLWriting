/**
 * R30-29（三十轮）回归：harvest-corpus 章级解析失败不再静默。
 *
 * 此前 `const { chapters } = readChapterDir(...)` 把 errors 解构丢弃——坏章被静默
 * 跳过，系统性故障以「候选 0 条」成功口径收场。修复后：
 * - 结果统计带 `章级解析失败 N 章` 计数（N>0 才追加，0 失败输出逐位不变）；
 * - 末尾 console.warn 汇总（书名/章名/原因），快照级失败仍走 R63-14 的 error 口径。
 * R34D-31（三十四轮）：章级失败再补退出码哨兵（exitCode=1）——与快照失败路径
 * 口径统一，收割部分失败不再以退出码 0 收场（此前 R30-29 修一半：只 warn 不标红）。
 * 手法：verify-responses-relay 单测先例——spawnSync 单次 tsx 冷启动 + 固定书名
 * fixture（好章 + 缺章号的坏章），多断言合并进一个用例（R62-61）。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'

const script = fileURLToPath(new URL('../../scripts/harvest-corpus.ts', import.meta.url))
const repoRoot = join(fileURLToPath(new URL('../../', import.meta.url)))

test('R30-29: 章级解析失败 → 统计带 failedChapters 计数 + warn 汇总（书名/章名/原因）——单次 spawn 多断言', () => {
  // 固定书名子目录（warn 断言「书：<书名>」需要确定性；外层 tmp 目录名是随机的）
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '青萍集')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 青萍集', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  writeFileSync(join(root, '写作', '正文', '0001-好章.md'), '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。', 'utf-8')
  // 坏章：有 front matter 但缺必填「章号」→ readChapterDir 收进 errors（原因可断言）
  writeFileSync(join(root, '写作', '正文', '0002-坏章.md'), '---\n标题: 坏章\n---\n正文。', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-好章.md', parentId: null }),
      JSON.stringify({ id: 'chap-2', nodeType: 'document', path: '写作/正文/0002-坏章.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    // R34D-31（三十四轮）：章级失败退出码哨兵与快照失败路径（R63-14）口径统一——
    // 收割部分失败不再绿（候选集不完整须让脚本出口的调用方以退出码感知）
    expect(r.status).toBe(1)
    // 结果统计带 failedChapters 计数
    expect(r.stdout).toContain('章级解析失败 1 章')
    // warn 汇总：书名 + 章名 + 原因（console.warn 走 stderr）
    expect(r.stderr).toContain('[harvest-corpus] 警告：1 个章节解析失败被跳过（书：青萍集）')
    expect(r.stderr).toContain('0002-坏章.md')
    expect(r.stderr).toContain('缺少必填字段：章号')
    // 快照级口径未被波及（无版本快照 → 无 R63-14 硬告警）
    expect(r.stderr).not.toContain('版本快照判定失败')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)

// R34D-31（三十四轮）对照臂：零章级失败的干净书 → 退出码 0 照旧——哨兵只对
//「收割不完整」标红，不误伤全绿路径（失败注入与干净路径两臂同文件锚定）
test('R34D-31: 干净书（零章级失败、零快照失败）→ 退出码 0 照旧', () => {
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '青萍集净')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 青萍集净', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  writeFileSync(join(root, '写作', '正文', '0001-好章.md'), '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-好章.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('章快照判定完成')
    expect(r.stderr).not.toContain('章节解析失败')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)

// 重评-26（全库代码重评审 2026-09-05）回归：bookRoot 目录校验——此前入参只验
// existsSync 不验目录，误传文件路径时校验放行，readBookConfig 以文件为根拼路径
// 裸栈 ENOENT 崩穿。修复后 statSync + isDirectory 校验先拦：人话报错 + exit 1
//（fail-closed，口径同 corpus-commit.ts / check-knowledge.ts 的显式报错出口）。
// 手法沿用本文件既有 spawnSync 单次 tsx 冷启动形态（R62-61 多断言合并）。
test('重评-26: bookRoot 误传文件路径 → 目录校验人话报错 + exit 1（不再裸栈 ENOENT）', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'harvest-corpus-'))
  const filePath = join(dir, '不是目录.md')
  writeFileSync(filePath, '占位', 'utf-8')
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, filePath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(r.status).toBe(1)
    // 人话报错：点名入参不是目录 + 给出用法（走 console.error → stderr）
    expect(r.stderr).toContain('不是存在的目录')
    expect(r.stderr).toContain('用法：npx tsx scripts/harvest-corpus.ts <bookRoot>')
    // 校验先拦：不再以 readBookConfig 的裸栈 ENOENT 崩穿
    expect(r.stderr).not.toContain('ENOENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

// 重评2-P3-5（2026-09-09 全量重评 GLM-5.3，scripts 域 P3-③）回归：现行基准正文兜底读
// （原 :169 readFileSync(ch._path)）位于「只有 finally 无 catch」的外层 try 内——章文件
// 在 readChapterDir 列目与该读之间被并发移走（TOCTOU）时 ENOENT 裸栈崩穿整次收割。
// 修复后对齐 R63-14「计数 + 首错 + 人话告警」口径：本章跳过继续收割、产出段照常
// 落盘、exitCode=1（部分失败不静默成功）。
// 注入手法：NODE_OPTIONS --require 钩子包装 fs.readFileSync，对章文件第 2 次读取注入
// ENOENT——第 1 次是 readChapterDir 列目（须成功），第 2 次即基准正文兜底读，确定性
// 命中修复点（手工实跑已核：该章文件恰有两次 readFileSync）。
test('重评2-P3-5: 章文件 TOCTOU 读失败 → R63-14 口径告警 + exit 1 + 产出不中断（不再裸栈崩穿）', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'harvest-corpus-'))
  const root = join(dir, '青萍集移章')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 青萍集移章', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  const chapterPath = join(root, '写作', '正文', '0001-好章.md')
  writeFileSync(chapterPath, '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-好章.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  // 注入钩子（cjs，--require 在被测脚本加载前安装）：对目标章文件第 2 次读取抛 ENOENT
  const hookPath = join(dir, 're2-toctou-hook.cjs')
  writeFileSync(
    hookPath,
    [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      'const orig = fs.readFileSync',
      'const seen = new Map()',
      'fs.readFileSync = function (p, ...args) {',
      '  const s = String(p)',
      '  if (path.basename(s) === "0001-好章.md") {',
      '    const n = (seen.get(s) || 0) + 1',
      '    seen.set(s, n)',
      '    if (n >= 2) {',
      '      const e = new Error(`ENOENT: no such file or directory, open "${s}"`)',
      "      e.code = 'ENOENT'",
      '      e.errno = -2',
      "      e.syscall = 'open'",
      '      e.path = s',
      '      throw e',
      '    }',
      '  }',
      '  return orig.call(this, p, ...args)',
      '}',
    ].join('\n'),
    'utf-8',
  )
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${hookPath}`].filter(Boolean).join(' ')
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    })
    // R63-14 退出码口径保持：部分失败 exitCode=1
    expect(r.status).toBe(1)
    // 人话告警（计数面已扩为「快照/基准正文」）+ 首错留痕
    expect(r.stderr).toContain('警告：1 个版本快照/基准正文判定失败被跳过')
    expect(r.stderr).toContain('ENOENT')
    // 「跳过不中断」：主流程走到产出段（裸栈崩穿时该行不可能出现）
    expect(r.stdout).toContain('章快照判定完成')
    // 首错含堆栈属 R63-14 有意留痕（message\nstack），不能作未崩判据——
    // 未崩信号 = 上面的「完成行照出 + 告警格式口径 + exit 1」三件套
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

// R0912-3（2026-09-12 全量重评 #42）回归：清单缺失早退原先在 try 内 process.exit(1)
// 硬退、绕过 finally{db?.close()}（R71-34「db 由 finally 统一收口」不变量该路径不成立；
// 进程即退无实害仍按纪律修）。修后「置旗标 → break 出 try（finally 照跑）→ 收口后再
// exit(1)」：退出码与「不进产出段」（不覆盖写候选文件）语义均不变。
test('R0912-3: 文档清单缺失 → 人话报错 + exit 1 + 不产出候选文件（早退改走 finally 收口）', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'harvest-corpus-'))
  const root = join(dir, '青萍集无清单')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 青萍集无清单', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  writeFileSync(join(root, '写作', '正文', '0001-好章.md'), '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。', 'utf-8')
  // 故意不写 项目/文档清单.jsonl——早退点在 rebuild/开库之后、产出段之前
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('文档清单缺失')
    expect(r.stderr).toContain('请先在应用中打开一次本书生成清单后重试')
    // 「不进产出段」语义保持：空候选不得覆盖写既有候选清单
    expect(existsSync(join(root, '工作区', '语料候选', '误报候选.md'))).toBe(false)
    // 未走兜底读/快照面（清单缺失在收割前早退）
    expect(r.stderr).not.toContain('版本快照判定失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

// ── R51-J-1（五十一轮，并入档）：关键词提取与机检 message 模板口径对齐 ──────────
// 修复前（quotedOf 只认「」引号与 `词×N` 两形态）三类采集失真：
// - style-sentence-overlong / style-parallel-streak 引号内是「截断前缀+省略号」
//   （`「他沿着城墙走了很久也没有走到…」`）——省略号字面量在正文永不出现，
//   finalBody.includes 恒 false → 恒判「被改掉」，作者没改的样本全进错桶；
// - simile-density 的「像…」是模板字面量（message 只报次数不带命中文本）→ 同上；
// - repeat 类统计消息无任何锚点 → 静默零候选（无从归因）。
// 修复后：截断前缀剥省略号作锚、simile 用引擎同款 SIMILE_RE 直扫正文取真实短语
// （按短语逐个判幸存/改掉）、无锚命中按 checkId 人话告警（不设退出码——无锚项
// 本就不参与幸存者判定，与 R63-14/R34D-31「收割不完整」失败哨兵不同级）。
// 版本快照手工落 工作区/.版本/<docId>/<ULID>.md（fm 来源: ai），无 pinned
// finalize → 幸存者基准退化为现行正文文件（harvest 原口径）。去重 0 条。

/** 幸存者基准（现行正文，无 pinned finalize 时 harvest 退化用它）：
 *  保留 16 字超长句原句（> 铁律单句上限 12）、四连「雪落」句首排比（> 排比连续数 2）
 *  与一枚比喻短语——修复后三者的锚都应判「幸存（误报候选）」。 */
const KEYWORD_FINAL_BODY = [
  '他沿着城墙走了很久也没有走到尽头。',
  '雪落在肩上。雪落在瓦上。雪落在旗上。雪落在剑上。',
  '灯灭了，他握紧手里那封信，纸像蝉翼一样薄。',
].join('')

/** 被检版本快照：基准全文 + 11 枚额外比喻（基准 1 枚共 12 > 阈值 10，点火
 *  simile-density）+ 三连重复句（8-gram 绝对重复量超阈，点火 repeat）。 */
const KEYWORD_VERSION_BODY =
  KEYWORD_FINAL_BODY +
  [
    '山像屏风一样立着。云像棉絮一样铺开。风像刀子一样刮过。火像豆子一样亮着。',
    '路像肠子一样绕着。塔像楔子一样钉着。船像叶一样漂着。桥像弓一样弯着。',
    '月像钩一样挂着。星像盐一样撒着。井像眼一样睁着。',
  ].join('') +
  '他大步流星地走了过去。'.repeat(15)

function makeKeywordBook(): string {
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '雪泥集')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  mkdirSync(join(root, '工作区', '.版本', 'chap-1'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 雪泥集', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  // 铁律阈值：点火 style-sentence-overlong（12）与 style-parallel-streak（2）
  writeFileSync(
    join(root, '文风', '文风铁律.md'),
    ['# 文风铁律', '', '单句上限字数: 12', '排比连续数: 2', ''].join('\n'),
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0001-雪夜.md'),
    `---\n章号: 1\n标题: 雪夜\n---\n${KEYWORD_FINAL_BODY}`,
    'utf-8',
  )
  // 版本快照（origin ai，非 pinned）——被检对象
  writeFileSync(
    join(root, '工作区', '.版本', 'chap-1', '01ARZ3NDEKTSV4RRFFQ69G5FAV.md'),
    `---\n来源: ai\n字数: 900\n---\n${KEYWORD_VERSION_BODY}`,
    'utf-8',
  )
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-雪夜.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  return root
}

test('R51-J-1: 截断前缀/比喻短语按真实幸存判定 + repeat 无锚命中告警——单次 spawn 多断言', () => {
  const root = makeKeywordBook()
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    // 无锚命中只告警不设退出码（退出码哨兵只属 R63-14/R34D-31 的收割失败路径）
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('章快照判定完成')

    const falsePositive = readFileSync(join(root, '工作区', '语料候选', '误报候选.md'), 'utf-8')
    const hit = readFileSync(join(root, '工作区', '语料候选', '命中候选.md'), 'utf-8')

    // 修复前恒判「被改掉」的两类截断前缀锚——剥省略号后按前缀真实幸存 → 误报候选
    expect(falsePositive).toContain('checkId: style-sentence-overlong')
    expect(falsePositive).toContain('checkId: style-parallel-streak')

    // simile 改按 SIMILE_RE 真实短语逐个判定：幸存短语进误报候选、被改短语进命中候选
    //（摘录含前后 50 字上下文窗口，跨短语字样出现属正常，故不做跨桶 not 断言）
    expect(falsePositive).toContain('checkId: simile-density')
    expect(falsePositive).toContain('像蝉翼一样')
    expect(hit).toContain('像屏风一样')

    // repeat 统计消息无锚 → 不再静默零候选，按 checkId 人话告警（stderr）
    expect(r.stderr).toContain('提取不到关键词锚点')
    expect(r.stderr).toContain('repeat×1')
    expect(r.stderr).not.toContain('版本快照判定失败')
    expect(r.stderr).not.toContain('章节解析失败')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)

// 对照臂：无版本快照的干净书 → 零命中零告警，退出码 0 照旧（告警只随真实命中出现）
test('R51-J-1: 干净书零命中 → 无锚点告警不出现', () => {
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '净本')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 净本', '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n雪落在了城墙上。', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('提取不到关键词锚点')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)
