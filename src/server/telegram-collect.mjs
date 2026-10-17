import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const MEDIA_TYPES = { photo: 'image', document: 'document', video: 'video', video_note: 'video', gif: 'video', voice: 'audio', audio: 'audio', sticker: 'sticker' };

// Vendor list_messages labels media ("photo", "document: name", "sticker 😀"); nothing is downloaded here.
function mediaMark(label) {
  if (typeof label !== 'string' || !label) return [];
  const [, kind, name = ''] = /^(\w+)(?::\s*(.*))?/.exec(label) ?? [];
  return [{ type: MEDIA_TYPES[kind] ?? 'other', name: kind === 'document' ? name : '', state: 'skipped' }];
}

// Photo of a source with download_images on: telegram-mcp writes it under the shared
// exchange directory, the file is read into the archive and removed. A failure keeps
// the message and marks the image unavailable.
async function downloadPhoto(callTool, chatId, messageId, exchangeDir) {
  const requested = join(exchangeDir, `${randomUUID()}.jpg`);
  let saved = requested;
  try {
    const response = await callTool('download_media', { chat_id: chatId, message_id: messageId, file_path: requested });
    const text = String(response?.result ?? response?.data ?? response);
    const path = /^Media downloaded to (.+)\.$/.exec(text)?.[1];
    if (!path || !resolve(path).startsWith(resolve(exchangeDir) + sep)) throw new Error('download_media failed');
    saved = path;
    const data = await readFile(saved);
    return { type: 'image', name: `photo${saved.slice(saved.lastIndexOf('.'))}`, data, mimeType: 'image/jpeg' };
  } catch {
    return { type: 'image', name: '', state: 'unavailable' };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

export async function collectTelegramPage(callTool, { source, cursor, limit, mode, exchangeDir = '/exchange' }) {
  const boundary = mode === 'history' && cursor?.startsWith('boundary:') ? cursor.slice(9) : null;
  const from = mode === 'history' ? boundary ?? (cursor?.startsWith('from:') ? cursor.slice(5) : '1970-01-01') : cursor?.slice(0, 10);
  const args = { chat_id: source.chatId, limit, ...(from ? { from_date: from } : {}), ...(boundary ? { to_date: boundary } : {}) };
  const response = await callTool('list_messages', args);
  const raw = response?.result ?? response?.data ?? response;
  if (typeof raw === 'string' && raw.startsWith('No messages found')) return { messages: [], nextCursor: mode === 'history' && cursor?.startsWith('from:') ? `${from}T00:00:00.000Z` : cursor, done: true };
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error('Telegram returned an invalid collection page'); }
  if (!value || !Array.isArray(value.results)) throw new Error('Telegram returned an invalid collection page');
  const messages = await Promise.all(value.results.map(async (row) => {
    if (!row || !Number.isSafeInteger(row.id) || typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date)) || typeof row.text !== 'string') throw new Error('Telegram returned an invalid message');
    return {
      id: row.id, text: row.text, publishedAt: row.date,
      sourceName: source.title, sourceUsername: source.username,
      attachments: source.downloadImages && row.media === 'photo' ? [await downloadPhoto(callTool, args.chat_id, row.id, exchangeDir)] : mediaMark(row.media),
      extra: { sender: row.sender },
    };
  }));
  const latest = messages.map((message) => message.publishedAt).sort().at(-1);
  if (boundary) {
    // ponytail: list_messages has no page token within a day; stop explicitly if one day reaches the limit.
    if (messages.length >= limit) throw new Error('Telegram history exceeds one-day collection limit');
    const nextDay = new Date(Date.parse(`${boundary}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return { messages, nextCursor: `from:${nextDay}`, done: false };
  }
  if (mode === 'history' && messages.length >= limit && latest) return { messages, nextCursor: `boundary:${latest.slice(0, 10)}`, done: false };
  if (mode === 'updates' && messages.length >= limit) throw new Error('Telegram updates exceed collection limit');
  return { messages, nextCursor: latest ?? cursor, done: true };
}
