import { describe, expect, it } from 'vitest';
import {
  buildSlideHtml,
  clampChars,
  escapeHtml,
  highlight,
  isSafeImageUrl,
  MAX_SLIDES,
  slideCounter,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
} from '../src/slideshow/slideTemplate';

const baseInput = {
  index: 3,
  total: 10,
  category: { emoji: '💰', label: 'اقتصاد' },
  headline: 'نرخ بهره بدون تغییر ماند',
  summary: 'فدرال رزرو نرخ بهره را ثابت نگه داشت و از احتمال کاهش در نشست بعدی گفت.',
  keywords: ['نرخ بهره'],
  imageUrl: 'https://example.com/a.jpg',
  sourceName: 'رویترز',
  brandName: 'اخبار فوری',
  stamp: '۱۳ مهر ۱۴۰۵ — ۱۱:۴۵',
};

describe('slide geometry', () => {
  it('is the 1080x1350 portrait the spec asks for', () => {
    expect(SLIDE_WIDTH).toBe(1080);
    expect(SLIDE_HEIGHT).toBe(1350);
    // Six pictures of two news each: the 12 top stories of a run.
    expect(MAX_SLIDES).toBe(6);
  });
});

describe('escapeHtml', () => {
  it('neutralizes every character that could break out of markup', () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;'
    );
  });

  it('is applied to every untrusted field of a slide', () => {
    const html = buildSlideHtml({
      ...baseInput,
      headline: '<img src=x onerror=alert(1)>',
      summary: '</p><script>bad()</script>',
      sourceName: '<b>evil</b>',
      brandName: '<i>brand</i>',
      keywords: [],
    });
    expect(html).not.toContain('<script>bad()');
    // The payload survives as inert TEXT (so `onerror=alert(1)` still appears
    // as characters) but never as a tag the browser would parse.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  });
});

describe('highlight', () => {
  it('wraps a verbatim keyword in <mark>', () => {
    expect(highlight('نرخ بهره ثابت ماند', ['نرخ بهره'])).toBe(
      '<mark>نرخ بهره</mark> ثابت ماند'
    );
  });

  it('escapes first, so a keyword can never inject markup', () => {
    const out = highlight('<b>x</b> نرخ', ['نرخ']);
    expect(out).toBe('&lt;b&gt;x&lt;/b&gt; <mark>نرخ</mark>');
  });

  it('prefers the longest keyword and never nests marks', () => {
    const out = highlight('بانک مرکزی اروپا تصمیم گرفت', ['بانک مرکزی', 'بانک مرکزی اروپا']);
    expect(out).toBe('<mark>بانک مرکزی اروپا</mark> تصمیم گرفت');
    expect(out.match(/<mark>/g)).toHaveLength(1);
  });

  it('marks every occurrence of a repeated keyword', () => {
    const out = highlight('طلا و باز هم طلا', ['طلا']);
    expect(out.match(/<mark>طلا<\/mark>/g)).toHaveLength(2);
  });

  it('ignores keywords that are not present verbatim', () => {
    expect(highlight('نرخ بهره', ['تورم'])).toBe('نرخ بهره');
  });

  it('returns escaped text when there are no keywords', () => {
    expect(highlight('a & b', [])).toBe('a &amp; b');
  });
});

describe('clampChars', () => {
  it('leaves short text untouched', () => {
    expect(clampChars('کوتاه', 50)).toBe('کوتاه');
  });

  it('truncates with an ellipsis and never exceeds the limit', () => {
    const out = clampChars('x'.repeat(100), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('slideCounter', () => {
  it('renders Persian digits as ۳/۱۰', () => {
    expect(slideCounter(3, 10)).toBe('۳/۱۰');
  });
});

describe('isSafeImageUrl', () => {
  it('accepts http(s) only', () => {
    expect(isSafeImageUrl('https://a.test/x.jpg')).toBe(true);
    expect(isSafeImageUrl('http://a.test/x.jpg')).toBe(true);
  });

  it('rejects javascript:, data: and garbage', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeImageUrl('not a url')).toBe(false);
    expect(isSafeImageUrl(null)).toBe(false);
  });
});

describe('buildSlideHtml', () => {
  const html = buildSlideHtml(baseInput);

  it('is a complete RTL Persian document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="fa" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('embeds both Vazirmatn weights as base64 and loads no remote font', () => {
    expect(html).toContain("font-family:'Vazirmatn'");
    expect(html.match(/src:url\(data:font\/woff2;base64,/g)).toHaveLength(2);
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('pins the page to the slide size so the screenshot is exact', () => {
    expect(html).toContain('width:1080px;height:1350px');
  });

  it('clamps the summary to four lines and the headline to three', () => {
    expect(html).toMatch(/p\.sum\{[^}]*-webkit-line-clamp:4/s);
    expect(html).toMatch(/h1\{[^}]*-webkit-line-clamp:3/s);
    // overflow:hidden is what makes the clamp a hard guarantee
    expect(html).toMatch(/p\.sum\{[^}]*overflow:hidden/s);
  });

  it('shows the live pill, the Jalali stamp, source, brand and counter', () => {
    expect(html).toContain('class="live"');
    expect(html).toContain('۱۳ مهر ۱۴۰۵ — ۱۱:۴۵');
    expect(html).toContain('منبع: رویترز');
    expect(html).toContain('اخبار فوری');
    expect(html).toContain('۳/۱۰');
  });

  it('renders the og:image over the placeholder, with a self-removing fallback', () => {
    expect(html).toContain('https://example.com/a.jpg');
    // If the photo 404s at render time the <img> removes itself and the
    // gradient placeholder underneath shows through.
    expect(html).toContain('onerror="this.remove()"');
  });

  it('falls back to the category icon when there is no image', () => {
    const noImage = buildSlideHtml({ ...baseInput, imageUrl: null });
    expect(noImage).not.toContain('class="shot"');
    expect(noImage).toContain('class="ghost"');
    expect(noImage).toContain('💰');
  });

  it('drops an unsafe image url instead of rendering it', () => {
    const unsafe = buildSlideHtml({ ...baseInput, imageUrl: 'javascript:alert(1)' });
    expect(unsafe).not.toContain('javascript:alert');
    expect(unsafe).not.toContain('class="shot"');
  });

  it('highlights keywords inside the rendered summary', () => {
    expect(html).toContain('<mark>نرخ بهره</mark>');
  });
});
