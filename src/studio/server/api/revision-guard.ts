/**
 * expectedRevision 乐观并发守卫单源。
 *
 * providers / rag-providers / prefs 三处各持一份同名 revisionError 拷贝（providers
 * 首创、另两处照抄），校验口径与 409 文案开始漂移（「配置 / 全局偏好」措辞分裂）。
 * 收敛到本文件：判定逻辑唯一（缺失放行——旧客户端/脚本向后兼容；存在且与当前
 * revision 不等 → 409 冲突文案），主体名词经 subject 参数注入（providers 族
 * 「配置」、prefs「全局偏好」），各端点的既有行为与文案不变。
 * current 类型随指纹口径分流：prefs/providers 是自增计数（number），config 是
 * book.yaml 内容指纹（string hex）——比对按同一类型口径做（跨类型恒不等，等价于
 * 「期望值与服务端当前指纹不同源」按冲突处理）。
 */

/** expectedRevision 缺失/为 null → null 放行（兼容旧客户端/脚本）；
 *  与 current 类型不同或值不等 → 409 冲突文案（调用方 replyError(res, 409, 'REVISION_CONFLICT', …)）；
 *  匹配 → null 放行。 */
export function revisionError(expected: unknown, current: number | string, subject = '配置'): string | null {
  if (expected === undefined || expected === null) return null
  if (typeof expected !== typeof current || expected !== current) {
    return `${subject}已在其他窗口被修改，请刷新`
  }
  return null
}
