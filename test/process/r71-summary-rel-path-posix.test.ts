/**
 * R71-15（总七十一轮）回归：章/卷摘要相对路径函数 posix 归一。
 *
 * 此前 chapterSummaryRelPath/volumeSummaryRelPath 用 join() 产平台分隔符——win 上
 * promptFiles/摘要留痕与全库 posix 归一口径（draft-pipeline F2）分裂。修复后两函数
 * 与目录常量恒产 '/' 形态；fs 消费侧（chapterSummaryPath/volumeSummaryPath）经 join
 * 归一不受影响。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  CHAPTER_SUMMARY_DIR,
  VOLUME_SUMMARY_DIR,
  chapterSummaryRelPath,
  volumeSummaryRelPath,
  chapterSummaryPath,
  volumeSummaryPath,
} from '../../src/process/summary.js'

test('R71-15: 摘要相对路径恒 posix（无平台分隔符）', () => {
  // 字面量 posix 断言（与宿主平台无关——win 上 join 形态会红）
  expect(chapterSummaryRelPath(3)).toBe('定稿/摘要/章摘要/3.md')
  expect(volumeSummaryRelPath(2)).toBe('定稿/摘要/卷摘要/2.md')
  expect(CHAPTER_SUMMARY_DIR).toBe('定稿/摘要/章摘要')
  expect(VOLUME_SUMMARY_DIR).toBe('定稿/摘要/卷摘要')
  // 防平台分隔符回退的显式断言
  expect(chapterSummaryRelPath(12)).not.toContain('\\')
  expect(volumeSummaryRelPath(12)).not.toContain('\\')
})

test('R71-15: fs 消费侧不受影响——chapterSummaryPath/volumeSummaryPath 照常定位文件', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r71-sumrel-'))
  try {
    const chPath = chapterSummaryPath(root, 3)
    mkdirSync(dirname(chPath), { recursive: true })
    writeFileSync(chPath, '章摘要正文', 'utf-8')
    expect(existsSync(chPath)).toBe(true)
    const volPath = volumeSummaryPath(root, 2)
    mkdirSync(dirname(volPath), { recursive: true })
    writeFileSync(volPath, '卷摘要正文', 'utf-8')
    expect(existsSync(volPath)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
