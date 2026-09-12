/**
 * 对话历史单一事实源常量（R0912-3 #10）。
 * 收敛先例同 storage-keys.ts 的「同值多写点收敛」族。
 * 刻意独立于 api/chat 成件：该模块是测试高频 mock 面，常量入内会连带
 * 全部 api/chat mock 补键（20+ 处测试文件）。
 */

/** 对话历史展示尾窗上限：fetchChatHistory 的 limit 参数、chat store 气泡上限
 *  （MAX_MESSAGES）、ChatMessages 截断提示文案三处此前各硬编码 200，曾失同步。 */
export const CHAT_HISTORY_LIMIT = 200
