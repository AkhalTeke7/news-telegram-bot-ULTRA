/**
 * Deterministic, local advertisement / spam filter.
 *
 * Runs entirely in the Worker before any OpenRouter call. No network requests, no
 * AI, no DNS: every decision is a pure function of the post text, so the same
 * input always produces the same verdict.
 *
 * Design bias: news wins ties. Commercial vocabulary on its own (خرید، فروش،
 * قیمت، بازار، محصول) is never a signal, and news/reportage wording actively
 * reduces the score, so reporting about betting sites or price changes is not
 * mistaken for an advert.
 */

export type AdFilterResult = {
  isAdvertisement: boolean;
  score: number;
  reason: string | null;
};

/** Single source of truth for the decision. Do not scatter numbers elsewhere. */
export const ADVERTISEMENT_SCORE_THRESHOLD = 6;

const SCORE_REFERRAL = 6;
const SCORE_GAMBLING_AD = 6;
const SCORE_CTA = 4;
const SCORE_CTA_CAP = 8;
const SCORE_PROMO = 3;
const SCORE_PROMO_CAP = 6;
const SCORE_CONTACT = 2;
const SCORE_PROMO_URL = 2;
const SCORE_GAMBLING_TERM = 2;
const SCORE_COMMERCIAL_URL = 1;

const NEWS_MITIGATION_ONE = 0.35;
const NEWS_MITIGATION_TWO = 0.2;

/* --------------------------------------------------------------- normalize */

// Persian (U+06F0..) and Arabic-Indic (U+0660..) digits -> ASCII.
const DIGIT_MAP: Record<string, string> = {
  '\u06F0': '0', '\u06F1': '1', '\u06F2': '2', '\u06F3': '3', '\u06F4': '4',
  '\u06F5': '5', '\u06F6': '6', '\u06F7': '7', '\u06F8': '8', '\u06F9': '9',
  '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4',
  '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9',
};

// Arabic/Persian letter variants folded onto their common Persian form.
const LETTER_MAP: Record<string, string> = {
  '\u0643': '\u06A9', // ك  -> ک
  '\u06AA': '\u06A9', // ڪ  -> ک
  '\uFB8E': '\u06A9', // ﮎ  -> ک
  '\uFB8F': '\u06A9', // ﮏ  -> ک
  '\u064A': '\u06CC', // ي  -> ی
  '\u0649': '\u06CC', // ى  -> ی
  '\u06D2': '\u06CC', // ے  -> ی
  '\u0623': '\u0627', // أ  -> ا
  '\u0625': '\u0627', // إ  -> ا
  '\u0622': '\u0627', // آ  -> ا
  '\u0671': '\u0627', // ٱ  -> ا
  '\u0624': '\u0648', // ؤ  -> و
  '\u0626': '\u06CC', // ئ  -> ی
  '\u0621': '', // ء
  '\u0629': '\u0647', // ة  -> ه
  '\u06C0': '\u0647', // ۀ  -> ه
  '\u06BE': '\u0647', // ھ  -> ه
  '\u0640': '', // ـ (tatweel)
};

// Zero-width SPACES act as word separators (they must not glue words together);
// ZWNJ likewise separates, so "شرط‌بندی" can match the "شرط بندی" phrase.
const ZW_SEPARATORS = /[\u200B\u200C]/g;

