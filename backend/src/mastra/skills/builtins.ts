import { createSkill } from '@mastra/core/skills';
import type { InlineSkill } from '@mastra/core/skills';

export const structuredSummarySkill: InlineSkill = createSkill({
  name: 'structured-summary',
  description: '生成包含核心结论、关键事实和注意事项的结构化摘要。',
  instructions: `当你需要总结或概括内容时，使用以下结构化输出格式：

## 核心结论
用 1-3 句话提炼最重要的结论。

## 关键事实
列出 3-7 条支撑结论的关键事实，每条用简洁的语言表述。

## 注意事项
列出需要特别留意的限制、风险或后续需要确认的事项，1-3 条。

保持中文输出，确保结构清晰、重点突出。`,
  compatibility: ['compatible'],
  metadata: {
    category: 'instruction',
    type: 'builtin',
  },
});
