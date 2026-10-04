import { insertMessages } from './channels';

export interface RssCollectReport { sources: number; succeeded: number; failed: number; inserted: number; }

interface FeedItem { title: string; description: string; link: string; date: string; }

/** Collects configured RSS sources into the same messages table as Telegram. */
export async function collectRss(db: D1Database, opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<RssCollectReport> {
  const { results } = await db.prepare(`SELECT id, name, feed_url, category FROM rss_sources WHERE enabled = 1 ORDER BY id`).all<{ id:number; name:string; feed_url:string; category:string }>();
  let succeeded = 0, failed = 0, inserted = 0;
  for (const source of results ?? []) {
    try {
      const response = await (opts.fetchImpl ?? fetch)(source.feed_url, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
      const items = parseFeed(await response.text()).slice(0, 30);
      const username = `rss_${source.id}`;
      const channel = await db.prepare(`SELECT id FROM channels WHERE channel_username = ?1`).bind(username).first<{id:number}>();
      let channelId = channel?.id;
      if (!channelId) {
        const created = await db.prepare(`INSERT INTO channels (channel_username, channel_title, enabled, source_type, feed_url) VALUES (?1, ?2, 1, 'rss', ?3)`).bind(username, source.name, source.feed_url).run();
        channelId = Number(created.meta.last_row_id);
      }
      const result = await insertMessages(db, channelId, items.map((item, index) => ({
        telegramMessageId: stableId(item.link || `${source.id}:${index}`),
        messageDate: item.date || new Date(opts.now ?? Date.now()).toISOString(),
        messageText: [item.title, item.description].filter(Boolean).join('\n'),
        sourceUrl: item.link || source.feed_url,
      })));
      inserted += result.inserted; succeeded++;
      await db.prepare(`UPDATE rss_sources SET last_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`).bind(source.id).run();
    } catch (error) { failed++; console.error(JSON.stringify({ event:'rss-collect', source: source.name, error: error instanceof Error ? error.message : String(error) })); }
  }
  return { sources: (results ?? []).length, succeeded, failed, inserted };
}

function stableId(value: string): number { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h || 1); }
function decode(value: string): string { return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim(); }
function tag(xml: string, name: string): string { const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return match ? decode(match[1].replace(/<[^>]+>/g, ' ')) : ''; }
function parseFeed(xml: string): FeedItem[] { return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m => ({ title: tag(m[1], 'title'), description: tag(m[1], 'description'), link: tag(m[1], 'link'), date: tag(m[1], 'pubDate') || tag(m[1], 'published') })).filter(i => i.title && i.link); }
