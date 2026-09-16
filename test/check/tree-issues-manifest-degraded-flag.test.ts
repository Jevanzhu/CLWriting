/**
 * R0916-6-P2-1（2026-09-16 五轮全库重评修复批）回归：树红点聚合透出清单读失败
 * 降级旗标——collectTreeIssuesCore 聚合头整读清单改走 readManifestDegraded，
 * 读失败时 manifestDegraded=true 随返回透出（端点层 api/check.ts 转 warnings），
 * 修复前与「无清单」同归空表静默（整轮章-账本红点失明零透出）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { collectTreeIssues } from '../../src/check/run.js'

let book = ''
beforeEach(() => {
  book = mkdtempTracked('clw-tree-manifest-degraded-')
})

describe('R0916-6-P2-1：树红点聚合清单读失败旗标', () => {
  it('清单路径为目录（EISDIR 读失败）→ manifestDegraded=true（此前静默失明）', () => {
    mkdirSync(join(book, '项目', '文档清单.jsonl'), { recursive: true })
    const r = collectTreeIssues(book, () => undefined, null)
    expect(r.manifestDegraded).toBe(true)
    expect(Object.keys(r.issues)).toHaveLength(0)
  })

  it('清单不存在（合法空态）→ manifestDegraded=false（不误报）', () => {
    const r = collectTreeIssues(book, () => undefined, null)
    expect(r.manifestDegraded).toBe(false)
  })
})
