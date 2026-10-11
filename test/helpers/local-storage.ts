/**
 * localStorage 替身 fixture 单源（happy-dom 前端测试用）。
 *
 * 收编 test/studio/webnext/** 里 21 档逐字复制的 createLocalStorage：内存 Map 支撑
 * 的 Storage 替身，供 vi.stubGlobal('localStorage', …) 或直接读打断言。
 *
 * 不变量：每次调用返回独立实例（跨用例/跨档零共享可变状态）；key(i) 按插入序枚举；
 * 缺键返回 null（对齐 Web Storage 语义，勿改返回 undefined）。
 * 分档隔离不受影响：本函数无副作用、不触碰全局，装配时机仍由各档自己决定。
 */

/** 造一个内存 Storage 替身（独立实例）。 */
export function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
