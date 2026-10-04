/**
 * Presentation helpers for the AI editorial categories.
 *
 * Categories are model data, not markup. Keeping the mapping in one small
 * module lets the image and the Telegram digest use the same topic emoji while
 * still treating unknown/legacy values safely.
 */

export interface TopicPresentation {
  category: string;
  label: string;
  emoji: string;
}

const TOPICS: Record<string, Omit<TopicPresentation, 'category'>> = {
  general: { label: 'عمومی', emoji: '📰' },
  politics: { label: 'سیاست', emoji: '🏛️' },
  economy: { label: 'اقتصاد', emoji: '💰' },
  technology: { label: 'فناوری', emoji: '💻' },
  society: { label: 'جامعه', emoji: '👥' },
  culture: { label: 'فرهنگ', emoji: '🎭' },
  sports: { label: 'ورزش', emoji: '⚽' },
  world: { label: 'جهان', emoji: '🌍' },
};

const INFERENCE_RULES: Array<[string, RegExp]> = [
  ['sports', /فوتبال|ورزش|المپیک|لیگ|بازیکن|تیم|ورزشکار|sport|football|match/i],
  ['technology', /فناوری|تکنولوژی|هوش مصنوعی|نرم.?افزار|اینترنت|موبایل|ربات|tech|software|internet/i],
  ['economy', /اقتصاد|قیمت|بازار|بورس|دلار|ارز|بانک|تورم|بودجه|economy|market|stock/i],
  ['politics', /دولت|مجلس|رئیس.?جمهور|انتخابات|وزیر|تحریم|جنگ|رئیس|سیاست|politic|election|president/i],
  ['culture', /فرهنگ|هنر|سینما|فیلم|موسیقی|کتاب|بازیگر|culture|film|music/i],
  ['society', /جامعه|مردم|مدرسه|دانشگاه|سلامت|پزشک|زلزله|آتش.?سوزی|اجتماع|society|health/i],
  ['world', /جهان|بین.?الملل|آمریکا|اروپا|روسیه|اسرائیل|غزه|world|international/i],
];

/** Returns a stable Persian label and topic emoji for a stored category. */
export function topicPresentation(
  category: string | null | undefined,
  context = ''
): TopicPresentation {
  const key = (category ?? '').trim().toLowerCase();
  const inferred = key && TOPICS[key]
    ? key
    : INFERENCE_RULES.find(([, pattern]) => pattern.test(context))?.[0] ?? 'general';
  return { category: inferred, ...TOPICS[inferred] };
}

export function topicEmoji(category: string | null | undefined): string {
  return topicPresentation(category).emoji;
}
