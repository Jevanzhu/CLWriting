# 归档决策记录

封存的决策记录。此处的每一件都已冻结：永不编辑、重排、翻译、修复、移动或删除。`manifest.json` 逐文件记录内容哈希且只增不改，任何对已封存字节的改动都会被 `scripts/harness/verify-archived-agent-notes.ts` 拒绝。

归档是文件出现在这里的唯一途径：

1. 把完整的三件套从 `implemented/<class>/` 移入本目录。
2. 在每个语言文件的 `Status: implemented` 行正下方插入一行完全相同的 `Archived: YYYY-MM-DD`。
3. 重录配对内容的一致性记录。
4. 修理或删除指向它的入站链接。
5. 运行 `node scripts/harness/verify-archived-agent-notes.ts --write` 封存。

归档的链接只查入站：指向本树的链接会被校验；本树发出的出链不查——它们按设计可能已经过时。
