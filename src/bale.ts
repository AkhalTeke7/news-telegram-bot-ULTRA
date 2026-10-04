/** Minimal Bale Business Bot API transport. Tokens are never logged. */
const BALE_API = 'https://tapi.bale.ai/business/bot';

export async function baleSendMessage(opts: { token: string; chatId: string; text: string; fetchImpl?: typeof fetch }): Promise<void> {
  await call('sendMessage', opts.token, { chat_id: opts.chatId, text: opts.text }, opts.fetchImpl);
}

export async function baleSendPhoto(opts: { token: string; chatId: string; photo: ArrayBuffer; caption?: string; fetchImpl?: typeof fetch }): Promise<void> {
  const body = new FormData();
  body.append('chat_id', opts.chatId);
  if (opts.caption) body.append('caption', opts.caption);
  body.append('photo', new Blob([opts.photo], { type: 'image/png' }), 'news.png');
  const response = await (opts.fetchImpl ?? fetch)(`${BALE_API}${encodeURIComponent(opts.token)}/sendPhoto`, { method: 'POST', body });
  if (!response.ok) throw new Error(`Bale sendPhoto failed with HTTP ${response.status}`);
}

async function call(method: string, token: string, payload: Record<string, unknown>, fetchImpl = fetch): Promise<void> {
  const response = await fetchImpl(`${BALE_API}${encodeURIComponent(token)}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Bale ${method} failed with HTTP ${response.status}`);
}
