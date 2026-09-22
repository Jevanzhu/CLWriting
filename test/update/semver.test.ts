/**
 * 阶段 53 S1：版本比较器表驱动（设计 §6 验收口径：rc / 正式 / 相等 / 乱序 / 垃圾 tag /
 * 空表 / 高位 / 前缀 v 有无）。
 *
 * 关键锚（设计 D1 的判定基础）：`1.0.0-rc.0 < 1.0.0`——rc 用户会收到首个正式版提示，
 * rc→rc 不打扰；`pickLatestStable` 只认不带 `-` 的 tag，垃圾/预发布形态当不存在。
 */
import { describe, it, expect } from 'vitest'
import { compareSemver, parseSemver, pickLatestStable } from '../../src/update/semver.js'

describe('parseSemver', () => {
  it('解析正式版 / 预发布 / 前导 v / 构建元数据', () => {
    expect(parseSemver('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: null })
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseSemver('1.0.0-rc.0')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: 'rc.0' })
    expect(parseSemver('v2.10.30-beta')).toEqual({ major: 2, minor: 10, patch: 30, prerelease: 'beta' })
    expect(parseSemver('1.2.3+build.7')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseSemver('  1.2.3  ')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
  })

  it('垃圾输入一律 null（不抛）', () => {
    for (const bad of ['', 'nightly', 'v1.0', '1.2', '1.2.3.4', 'release-1.0.0', 'v1.x.0', '1.0.0-', '--', 'latest']) {
      expect(parseSemver(bad), bad).toBeNull()
    }
  })
})

describe('compareSemver', () => {
  it('三方组序', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1)
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1)
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1)
    expect(compareSemver('1.0.0', 'v1.0.0')).toBe(0)
  })

  it('预发布 < 正式（rc 用户收首个正式版提示的判定）', () => {
    expect(compareSemver('1.0.0-rc.0', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.0')).toBe(1)
    expect(compareSemver('1.0.0-rc.0', '1.0.0-rc.0')).toBe(0)
  })

  it('预发布互比按段（数字段 < 字母段，段数短者小）', () => {
    expect(compareSemver('1.0.0-rc.0', '1.0.0-rc.1')).toBe(-1)
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.10')).toBe(-1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareSemver('1.0.0-rc', '1.0.0-rc.0')).toBe(-1)
  })

  it('任一侧不可解析 → 0（保守：不提示）', () => {
    expect(compareSemver('nightly', '1.0.0')).toBe(0)
    expect(compareSemver('1.0.0', 'v1.x')).toBe(0)
  })
})

describe('pickLatestStable', () => {
  it('取最大正式版并忽略 rc / 垃圾 / 高位乱序', () => {
    expect(pickLatestStable(['v1.0.0', 'v1.2.0', 'v1.1.5'])).toBe('v1.2.0')
    expect(pickLatestStable(['1.0.0', '2.0.0-rc.1', '1.9.9'])).toBe('1.9.9')
    expect(pickLatestStable(['nightly', 'release-latest', 'v0.10.0'])).toBe('v0.10.0')
    expect(pickLatestStable(['v1.0.0', 'v1.0.0+build.2'])).toBe('v1.0.0')
  })

  it('空表 / 全垃圾 / 全预发布 → null', () => {
    expect(pickLatestStable([])).toBeNull()
    expect(pickLatestStable(['nightly', 'v1.0', 'what'])).toBeNull()
    expect(pickLatestStable(['v1.0.0-rc.0', 'v0.9.0-beta'])).toBeNull()
  })
})
