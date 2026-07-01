// 关系图选中节点（模块级单例）：Settings 点节点 → DataDetail 右栏联动（对齐 mockup renderRelRight）。
// 节点详情数据待 core（RELATIONS.nodes 无对应 API），先留 name 占位。
import { ref } from 'vue'

export interface RelationNode {
  id: string
  name: string
  role?: string
}

const selectedNode = ref<RelationNode | null>(null)

function selectNode(n: RelationNode | null): void {
  selectedNode.value = n
}

export function useRelationNode() {
  return { selectedNode, selectNode }
}