// Harakat, superscript alef, tatweel, zero-width joiner/direction marks,
// bidi controls, BOM. The spaces above are handled before this.
const STRIP_CHARS =
  /[\u064B-\u0652\u0670\u0640\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

const EXTRA_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PUNCTUATION = /[.,;:!?()[\]{}"'«»…،؛؟٪%\-_\\|]+/g;

/**
 * Folds letters/digits and whitespace but keeps punctuation, so URLs survive
 * for detection. Used for URL/signal scanning.
 */
function foldText(input: string): string {
  return input
    .replace(ZW_SEPARATORS, ' ')
    .replace(STRIP_CHARS, '')
    .split('')
    .map((ch) => DIGIT_MAP[ch] ?? LETTER_MAP[ch] ?? ch)
    .join('')
    .replace(EXTRA_SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Fully normalized form used for phrase matching (URLs are not needed here). */
export function normalizeText(input: string): string {
  return foldText(input).replace(/\//g, ' ').replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(normalized: string): Set<string> {
  const words = normalized.split(' ').filter((w) => w.length > 0);
  const out = new Set<string>(words);
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

const containsAny = (haystack: string, phrases: string[]): number =>
  phrases.filter((p) => haystack.includes(p)).length;

const hasAnyToken = (set: Set<string>, words: string[]): number => words.filter((w) => set.has(w)).length;

/* ----------------------------------------------------------------- signals */

/** Purchase / ordering / contact calls to action. */
const CTA_PHRASES = [
  'همین حالا', 'خرید کنید', 'سفارش دهید', 'ثبت سفارش', 'تماس بگیرید',
  'دایرکت دهید', 'دایرکت', 'برای سفارش', 'جهت سفارش', 'لینک خرید',
  'سفارش دهید', 'خرید بفرمایید', 'پیام بدهید',
  'buy now', 'order now', 'shop now', 'contact us', 'order today', 'shop here',
];

/** Discount / offer / giveaway vocabulary. Deliberately excludes bare خرید/فروش. */
const PROMO_PHRASES = [
  'تخفیف', 'کد تخفیف', 'کد هدیه', 'هدیه', 'پاداش', 'بونوس', 'جایزه', 'جایزه بزرگ',
  'فروش ویژه', 'پیشنهاد ویژه', 'جشنواره', 'جشنواره فروش', 'ارسال رایگان',
  'فرصت محدود', 'فقط امروز', 'از دست ندهید', 'رایگان', 'ویژه',
  'discount', 'special offer', 'limited offer', 'limited time', 'promo',
  'promotion', 'coupon', 'discount code', 'free shipping', 'free bet', 'freebet',
  'bonus', 'giveaway', 'sign up bonus', 'welcome bonus',
];

const REFERRAL_PHRASES = [
  'معرفی دوست', 'با معرفی', 'معرفی دوستان', 'رفرال', 'دعوت از دوستان',
  'referral', 'refer a friend', 'invite friends',
];

const REGISTER_PHRASES = ['ثبت نام', 'ثبت نام کنید', 'register', 'sign up', 'create account'];

/** Gambling vocabulary as single tokens (avoids "بت" inside "ثبت"). */
const GAMBLING_TOKENS = [
  'کازینو', 'بت', 'پوکر', 'رولت', 'اسپین',
  'casino', 'bet', 'betting', 'gambling', 'sportsbook', 'poker', 'wager', 'baccarat', 'roulette',
];

/** Gambling vocabulary as phrases. */
const GAMBLING_PHRASES = [
  'شرط بندی', 'سایت شرط بندی', 'پیش بینی', 'پیش بینی ورزشی', 'پیش بینی فوتبال',
  'بازی انفجار', 'پوکر آنلاین', 'کازینو آنلاین', 'شرطی بندی',
  'online casino', 'sports betting', 'free bet', 'freebet', 'casino bonus',
];

/** Gambling tokens that only matter inside a URL. */
const BETTING_URL_TOKENS = [
  'bet', 'bets', 'betting', 'casino', 'gambling', 'sportsbook', 'poker', 'bonus',
  'promo', 'referral', 'freebet', 'free-bet', 'register', 'jackpot', 'spin',
];

const CONTACT_PHRASES = [
  'واتساپ', 'تلگرام', 'دایرکت', 'تماس', 'شماره تماس', 'پیامک',
  'whatsapp', 'telegram', 'contact us', 'dm us', 'call us',
];

const COMMERCIAL_TLDS = ['.com', '.ir', '.shop', '.store', '.online', '.net', '.io', '.org', '.ru'];

/** Reportage wording that makes an ad-like post far more likely to be news. */
const NEWS_PHRASES = [
  'پلیس', 'مسدود', 'بازداشت', 'توقیف', 'تحقیق', 'تحقیقات', 'قانون', 'قانونگذار',
  'مجلس', 'تصویب', 'طرح', 'گزارش', 'خبر', 'اعلام', 'هشدار', 'منبع',
  'arrest', 'arrested', 'police', 'court', 'lawsuit', 'bill', 'regulator',
  'regulation', 'report', 'investigat', 'banned', 'blocked', 'seized', 'official',
];

const PHONE_RE = /(?:\+?\d[\s\-().]{6,}\d)/;
const URL_RE = /https?:\/\/\S+|\bwww\.\S+|\b\S+\.(?:com|ir|shop|store|online|net|org|io|ru|xyz|top|vip)\b\S*/g;

/* ------------------------------------------- external identifier stripping */

const DOMAIN_SUFFIXES =
  'com|ir|shop|store|online|net|org|io|ru|xyz|top|vip|me|tv|cc|uk|de|fr|es|it|nl|se|no|fi|dk|pl|cz|at|ch|be|pt|gr|hu|ro|bg|us|ca|au|jp|kr|in|cn|info|biz|app|dev|link|live|online|site|website|news|blog|megfa|irani|ebtedad|aparat|farabi|clash|ofis';

const TG_HOSTS = 't\\.me|telegram\\.me|telegram\\.dog|telegram\\.org|t\\.me';

const SHORTENERS =
  'bit\\.ly|tinyurl\\.com|is\\.gd|t\\.co|shorturl\\.at|ow\\.ly|buff\\.ly|shorte\\.st|adf\\.ly|rebrand\\.ly|cutt\\.ly';
const SOCIAL_DOMAINS =
  'instagram\\.com|wa\\.me|whatsapp\\.com|youtube\\.com|youtu\\.be|twitter\\.com|x\\.com|facebook\\.com|fb\\.me|linkedin\\.com|telegram\\.org|pinterest\\.com|tiktok\\.com|snapchat\\.com|aparat\\.com|eitaa\\.com|ebtedadnews\\.com|mayoonz\\.com';

const SOCIAL_PATH_RE = new RegExp(`\\b(?:${SOCIAL_DOMAINS}|${TG_HOSTS}|${SHORTENERS})\\b`, 'gi');
const INVITE_PATH_RE = /\b(?:joinchat|joinchannel|invite|\+join|addstickers)\/?\S*/gi;
const URL_LIKE_RE = new RegExp(
  `\\b(?:[a-z0-9-]+\\.)+(?:${DOMAIN_SUFFIXES})(?:/[\\w\\-./?%&=+#:@]*)?`,
  'gi'
);

/** A Telegram/chat handle such as `@name`. */
const HANDLE_RE = /@[\p{L}\p{N}_.]{3,64}/gu;

/**
 * Removes every external link and external channel identity from a post so it
 * can never reach the AI summarizer: URLs (absolute, `www.`, bare domains),
 * shortened and tracking links, social/Telegram/Eitaa hosts, invite links, QR
 * destinations and any `@handle` other than the trusted source channel.
 *
 * Legitimate news content (names, organisations, places, numbers, percentages,
 * dates, phone numbers) is left untouched.
 */
export function stripExternalIdentifiers(text: string, sourceUsername?: string | null): string {
  if (typeof text !== 'string' || text.length === 0) return '';

  const allowed = (sourceUsername ?? '').trim().replace(/^@/, '').toLowerCase();

  let out = text
    // Absolute URLs first, then scheme-less hosts, then handle-like domains.
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(INVITE_PATH_RE, ' ')
    .replace(SOCIAL_PATH_RE, ' ')
    .replace(SHORTENERS_RE(), ' ')
    .replace(URL_LIKE_RE, ' ');

  // Handles: keep only the trusted source channel identity.
  out = out.replace(HANDLE_RE, (match) => {
    const handle = match.slice(1).toLowerCase();
    if (allowed && handle === allowed) return ` @${handle}`;
    return ' ';
  });

  return out
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function SHORTENERS_RE(): RegExp {
  return new RegExp(`\\b(?:${SHORTENERS})\\b`, 'gi');
}

interface Signals {
  cta: number;
  promo: number;
  referral: boolean;
  register: boolean;
  gamblingTokens: number;
  gamblingPhrases: number;
  bettingUrl: boolean;
  contact: boolean;
  phone: boolean;
  url: boolean;
  commercialUrl: boolean;
  news: number;
}

/** Pure scoring step: raw text -> signal counts. Exported for tests. */
export function analyzeSignals(rawText: string): Signals {
  // Punctuation preserved here, otherwise "." and "/" would destroy URLs.
  const normalized = foldText(rawText);
  const set = tokens(normalizeText(rawText));
  const matchable = normalizeText(rawText);
  const urls = normalized.match(URL_RE) ?? [];
  const bettingUrl = urls.some((u) =>
    BETTING_URL_TOKENS.some((t) => u.includes(t))
  );

  return {
    cta: containsAny(matchable, CTA_PHRASES),
    promo: containsAny(matchable, PROMO_PHRASES),
    referral: containsAny(matchable, REFERRAL_PHRASES) > 0,
    register: containsAny(matchable, REGISTER_PHRASES) > 0,
    gamblingTokens: hasAnyToken(set, GAMBLING_TOKENS),
    gamblingPhrases: containsAny(matchable, GAMBLING_PHRASES),
    bettingUrl,
    contact: containsAny(matchable, CONTACT_PHRASES) > 0,
    phone: PHONE_RE.test(matchable),
    url: urls.length > 0,
    commercialUrl: urls.some((u) => COMMERCIAL_TLDS.some((tld) => u.includes(tld))),
    news: Math.min(2, containsAny(matchable, NEWS_PHRASES)),
  };
}

function scoreOf(s: Signals): number {
  let score = 0;
  const gamblingPresent = s.gamblingTokens > 0 || s.gamblingPhrases > 0;
  const gamblingAd = gamblingPresent && (s.promo > 0 || s.cta > 0 || s.referral || s.register || s.bettingUrl);

  if (s.referral) score += SCORE_REFERRAL;
  if (gamblingAd || s.bettingUrl) score += SCORE_GAMBLING_AD;
  else if (gamblingPresent) score += SCORE_GAMBLING_TERM;

  if (s.cta > 0) score += Math.min(SCORE_CTA_CAP, SCORE_CTA * s.cta);
  if (s.promo > 0) score += Math.min(SCORE_PROMO_CAP, SCORE_PROMO * s.promo);
  if (s.contact || s.phone) score += SCORE_CONTACT;
  if (s.url && (s.promo > 0 || s.cta > 0)) score += SCORE_PROMO_URL;
  if (s.commercialUrl && score === 0) score += SCORE_COMMERCIAL_URL;

  // Reportage context can only lower the score, never raise it.
  if (s.news >= 2) score *= NEWS_MITIGATION_TWO;
  else if (s.news === 1) score *= NEWS_MITIGATION_ONE;

  return Math.round(score);
}

function reasonOf(s: Signals): string | null {
  if (s.referral) return 'دعوت به معرفی دوست و دریافت پاداش';
  const gamblingPresent = s.gamblingTokens > 0 || s.gamblingPhrases > 0;
  if (gamblingPresent || s.bettingUrl) return 'محتوای تبلیغاتی شرط‌بندی یا کازینو';
  if (s.cta > 0 && (s.promo > 0 || s.url || s.contact || s.phone)) {
    return 'دعوت به خرید یا سفارش همراه با پیشنهاد تبلیغاتی';
  }
  if (s.cta > 0) return 'دعوت به خرید یا سفارش';
  if (s.promo > 0 && s.url) return 'پیشنهاد تبلیغاتی همراه با نشانی اینترنتی';
  if (s.promo > 0) return 'محتوای تبلیغاتی و پیشنهاد تخفیف';
  if (s.contact || s.phone) return 'اطلاعات تماس تجاری';
  return 'محتوای تبلیغاتی';
}

/**
 * Classifies one post. Deterministic, offline, and conservative: it prefers to
 * let borderline posts through rather than silently drop real news.
 */
export function detectAdvertisement(text: string): AdFilterResult {
  if (typeof text !== 'string') return { isAdvertisement: false, score: 0, reason: null };

  if (normalizeText(text).length === 0) return { isAdvertisement: false, score: 0, reason: null };

  const signals = analyzeSignals(text);
  const score = scoreOf(signals);
  const isAdvertisement = score >= ADVERTISEMENT_SCORE_THRESHOLD;

  return {
    isAdvertisement,
    score,
    reason: isAdvertisement ? reasonOf(signals) : null,
  };
}
