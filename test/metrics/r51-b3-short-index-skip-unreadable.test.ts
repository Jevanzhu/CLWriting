/**
 * R51-B-3（五十一轮）回归：short-index 对不可读章跳章 + warn 留痕。
 *
 * `readChapterBody(ch) ?? ''` 此前对读失败章产 0 字假条目：短篇集章数/均字数/平台
 * 画像（wordMin-wordMax 达标面）与反转分被空正文拉偏且无迹可查。修复：对齐同源
 * 助手（style.ts scanChapters 读失败 continue 跳章）+ warn。
 *
 * 触发形态说明：fm 未闭合/无 fm 的坏文件在 readChapterDir 层就进 errors 不进
 * chapters（到不了本循环）——short-index 循环内 `readChapterBody → null` 的真实
 * 形态是 stat 指纹缓存判未变后的读失败/TOCTOU（readMdTextCached → null）。故以
 * spy 在缓存读入口注入 null 模拟，其余文件透传真读。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChapter } from '../helpers/chapter.js'
import { scanShortCollection } from '../../src/metrics/short-index.js'
import { log } from '../../src/log/index.js'
import * as mdCache from '../../src/fs/md-text-cache.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('R51-B-3: 不可读章跳章不产 0 字假条目 + warn 留痕；可读章照常入索引', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  const root = mkdtempTracked(join(tmpdir(), 'r51-b3-'))
  try {
    const bodyDir = join(root, '写作', '正文')
    mkdirFixtures(bodyDir)
    // TOCTOU/读失败注入：0002 缓存读入口返回 null（文件消失/读失败形态），0001 透传真读
    const actualRead = mdCache.readMdTextCached
    const readSpy = vi.spyOn(mdCache, 'readMdTextCached').mockImplementation(
      (fp: string) => (fp.endsWith('0002-坏章.md') ? null : actualRead(fp)),
    )
    try {
      const entries = scanShortCollection(root)
      // 跳章口径（同 style.ts scanChapters）：坏章不产 0 字假条目
      expect(entries.map((e) => e.num)).toEqual([1])
      expect(entries.every((e) => e.wordCount > 0)).toBe(true)
      // 修复点：warn 留痕点名文件
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('0002-坏章.md')
      expect(warned).toContain('不可读章')
    } finally {
      readSpy.mockRestore()
    }
  } finally {
    warnSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

function mkdirFixtures(bodyDir: string): void {
  mkdirSync(bodyDir, { recursive: true })
  writeChapter(join(bodyDir, '0001-好章.md'), {
    章号: 1, 标题: '好章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '压抑',
    目标情绪: '惊悚', 核心反转: '来客就是死者',
  }, '门外没有脚印。他退了半步。')
  // 坏章本身 fm 合法（否则 readChapterDir 层就剔除、到不了 short-index 循环）——
  // 不可读性由 spy 在读入口注入（见上）
  writeFileSync(join(bodyDir, '0002-坏章.md'), [
    '---',
    '章号: 2',
    '标题: 坏章',
    '钩子类型: 悬念钩',
    '钩子强弱: 中',
    '情绪定位: 压抑',
    '---',
    '',
    '正文照常。',
    '',
  ].join('\n'))
}
