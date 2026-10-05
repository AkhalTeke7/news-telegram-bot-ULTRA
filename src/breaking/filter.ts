/**
 * Stage 1 of the breaking-news pipeline: the keyword pre-filter.
 *
 * Its only job is to decide what is worth spending an LLM call on. It runs on
 * every item of every feed every 5 minutes, so it is pure string work: no
 * network, no database, no model.
 *
 * It is deliberately generous (recall over precision). The LLM scorer and the
 * score threshold do the hard filtering afterwards; this stage only has to
 * avoid sending obvious noise — sports results, celebrity news, product
 * reviews — to the model.
 */

export interface KeywordHit {
  term: string;
  weight: number;
}

export interface FilterResult {
  passed: boolean;
  /** Pre-filter score, before cross-source confirmation. */
  score: number;
  hits: KeywordHit[];
}

/**
 * Market-moving vocabulary, weighted by how reliably the term signals a
 * market event rather than ordinary coverage.
 *
 * Weight 3: the term alone is usually enough (a central bank decision).
 * Weight 2: strong, but needs company (an asset name, a verb of change).
 * Weight 1: supporting context.
 */
const KEYWORDS: { terms: string[]; weight: number }[] = [
  // --- monetary policy -----------------------------------------------------
  {
    weight: 3,
    terms: [
      'rate decision', 'interest rate decision', 'rate cut', 'rate hike', 'raises rates',
      'cuts rates', 'fomc', 'federal reserve', 'fed chair', 'jerome powell', 'ecb', 'bank of japan',
      'boj', 'bank of england', 'pboc', 'snb', 'rba', 'monetary policy', 'quantitative easing',
      'emergency meeting', 'emergency rate',
    ],
  },
  // --- macro prints --------------------------------------------------------
  {
    weight: 3,
    terms: [
      'cpi', 'inflation data', 'core inflation', 'nonfarm payrolls', 'non-farm payrolls', 'nfp',
      'jobs report', 'unemployment rate', 'gdp growth', 'ppi', 'pce',
    ],
  },
  // --- energy --------------------------------------------------------------
  {
    weight: 3,
    terms: [
      'opec', 'opec+', 'opec-jmmc', 'production cut', 'output cut', 'oil embargo', 'export ban',
      'strategic reserve', 'spr release', 'pipeline attack', 'refinery fire',
    ],
  },
  // --- geopolitics / risk --------------------------------------------------
  {
    weight: 3,
    terms: [
      'declares war', 'invasion', 'airstrike', 'missile strike', 'nuclear', 'ceasefire',
      'sanctions', 'sanction package', 'blockade', 'strait of hormuz', 'coup', 'martial law',
      'state of emergency', 'terror attack',
    ],
  },
  // --- credit / solvency ---------------------------------------------------
  {
    weight: 3,
    terms: [
      'default', 'defaults on', 'bailout', 'bank run', 'bank collapse', 'bankruptcy',
      'credit rating', 'downgrade', 'debt ceiling', 'government shutdown', 'contagion',
    ],
  },
  // --- assets --------------------------------------------------------------
  {
    weight: 2,
    terms: [
      'gold price', 'gold hits', 'oil price', 'crude', 'brent', 'wti', 'treasury yields',
      'bond yields', 'dollar index', 'the dollar', 'euro hits', 'yen', 'bitcoin', 'stocks plunge',
      'stocks surge', 'wall street', 's&p 500', 'nasdaq', 'dow jones',
    ],
  },
  // --- trade / tariffs -----------------------------------------------------
  {
    weight: 2,
    terms: ['tariff', 'trade war', 'trade deal', 'import duty', 'export controls', 'embargo'],
  },
  // --- verbs of violent change --------------------------------------------
  {
    weight: 1,
    terms: [
      'plunge', 'plunges', 'surge', 'surges', 'soars', 'tumbles', 'crashes', 'record high',
      'record low', 'all-time high', 'halts trading', 'suspended trading', 'sell-off', 'selloff',
      'rattles markets', 'slump',
    ],
  },
  // --- urgency markers -----------------------------------------------------
  { weight: 1, terms: ['breaking', 'urgent', 'just in', 'emergency'] },
];

/**
 * Topics that are never market-moving for this channel.
 *
 * A single veto term drops the item before scoring. Each is checked as a
 * whole phrase, so "match" in "matched the forecast" is not a football match.
 */
const VETO = [
  'premier league', 'champions league', 'world cup', 'nba', 'nfl draft', 'box office',
  'celebrity', 'royal family', 'recipe', 'horoscope', 'gift guide', 'best deals',
  'how to watch', 'top analysts are upbeat', 'watch collection',
];

/** Minimum pre-filter score to be worth an LLM call. */
export const DEFAULT_PREFILTER_THRESHOLD = 3;

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * Scores one item. `title` carries full weight; `description` contributes at
 * half, since a passing mention in the body is weaker evidence than a
 * headline.
 */
export function prefilter(
  title: string,
  description = '',
  threshold = DEFAULT_PREFILTER_THRESHOLD
): FilterResult {
  const headline = normalize(title);
  const body = normalize(description);

  for (const veto of VETO) {
    if (headline.includes(veto)) return { passed: false, score: 0, hits: [] };
  }

  const hits: KeywordHit[] = [];
  let score = 0;
  const seen = new Set<string>();

  for (const group of KEYWORDS) {
    for (const term of group.terms) {
      if (seen.has(term)) continue;
      if (headline.includes(term)) {
        seen.add(term);
        hits.push({ term, weight: group.weight });
        score += group.weight;
      } else if (body.includes(term)) {
        seen.add(term);
        hits.push({ term, weight: group.weight / 2 });
        score += group.weight / 2;
      }
    }
  }

  return { passed: score >= threshold, score, hits };
}
