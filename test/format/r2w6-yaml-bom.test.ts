/**
 * R2W-6（win 平台专项复审 R2）：book.yaml 补丁族键行匹配的 BOM 容忍。
 *
 * 首行带 BOM（记事本保存）时 matchesKeyLine 锚定失配 → 补丁在文件尾造重复段/重复键
 * → 下次解析撞 fail-loud 重复守卫、全书配置降级。修复后：BOM'd 键行被识别，原位改写。
 */
import { describe, expect, it } from 'vitest'
import {
  patchTopSection,
  setTopSectionKey,
  patchBookConfigText,
  DEFAULT_CONFIG,
} from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const BOM = '\uFEFF'

describe('补丁族键行 BOM 容忍（R2W-6）', () => {
  it('patchTopSection：BOM 开头的段头 → 原位替换，不追加重复段', () => {
    const raw = `${BOM}genre:\n  基调: 热血\n\nspec_version: 1\n`
    const out = patchTopSection(raw, 'genre', '  基调: 玄幻\n')
    // BOM'd 段头被识别（修复前：原段不被匹配 → 文件尾追加第二处 genre:）
    expect(out.match(/genre:/g)).toHaveLength(1)
    expect(out).toContain('基调: 玄幻')
    expect(out).not.toContain('基调: 热血')
  })

  it('setTopSectionKey：BOM 开头的段头 → 段内键原位更新，不造重复段', () => {
    const raw = `${BOM}genre:\n  基调: 热血\n`
    const out = setTopSectionKey(raw, 'genre', '基调', '玄幻')
    expect(out.match(/genre:/g)).toHaveLength(1)
    expect(out).toContain('基调: 玄幻')
  })

  it('patchBookConfigText：BOM 行首的标量键 → 原位更新，不重复插键', () => {
    const raw = `${BOM}spec_version: 1\n`
    const oldCfg: BookConfig = { ...DEFAULT_CONFIG, spec_version: 1 }
    const newCfg: BookConfig = { ...DEFAULT_CONFIG, spec_version: 2 }
    const out = patchBookConfigText(raw, oldCfg, newCfg)
    expect(out.match(/spec_version:/g)).toHaveLength(1)
    expect(out).toContain('spec_version: 2')
  })
})
