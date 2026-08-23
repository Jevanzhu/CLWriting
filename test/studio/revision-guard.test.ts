/**
 * X-25（第五十六轮）：expectedRevision 并发守卫单源回归。
 *
 * providers / rag-providers / prefs 三处各持一份 revisionError 拷贝、口径开始漂移，
 * 收敛到 api/revision-guard.ts 单源（subject 参数注入主体名词）。本文件直测单源口径：
 * 缺失放行（旧客户端兼容）/ null 放行 / 非数字拒 / 失配拒 / 匹配放行 / 三端点主体
 * 文案映射（providers 系「配置」、prefs「全局偏好」）。三端点 HTTP 层 409 行为由
 * prefs-revision / providers-revision-models / rag-providers-api 既有集成测锚定。
 */
import { describe, it, expect } from 'vitest'
import { revisionError } from '../../src/studio/server/api/revision-guard.js'

describe('X-25: revisionError 单源口径', () => {
  it('expectedRevision 缺省 / null → 放行（旧客户端/脚本向后兼容）', () => {
    expect(revisionError(undefined, 3)).toBeNull()
    expect(revisionError(null, 3)).toBeNull()
  })

  it('非数字（含字符串数字）与失配 → 409 冲突文案（不静默放行）', () => {
    expect(revisionError('3', 3)).toBe('配置已在其他窗口被修改，请刷新')
    expect(revisionError(2, 3)).toBe('配置已在其他窗口被修改，请刷新')
  })

  it('匹配 → 放行', () => {
    expect(revisionError(3, 3)).toBeNull()
  })

  it('subject 注入：providers/rag 系缺省「配置」，prefs 传「全局偏好」——三端点文案口径同源', () => {
    expect(revisionError(0, 1)).toContain('配置已在其他窗口被修改，请刷新')
    expect(revisionError(0, 1, '全局偏好')).toBe('全局偏好已在其他窗口被修改，请刷新')
    // 主体词替换不改变句式（三处收敛后无第三种措辞）
    expect(revisionError(0, 1, '全局偏好')).not.toContain('配置')
  })
})
