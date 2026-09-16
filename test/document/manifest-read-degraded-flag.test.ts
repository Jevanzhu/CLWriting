/**
 * R0916-6-P2-1（2026-09-16 五轮全库重评修复批）回归：readManifestDegraded 分离
 * 「文件不存在 = 合法空」与「读了但失败 = 降级」——此前 readManifest 把两者混同
 * 为空清单，树红点聚合在清单撞 EACCES/EBUSY/EIO 瞬态读失败时整轮章-账本红点
 * 失明且零透出（唯一数据正确性面的静默降级）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readManifest, readManifestDegraded } from '../../src/document/manifest.js'

let dir = ''
beforeEach(() => {
  dir = mkdtempTracked('clw-manifest-degraded-')
})

describe('R0916-6-P2-1：readManifestDegraded 降级旗标', () => {
  it('文件不存在 → degraded:null + 空清单（合法空态，与读失败分立）', () => {
    const r = readManifestDegraded(join(dir, '项目', '文档清单.jsonl'))
    expect(r.degraded).toBeNull()
    expect(r.manifest.entries.size).toBe(0)
    expect(r.manifest.version).toBe(1)
  })

  it('路径是目录（readFileSync EISDIR 模拟读失败）→ degraded 携错误码 + 空清单（不再与合法空同形）', () => {
    const p = join(dir, '文档清单.jsonl')
    mkdirSync(p)
    const r = readManifestDegraded(p)
    expect(r.degraded).not.toBeNull()
    expect(r.degraded?.code).toBe('EISDIR')
    expect(r.manifest.entries.size).toBe(0)
  })

  it('合法清单 → 解析成功 degraded:null；readManifest 委托语义不变', () => {
    const p = join(dir, '文档清单.jsonl')
    writeFileSync(
      p,
      '{"type":"header","version":1}\n{"id":"doc_1","nodeType":"document","path":"写作/正文/0001-a.md","parentId":null}\n',
      'utf-8',
    )
    const r = readManifestDegraded(p)
    expect(r.degraded).toBeNull()
    expect(r.manifest.entries.get('doc_1')?.path).toBe('写作/正文/0001-a.md')
    expect(readManifest(p).entries.get('doc_1')?.path).toBe('写作/正文/0001-a.md')
  })
})
