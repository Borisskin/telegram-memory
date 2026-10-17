import type { Archive, AttachmentInput } from './archive.ts';
import type { ResolvedTelegramSource } from './coordinator.ts';

type Forward = { from_user_id?: string; sender_name?: string; chat_username?: string };
type InboxMessage = { chatId: string; messageId: string; date: string; text: string; attachment?: AttachmentInput; entities?: Array<{ type: string; value: string }>; forwardOrigin?: unknown; forwarded?: boolean };

function forwardDetails(origin: unknown): Forward | undefined {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return undefined;
  const value = origin as { type?: unknown; sender_user?: { id?: unknown }; sender_user_name?: unknown; chat?: { username?: unknown } };
  if (value.type === 'user') return { from_user_id: String(value.sender_user?.id ?? '') };
  if (value.type === 'hidden_user') return { sender_name: String(value.sender_user_name ?? '') };
  if (value.type === 'channel' || value.type === 'chat') return { chat_username: typeof value.chat?.username === 'string' ? value.chat.username : undefined };
  return {};
}

function telegramRef(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())) return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    const handle = segments[0] === 's' ? segments[1] : segments[0];
    return handle && /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(handle) ? `https://t.me/${handle}` : undefined;
  } catch { return undefined; }
}

export async function inboxSave(
  archive: Archive,
  ownerId: string,
  message: InboxMessage,
  boundaries: {
    webSave?: (url: string) => Promise<unknown>;
    resolveSource: (ref: string) => Promise<ResolvedTelegramSource> | ResolvedTelegramSource;
    sourceExists: (chatId: string) => boolean;
  },
) {
  const forward = forwardDetails(message.forwardOrigin);
  const saved = archive.savePersonal({
    ownerId,
    placement: message.forwarded ? 'forwards' : 'notes',
    text: message.text,
    operationId: `receiver:${message.chatId}:${message.messageId}`,
    receivedAt: message.date,
    ...(message.attachment ? { attachments: [message.attachment] } : {}),
    ...(message.forwarded ? { fromUserId: forward?.from_user_id ?? null, senderName: forward?.sender_name ?? null } : {}),
  });
  if (archive.read(saved.archiveId).metadata.status === 'deleted') return { records: [{ archive_id: saved.archiveId }], offers: [], web_failures: [], deleted: true };
  const records = [{ archive_id: saved.archiveId }];
  const webFailures: Array<{ url: string; reason: string }> = [];
  const values = [message.text, ...(message.entities ?? []).map((entity) => entity.value)];
  const urls = [...new Set(values.flatMap((value) => value.match(/https?:\/\/[^\s<>]+/g) ?? []).map((url) => url.replace(/[.,!?;:)]+$/, '')))];
  for (const url of urls) {
    if (/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i.test(url)) continue;
    let response: { success?: boolean; data?: { archiveId?: string }; error?: string } | undefined;
    try { response = await boundaries.webSave?.(url) as typeof response; }
    catch { /* The note remains saved; report the failed page below. */ }
    if (response?.success && response.data?.archiveId) records.push({ archive_id: response.data.archiveId });
    else {
      const reasons: Record<string, string> = {
        unsafe_url: 'ссылка отклонена правилами безопасности',
        unsupported_content: 'это не веб-страница',
        content_too_large: 'страница слишком велика',
        timeout: 'истекло время ожидания',
        javascript_required: 'страница требует JavaScript',
        empty_article: 'не удалось извлечь текст',
      };
      webFailures.push({ url, reason: reasons[response?.error ?? ''] ?? 'не удалось сохранить страницу' });
    }
  }
  const refs = new Set<string>();
  for (const url of urls) {
    const ref = telegramRef(url);
    if (ref) refs.add(ref);
  }
  for (const value of values) for (const match of value.matchAll(/(^|[^\p{L}\p{N}._%+-])@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/gu)) refs.add(`https://t.me/${match[2]}`);
  if (forward?.from_user_id && /^\d+$/.test(forward.from_user_id)) refs.add(forward.from_user_id);
  if (forward?.chat_username) {
    const ref = telegramRef(`https://t.me/${forward.chat_username.replace(/^@/, '')}`);
    if (ref) refs.add(ref);
  }
  const offers: Array<{ ref: string; kind: 'channel' | 'group' | 'person'; actions: Array<'full' | 'summary' | 'personal_chat' | 'none'> }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    try {
      const source = await boundaries.resolveSource(ref);
      const chatId = String(source.chatId);
      if (!['channel', 'group', 'user', 'private'].includes(source.kind) || seen.has(chatId) || boundaries.sourceExists(chatId)) continue;
      seen.add(chatId);
      offers.push(source.kind === 'user' || source.kind === 'private'
        ? { ref, kind: 'person', actions: ['personal_chat', 'none'] }
        : { ref, kind: source.kind, actions: ['full', 'summary', 'none'] });
    } catch { /* An unavailable Telegram reference does not block saving the message. */ }
  }
  return { records, offers, web_failures: webFailures };
}
