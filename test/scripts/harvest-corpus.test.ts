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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 青萍集', '  genre: 玄幻'].join('\n'), 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-好章.md'),
    '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。',
    'utf-8',
  )
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
  writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 青萍集净', '  genre: 玄幻'].join('\n'), 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-好章.md'),
    '---\n章号: 1\n标题: 好章\n---\n雪落在了城墙上。',
    'utf-8',
  )
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
  writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 青萍集移章', '  genre: 玄幻'].join('\n'), 'utf-8')
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
