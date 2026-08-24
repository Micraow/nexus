import type { KnowledgeUnit, Message, Session } from '@/types/domain'

export const PROMPT_VERSION = '2026-08-v1'

export function buildSegmentationPrompt(session: Session, messages: Message[], chunkLabel?: string): string {
  const input = messages.map((message) => ({
    index: message.orderInSession,
    role: message.role,
    content: message.content,
  }))
  return `你是 Nexus 织知的对话分段器。请把同一 Session 中语义连续的消息划分为多个 KnowledgeUnit。

规则：
- 一个 KnowledgeUnit 可以包含多轮问答；
- topic_hint 只能是简短的主体或讨论角度，不是摘要；
- 每条消息必须出现在某个 unit，或明确列入 unassigned_message_indices；
- 不得改写、制造、删除消息索引；
- 一个索引不能属于多个 unit；
- 当前输入可能只是长 Session 的一个分块。只处理本次输入提供的全局消息索引，不要引用其他索引；
- 只返回 JSON，不要 Markdown 或解释文字。

Session：${session.title}
${chunkLabel ? `分块：${chunkLabel}\n` : ''}
输入消息：
${JSON.stringify(input, null, 2)}

输出格式：
{"units":[{"message_indices":[0,1],"title_hint":"RDMA 基本原理"}],"unassigned_message_indices":[]}`
}

export function buildTitlePrompt(session: Session, unit: KnowledgeUnit, messages: Message[], conceptNames: string[]): string {
  return `请为下面的 KnowledgeUnit 生成一个可区分的中文标题，不超过 30 个中文字符。标题应表达具体讨论角度，不要写成摘要，也不要只重复 Concept 名称。

Session：${session.title}
关联 Concept：${conceptNames.join('、') || '暂无'}
消息：${messages.map((message) => `${message.role}: ${message.content}`).join('\n')}

只返回 JSON：{"title":"..."}`
}

export function buildSummaryPrompt(session: Session, unit: KnowledgeUnit, messages: Message[], conceptNames: string[]): string {
  return `请为下面的 KnowledgeUnit 生成不超过 120 个中文字符的摘要，概括关键结论或比较角度，不要补充输入中没有的事实。

Session：${session.title}
标题：${unit.title ?? '待命名'}
关联 Concept：${conceptNames.join('、') || '暂无'}
消息：${messages.map((message) => `${message.role}: ${message.content}`).join('\n')}

只返回 JSON：{"summary":"..."}`
}

export function buildConceptPrompt(session: Session, unit: KnowledgeUnit, messages: Message[], conceptNames: string[]): string {
  return `请从下面的 KnowledgeUnit 提取 1～8 个稳定、可复用的 Concept。优先返回具体知识主体，不要返回“问题”“回答”“内容”等泛词；已有 Concept 只作为候选参考，不要强行合并。

Session：${session.title}
KnowledgeUnit：${unit.title ?? '待命名'}
已有候选：${conceptNames.join('、') || '暂无'}
消息：${messages.map((message) => `${message.role}: ${message.content}`).join('\n')}

只返回 JSON：{"concepts":[{"name":"...","aliases":[]}]}`
}

export function buildRepairPrompt(originalResponse: string, errors: string[]): string {
  return `请修正下面 JSON 的结构错误。只修改导致校验失败的字段，不改变其他有效内容，不添加解释文字。

校验错误：${JSON.stringify(errors)}
原始响应：${originalResponse}
只返回修正后的 JSON。`
}
