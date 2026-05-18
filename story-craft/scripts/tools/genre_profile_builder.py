#!/usr/bin/env python3
"""Build short/medium fiction genre hints."""

from __future__ import annotations

from typing import Optional

from tools.genre_aliases import list_all_genres, normalize_genre


DEFAULT_HINTS = {
    "pacing": "保持场景目标清晰，每章至少完成一次信息推进或关系变化。",
    "dialogue": "对白服务于冲突、试探和信息差，避免连续解释超过三轮。",
    "description": "描写优先承载情绪和线索，单段环境描写不宜过长。",
    "ending": "结尾应回扣开篇钩子，并完成主题或情绪的反转落点。",
    "pitfalls": ["避免只堆设定不推进情节", "避免用解释替代行动"],
}


GENRE_HINTS: dict[str, dict[str, object]] = {
    "悬疑灵异": {
        "pacing": "中高速推进，每章至少出现一个新线索、误导或认知反转。",
        "dialogue": "对白应制造信息差，让角色各自隐瞒一部分真相。",
        "description": "环境描写服务于不安感和线索埋设，避免纯气氛堆叠。",
        "ending": "结尾可以解答行动谜题，但保留一个主题层面的不可知问题。",
        "pitfalls": ["不要在中段解释全部真相", "不要让关键线索只在结尾突然出现"],
    },
    "规则怪谈": {
        "pacing": "先给规则，再让规则被误读、冲突或反噬，逐章抬高代价。",
        "dialogue": "对白围绕规则理解分歧展开，避免角色替作者讲设定。",
        "description": "细节要可复查，异常点应短促、准确、可被后文回扣。",
        "ending": "结尾应揭示规则背后的代价或漏洞，而不是简单逃脱。",
        "pitfalls": ["规则不能随剧情临时改写", "不要把规则写成普通谜语"],
    },
    "现实题材": {
        "pacing": "用具体处境推进冲突，避免抽象议题先行。",
        "dialogue": "对白要有生活感和潜台词，少用口号式表达。",
        "description": "选择能体现阶层、职业、关系压力的细节。",
        "ending": "结尾不必圆满，但需要给出人物选择后的余波。",
        "pitfalls": ["避免议论文式抒情", "避免把人物写成观点容器"],
    },
    "科幻": {
        "pacing": "尽早展示核心设定对人物选择的压力，设定解释分散到行动中。",
        "dialogue": "技术信息通过争执、操作和误判暴露，避免百科式说明。",
        "description": "科技术语要少而准，每个新概念都要影响剧情。",
        "ending": "结尾应让设定反过来改变人物或主题理解。",
        "pitfalls": ["不要堆无关世界观", "不要用万能科技解决全部冲突"],
    },
    "知乎短篇": {
        "pacing": "开篇快速抛出强问题，段落短，转折密度高。",
        "dialogue": "对白直接、有钩子，保留少量反讽或反击感。",
        "description": "描写压缩，优先呈现关键证据和情绪爆点。",
        "ending": "结尾强调爽感、反转或情绪释放，避免拖尾解释。",
        "pitfalls": ["不要开头铺垫过长", "不要连续大段背景介绍"],
    },
    "狗血言情": {
        "pacing": "情绪误会、关系拉扯和选择代价要交替出现。",
        "dialogue": "对白带潜台词和攻击性，避免只说真实想法。",
        "description": "描写集中在身体反应、空间距离和物件记忆。",
        "ending": "结尾要明确情感立场，完成关系权力的反转或重建。",
        "pitfalls": ["不要只靠巧合制造误会", "不要让角色反复原地争吵"],
    },
    "修仙": {
        "pacing": "短篇修仙应压缩升级链，围绕一次突破、试炼或代价展开。",
        "dialogue": "对白体现门规、师承、利益和道心差异。",
        "description": "法术与境界描写要和人物选择绑定，不做长设定展示。",
        "ending": "结尾最好落在道心选择，而不是单纯战力胜负。",
        "pitfalls": ["不要照搬长篇升级节奏", "不要引入过多宗门势力"],
    },
}


