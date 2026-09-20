# CLWriting

写给中文网文作者的桌面写作软件。一本书从建书、大纲、设定、正文到审稿、定稿，全程都在这一个应用里完成；AI 是叠加在上面的助手——初稿它起草，改写和分析它来做，复读、设定对不上这类硬伤由程序一遍遍检查，读稿和拍板永远是你自己。连载长篇和一篇一个故事的短篇集都支持。

你的书就是磁盘上一个普通文件夹，里面全是 Markdown 和 YAML——备份、换电脑、用别的软件打开都随你。目标是在长篇写到两百万字的量级时依然不崩设定、不吃书：这件事不指望 AI 自觉，靠程序里的账本核对、伏笔追踪、版本快照兜底。

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Test](https://img.shields.io/badge/tests-7880%20all%20green-4FC08D?logo=vitest&logoColor=white)](#技术栈)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 写一本书的流程

1. **建书。** 填书名、选题材，选长篇或短篇集，目录结构自动生成。
2. **写设定。** 大纲、角色、世界观、物品都在表单里填。长篇的大纲分总纲、卷纲、章纲三层；短篇没有卷纲，章纲里带反转线索表和情绪曲线。
3. **写正文。** 可以自己写；也可以点「全自动写章」：AI 起草，程序立刻体检——复读、句式、禁词、比喻太密这类能量化的问题挨个查，不合格就打回重写，全过了才交给你。重试到上限会停下来问你，不会闷头烧钱。
4. **审稿。** 三审：长篇是读者视角、编辑视角、设定校对各来一遍；短篇看钩子、情绪反转、收尾。AI 给意见，改不改你说了算。
5. **定稿。** 一章一章确认。定稿前程序会再对一遍账：设定里声明过的和正文实际写的是否一致，对不上就先拦下来。

写作过程里还有一批顺手工具：伏笔埋了没收会提醒你；字数曲线和规划对照，节奏跑偏提前预警；文风库管着禁词、样章和手法，机器检查和 AI 写作都按它来；选中一段文字可以让 AI 改写或分析；工作台里有个对话助手，查资料、改文件都能代劳，有风险的操作会先问你。AI 服务自己配——Anthropic 官方、Claude 中转、OpenAI 兼容接口都行；Key 只加密存在你本机，不进 git，也不落日志。

## 下载与安装

去 [GitHub Releases](https://github.com/Jevanzhu/CLWriting/releases) 下载对应平台的包，每个版本都附 SHA256SUMS.txt，可以校验下载没被动过手脚。安装包没有做正式的代码签名，首次运行被系统拦一下是正常现象，不是文件坏了；也没有自动更新，有新版本手动下载、退出应用后覆盖即可——书稿都在书库文件夹里，怎么升级都动不到它们。

- **Windows**（便携 zip，Win10/11 64 位）：解压到任意目录，双击 `CLWriting.exe` 就能用。首次运行 SmartScreen 提示「已保护你的电脑」时，点「更多信息 → 仍要运行」。
- **macOS**（dmg，需 macOS 13 及以上）：M 系芯片下 arm64 版，Intel 机型下 x64 版，拖进「应用程序」。首次打开被拦时，到「系统设置 → 隐私与安全性」点「仍要打开」；若提示「已损坏」，在终端执行 `xattr -cr /Applications/CLWriting.app` 后再打开。

## 技术栈

Node 24+，TypeScript strict。界面 Vue 3 + Pinia + Vite，编辑器 CodeMirror 6，桌面壳 Electron；数据是 node:sqlite（检索索引）加 JSON/YAML 文件；AI 接三个协议（Anthropic、OpenAI Chat、OpenAI Responses），统一走 runTask 编排，重试、超时、用量都在这一层管。测试 vitest（7880 单测）+ Playwright（33 specs / 54 用例）——1272 个测试文件 / 7880 单测全绿是合入门槛，CI 会核对本文件声称的数字，对不上直接红。

## 致谢

设计上参考过这些开源项目：

- [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)——架构思想来源；本项目是从零重写的
- [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（MIT）——长篇写作方法论
- [character-arc](https://github.com/uu201/character-arc)（MIT）——角色弧线与设定方法论

## 许可证

[MIT](LICENSE)
