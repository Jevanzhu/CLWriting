from __future__ import annotations

import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
TEMPLATES_DIR = PLUGIN_ROOT / "templates" / "output"


EXPECTED_TEMPLATES = {
    "大纲-总纲.md": ["目标字数", "节奏分配", "伏笔回收清单", "章节大纲", "结尾"],
    "设定集-世界观.md": ["时代背景", "核心规则", "信息边界", "节奏约束"],
    "设定集-主角卡.md": ["外在目标", "内在缺陷", "独特优势连接", "章内变化曲线"],
    "设定集-反派设计.md": ["镜像关系", "分层阻力", "行动节奏", "伏笔与回收"],
    "设定集-力量体系.md": ["适用条件", "能力边界", "短篇压缩规则", "伏笔回收"],
    "设定集-主角组.md": ["适用条件", "成员总览", "分工与冲突", "篇幅控制"],
    "设定集-女主卡.md": ["适用条件", "主线功能", "感情线节奏", "独立性检查"],
    "设定集-独特优势.md": ["行动优势", "资源、人脉、背景、知识、技能", "行动用途", "限制设计"],
    "设定集-金手指.md": ["条件生成", "外挂型能力", "功能边界", "与独特优势的区分"],
    "复合题材-融合逻辑.md": ["适用条件", "题材拆分", "融合原则", "冲突映射"],
    "state-schema.md": ["schema_version", "word_count_target", "unique_advantage", "golden_finger"],
}

FORBIDDEN_LONG_FORM_TERMS = [
    "境界链",
    "宗门",
    "势力",
    "货币体系",
    "卷节拍",
    "卷时间线",
    "index-schema",
]


class Phase6TemplateTests(unittest.TestCase):
    def test_all_phase6_output_templates_exist(self) -> None:
        self.assertTrue(TEMPLATES_DIR.is_dir(), "missing templates/output")
        actual = {path.name for path in TEMPLATES_DIR.glob("*.md")}
        self.assertEqual(set(EXPECTED_TEMPLATES), actual)

    def test_templates_have_short_story_required_sections(self) -> None:
        for filename, phrases in EXPECTED_TEMPLATES.items():
            with self.subTest(filename=filename):
                text = (TEMPLATES_DIR / filename).read_text(encoding="utf-8")
                self.assertGreater(len(text.strip()), 200)
                self.assertTrue(text.lstrip().startswith("# "))
                for phrase in phrases:
                    self.assertIn(phrase, text)

    def test_templates_remove_long_form_webnovel_fields(self) -> None:
        for template_file in TEMPLATES_DIR.glob("*.md"):
            with self.subTest(filename=template_file.name):
                text = template_file.read_text(encoding="utf-8")
                for term in FORBIDDEN_LONG_FORM_TERMS:
                    self.assertNotIn(term, text)

    def test_unique_advantage_and_golden_finger_are_distinct(self) -> None:
        unique_text = (TEMPLATES_DIR / "设定集-独特优势.md").read_text(encoding="utf-8")
        golden_text = (TEMPLATES_DIR / "设定集-金手指.md").read_text(encoding="utf-8")

        self.assertIn("现实支点", unique_text)
        self.assertIn("不是外挂型能力", unique_text)
        self.assertIn("额外获得了什么外挂", golden_text)
        self.assertIn("原本凭什么能够行动", golden_text)


if __name__ == "__main__":
    unittest.main()