GENRE_HINT_LAYERS: list[tuple[set[str], dict[str, object]]] = [
    (
        {"都市日常", "职场婚恋", "豪门总裁", "青春甜宠"},
        {
            "pacing": "围绕关系、职业和生活压力推进，每章都要让现实处境发生可见变化。",
            "dialogue": "对白保留潜台词和边界感，让亲密关系或职场权力在话里交锋。",
            "description": "细节聚焦空间距离、消费习惯、工作流程和情绪反应。",
            "ending": "结尾落在关系选择或现实代价上，给出清晰余波。",
            "pitfalls": ["不要只写日常闲聊", "不要让冲突只靠误会维持"],
        },
    ),
    (
        {"古言", "宫斗宅斗", "民国言情", "年代", "幻想言情", "现言脑洞", "替身文"},
        {
            "pacing": "情感推进和身份压力交替出现，每章至少改变一次关系权力。",
            "dialogue": "对白要有试探、遮掩和反击，不直接把真心一次说尽。",
            "description": "物件、礼法、场合和身体反应共同承载情绪张力。",
            "ending": "结尾完成情感立场或身份选择的反转。",
            "pitfalls": ["不要只靠巧合推进关系", "不要让角色反复原地拉扯"],
        },
    ),
    (
        {"历史古代", "历史脑洞", "抗战谍战"},
        {
            "pacing": "用时代约束和任务节点推进，信息、身份和风险逐章升级。",
            "dialogue": "对白带立场和身份试探，避免现代口吻解释历史背景。",
            "description": "历史细节服务行动和处境，不做资料堆叠。",
            "ending": "结尾落在任务结果、时代代价或人物信念的选择。",
            "pitfalls": ["不要把历史背景写成百科", "不要让主角无成本改变大局"],
        },
    ),
    (
        {"都市异能", "都市脑洞", "系统流", "无限流", "高武", "xuanhuan", "西幻", "末世"},
        {
            "pacing": "能力规则、危机和代价同步推进，短篇只抓一个核心机制。",
            "dialogue": "对白围绕规则理解、资源分配和生死选择展开。",
            "description": "能力和世界细节必须能影响当章行动，不做长篇设定展示。",
            "ending": "结尾回收核心机制的代价或漏洞，而非单纯升级胜利。",
            "pitfalls": ["不要铺开过多势力", "不要用万能能力解决全部冲突"],
        },
    ),
    (
        {"电竞", "游戏体育", "直播文"},
        {
            "pacing": "比赛、直播节点或榜单压力要形成清晰阶段目标。",
            "dialogue": "对白体现战术、节奏和队友关系，避免纯解说。",
            "description": "动作、操作和观众反馈要服务胜负压力。",
            "ending": "结尾落在一场关键胜负、名场面或关系变化。",
            "pitfalls": ["不要把赛事流程写成流水账", "不要让观众弹幕替代剧情冲突"],
        },
    ),
    (
        {"女频悬疑", "悬疑脑洞", "克苏鲁", "黑暗题材"},
        {
            "pacing": "谜面、心理压力和危险后果逐章递进，保持可复查线索。",
            "dialogue": "对白制造不可靠信息和立场错位。",
            "description": "异常细节要短促精准，服务恐惧、谜题或伦理压力。",
            "ending": "结尾至少回收一个关键谜点，同时保留情绪余震。",
            "pitfalls": ["不要只靠气氛吓人", "不要在结尾突然补关键设定"],
        },
    ),
    (
        {"种田", "多子多福"},
        {
            "pacing": "围绕资源、家庭结构和阶段成果推进，短篇聚焦一次关键经营目标。",
            "dialogue": "对白体现利益分配、亲缘压力和共同体边界。",
            "description": "生活细节要转化为资源变化或关系变化。",
            "ending": "结尾落在阶段成果、家庭选择或共同体稳定。",
            "pitfalls": ["不要只罗列生活流程", "不要引入过多旁支人物"],
        },
    ),
]


def build_genre_hints(genre: str, sub_genre: Optional[str] = None) -> dict:
    """Return concise writing hints for a genre."""
    canonical = normalize_genre(genre)
    hints = dict(DEFAULT_HINTS)
    for genre_names, layer_hints in GENRE_HINT_LAYERS:
        if canonical in genre_names:
            hints.update(layer_hints)
            break
    hints.update(GENRE_HINTS.get(canonical, {}))
    if sub_genre:
        hints["sub_genre"] = sub_genre
    hints["genre"] = canonical
    hints["pitfalls"] = list(hints.get("pitfalls", []))
    return hints


__all__ = ["build_genre_hints", "list_all_genres"]
