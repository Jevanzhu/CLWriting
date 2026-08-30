/**
 * R30-29（三十轮）回归：harvest-corpus 章级解析失败不再静默。
 *
 * 此前 `const { chapters } = readChapterDir(...)` 把 errors 解构丢弃——坏章被静默
 * 跳过，系统性故障以「候选 0 条」成功口径收场。修复后：
 * - 结果统计带 `章级解析失败 N 章` 计数（N>0 才追加，0 失败输出逐位不变）；
 * - 末尾 console.warn 汇总（书名/章名/原因），快照级失败仍走 R63-14 的 error 口径。
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
    // 章级失败是软失败（warn + 计数留痕），不改变成功路径退出语义（区别于 R63-14 快照硬失败）
    expect(r.status).toBe(0)
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
