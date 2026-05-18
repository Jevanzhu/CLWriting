#!/usr/bin/env python3
"""Entity relationship extraction from story-craft memory."""

from __future__ import annotations

from typing import Any


def build_entity_graph(memory: dict[str, Any]) -> dict[str, Any]:
    """Build a simple graph from character records and relationship fields."""
    nodes = []
    edges = []
    known_ids = set()
    for char in memory.get("characters", []) or []:
        node_id = str(char.get("id") or char.get("name") or "")
        if not node_id:
            continue
        known_ids.add(node_id)
        nodes.append(
            {
                "id": node_id,
                "name": str(char.get("name") or node_id),
                "role": str(char.get("role") or ""),
                "tier": str(char.get("tier") or ""),
                "last_appearance_chapter": int(char.get("last_appearance_chapter") or 0),
            }
        )
    for char in memory.get("characters", []) or []:
        source = str(char.get("id") or char.get("name") or "")
        for relation in char.get("relationships", []) or []:
            if not isinstance(relation, dict):
                continue
            target = str(
                relation.get("target_id")
                or relation.get("target")
                or relation.get("name")
                or ""
            )
            if not target:
                continue
            edges.append(
                {
                    "source": source,
                    "target": target,
                    "type": str(relation.get("type") or relation.get("relation") or "related"),
                    "description": str(relation.get("description") or ""),
                    "known_target": target in known_ids,
                }
            )
    orphan_edges = [edge for edge in edges if not edge["known_target"]]
    return {
        "nodes": nodes,
        "edges": edges,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "orphan_edges": orphan_edges,
    }
