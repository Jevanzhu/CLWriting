/**
 * 测试可注入常量工厂（修复批）。
 *
 * 收敛此前逐字重复的「三件套」样板：`export const X = def` + `let x = X` +
 * `export function __setXForTest(v)`（全库 46 处定义）。工厂返回
 * `[getter, setter]` 元组，调用侧解构命名保持既有钩子名，测试面零感知；
 * 生产消费点从裸可变量改调 getter（加括号）。
 *
 * 刻意零依赖（shared 惯例）。
 */

/** 定义一个可被测试注入覆盖的常量档位。def = 生产默认值。 */
export function testableConst<T>(def: T): readonly [() => T, (v: T) => void] {
  let v = def
  return [
    () => v,
    (nv: T) => {
      v = nv
    },
  ]
}
