const RECORD_PHRASES = ['记一下', '记录下来', '帮我保存', '以后记得', '存一下', '保存一下'];
const NEGATED = /(?:不要|别|无需|不用)\s*(?:帮我)?(?:记录|保存|记住|存)/;

export function isRecordIntent(content: string): boolean {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return !NEGATED.test(normalized) && RECORD_PHRASES.some((phrase) => normalized.includes(phrase));
}
