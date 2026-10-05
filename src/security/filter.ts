/**
 * TASK 6 — the relevance filter.
 *
 * The channel is for writeups that explain how a bug was found and how it was
 * exploited. Three of the six feeds do not publish that, so this module is
 * what stops the channel from degenerating into a git changelog.
 *
 * Everything here is deterministic string work: no LLM call, no network. That
 * matters, because the noise arrives in far greater volume than the signal
 * and spending budget to reject "Update sponsors logo" would be absurd.
 *
 * Two gates, applied in order:
 *   1. NOISE   — reject outright (merge commits, typo fixes, sponsor changes,
 *                CI chores, corporate posts).
 *   2. SIGNAL  — for `repo` and `exploit` sources only, require at least one
 *                recognizable vulnerability/technique term. Writeup sources
 *                skip this gate: a good writeup may be titled "The moment it
 *                clicked" and a keyword list would throw it away.
 */

import type { SecuritySource } from './sources';

/**
 * Commit-log and blog housekeeping.
 *
 * Ordered roughly by how often each fires against the real feeds. Anchored
 * with ^ where possible so a legitimate title that merely mentions the word
 * ("Fixing broken access control") is not caught by the "broken" rule.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  // Merge commits duplicate the substantive commit they merge.
  /^merge (pull request|branch|remote-tracking)/i,
  /^merge\b.*\binto\b/i,
  // Automation chatter.
  /^run auto-merge/i,
  /schedule at minute/i,
  /^(bump|chore|ci|build|style|refactor)[(:]/i,
  /^(update|bump) (dependencies|deps|submodule)/i,
  /dependabot/i,
  /^pre-commit/i,
  /^\[?(github )?actions?\]?:/i,
  // Cosmetic edits.
  /^fix(ing)? (a )?typos?\b/i,
  /\btypos?\b.*→/i,
  /^fix (grammar|spelling|format(ting)?|indentation|whitespace|markdown)/i,
  /^(update|fix) (broken )?links?$/i,
  /^fix broken links/i,
  /^(update|add|remove|fix) (the )?(sponsors?|logo|banner|badge|image|favicon)/i,
  /\bsponsor\b/i,
  /^update (readme|contributing|license|changelog|references? date)/i,
  /^(update|fix) contribution guide/i,
  /^normalize (commands|formatting)/i,
  /^markdown table fix/i,
  // Release/version bookkeeping, not research.
  /^v?\d+\.\d+\.\d+$/,
  /^release \d/i,
];

/**
 * Vulnerability classes, attack techniques and tooling terms.
 *
 * Deliberately broad: this gate only has to prove an item is *about security
 * technique* rather than about repository maintenance. Precision comes later,
 * from the LLM selection step.
 */
const SIGNAL_TERMS: readonly string[] = [
  // Injection family
  'sqli', 'sql injection', 'nosql', 'command injection', 'code injection',
  'ssti', 'csti', 'template injection', 'xxe', 'ldap injection', 'crlf',
  'log4', 'expression language', 'el injection', 'graphql injection',
  // Client side
  'xss', 'cross-site scripting', 'csrf', 'cross-site request', 'clickjacking',
  'dom clobbering', 'prototype pollution', 'postmessage', 'cors',
  'xs-search', 'xs-leak', 'cspt', 'client-side path traversal',
  // Server side
  'ssrf', 'server-side request', 'lfi', 'rfi', 'file inclusion',
  'path traversal', 'directory traversal', 'traversal', 'file upload',
  'deserialization', 'unserialize', 'pickle', 'gadget chain',
  'request smuggling', 'desync', 'cache poisoning', 'cache deception',
  'host header', 'dns rebinding', 'open redirect',
  // Auth / access
  'idor', 'bola', 'broken access', 'privilege escalation', 'privesc',
  'auth bypass', 'authentication bypass', 'authorization bypass',
  'account takeover', 'subdomain takeover', 'session fixation',
  'oauth', 'saml', 'jwt', 'oidc', 'sso', 'mfa bypass', '2fa bypass',
  'mass assignment', 'race condition', 'toctou',
  // Binary / low level
  'buffer overflow', 'stack overflow', 'heap', 'use-after-free', 'uaf',
  'rop', 'format string', 'off-by-one', 'integer overflow', 'libc',
  'binary exploitation', 'shellcode', 'kernel exploit', 'sandbox escape',
  'house of',
  // Generic exploitation vocabulary
  'rce', 'remote code execution', 'arbitrary file', 'arbitrary code',
  'exploit', 'payload', 'poc', 'proof of concept', 'bypass', '0day',
  'zero-day', 'zeroday', 'cve-', 'vulnerab', 'misconfigur', 'takeover',
  'injection', 'leak', 'disclosure', 'escalation', 'smuggling',
  'poisoning', 'pollution', 'overflow', 'hijack', 'spoof',
  // Practice / tooling
  'waf', 'fuzzing', 'fuzzer', 'recon', 'enumeration', 'bruteforce',
  'webshell', 'pentest', 'bug bounty', 'bounty', 'red team', 'wordlist',
  'burp', 'nuclei', 'ffuf', 'sqlmap', 'metasploit', 'frida',
  // Platform / surface words that appear in HackTricks paths
  'pentesting-web', 'binary-exploitation', 'mobile-pentesting',
  'network-services', 'reversing', 'android', 'ios', 'active directory',
  'kerberos', 'ntlm', 'smb', 'ldap', 'cloud', 'aws', 'azure', 'gcp',
  'kubernetes', 'docker', 'container escape',
];

/** HackTricks bot commits name the page they touched: `src/<area>/<page>`. */
const REPO_PATH_RE = /\bsrc\/[a-z0-9][a-z0-9._/-]{3,}/gi;

export interface FilterInput {
  title: string;
  link: string;
  description: string;
}

export type RejectReason = 'noise' | 'excluded_path' | 'no_signal' | 'too_short';

export interface FilterVerdict {
  keep: boolean;
  reason?: RejectReason;
  /** For repo commits: the reference page the commit touched, if named. */
  referencePath?: string;
}

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when the text mentions any recognized security term. */
export function hasSecuritySignal(text: string): boolean {
  const haystack = normalize(text);
  return SIGNAL_TERMS.some((term) => haystack.includes(term));
}

/** True when the title is repository housekeeping rather than research. */
export function isNoise(title: string): boolean {
  const candidate = title.trim();
  return NOISE_PATTERNS.some((pattern) => pattern.test(candidate));
}

/**
 * Extracts the reference page a HackTricks/PayloadsAllTheThings commit
 * touched, so the digest can say "pentesting-web/file-upload" instead of
 * repeating a truncated commit subject.
 */
export function extractReferencePath(text: string): string | undefined {
  // GitHub truncates long commit subjects with an ellipsis, so the title may
  // hold `src/pentesting-web/client-...` while the <content> body holds the
  // whole path. Take the LONGEST match rather than the first.
  const matches = [...text.matchAll(REPO_PATH_RE)].map((entry) => entry[0]);
  if (matches.length === 0) return undefined;
  const longest = matches.reduce((best, current) =>
    current.length > best.length ? current : best
  );
  return longest
    .replace(/^src\//i, '')
    .replace(/\/(README|index)(\.md)?$/i, '')
    .replace(/\.md$/i, '')
    .replace(/\.{3}$/, '')
    .replace(/…$/, '')
    .slice(0, 80);
}

/**
 * Decides whether one feed entry belongs in the digest.
 *
 * `source.kind` drives how strict this is — see the module header.
 */
export function evaluate(entry: FilterInput, source: SecuritySource): FilterVerdict {
  const title = entry.title.trim();
  if (title.length < 8) return { keep: false, reason: 'too_short' };

  // 1. Path exclusions (corporate sections of an otherwise technical blog).
  const link = entry.link.toLowerCase();
  for (const fragment of source.excludePathFragments ?? []) {
    if (link.includes(fragment.toLowerCase())) {
      return { keep: false, reason: 'excluded_path' };
    }
  }

  // 2. Housekeeping noise. Only meaningful for commit logs, but a blog post
  //    titled "Fix broken links" would be noise there too.
  if (isNoise(title)) return { keep: false, reason: 'noise' };

  // 3. Signal gate — repo and exploit feeds only.
  if (source.kind === 'writeup') {
    return { keep: true };
  }

  const referencePath = extractReferencePath(`${title} ${entry.description}`);
  const signalText = `${title} ${entry.description} ${referencePath ?? ''}`;
  if (!hasSecuritySignal(signalText)) {
    return { keep: false, reason: 'no_signal' };
  }

  return { keep: true, referencePath };
}
