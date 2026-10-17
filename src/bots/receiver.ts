import { handleReceiverDeletionUpdate } from './receiver-delete.ts';
import { handleReceiverGroupsUpdate } from './receiver-groups.ts';

const BOT_API_FILE_LIMIT = 20 * 1024 * 1024;

// A file the owner sent: the largest photo size, or a document, video, audio or voice.
function ownerFile(message: any): { file_id: string; file_name: string; mime_type?: string; file_size?: number } | undefined {
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
  if (typeof photo?.file_id === 'string') return { ...photo, file_name: 'photo.jpg', mime_type: 'image/jpeg' };
  for (const [kind, name] of [['document', 'file'], ['video', 'video.mp4'], ['video_note', 'video.mp4'], ['audio', 'audio.mp3'], ['voice', 'voice.ogg']]) {
    const file = message[kind];
    if (typeof file?.file_id === 'string') return { ...file, file_name: typeof file.file_name === 'string' && file.file_name ? file.file_name : name };
  }
  return undefined;
}

type CollectionJob = { state?: string; mode?: string; last_error?: { code?: string; message?: string } };

function personalCollectionState(job?: CollectionJob, sourceStatus?: string): string {
  if (sourceStatus === 'paused' || job?.state === 'paused' || job?.state === 'cancelled') return 'сбор приостановлен';
  if (!job) return 'сбор ещё не начат';
  const error = job.last_error;
  if (job.state === 'waiting' || job.state === 'needs_attention') {
    const reason = error?.message?.includes('one-day collection limit') || error?.message?.includes('updates exceed collection limit')
      ? 'за один день больше 1000 сообщений, история не собрана полностью'
      : error?.code === 'rate_limited' ? 'ограничение Telegram'
      : error?.code === 'archive_corrupt' ? 'ошибка архива'
      : error?.code === 'upstream_incompatible' ? 'неожиданный ответ Telegram' : 'Telegram недоступен';
    return `${job.state === 'waiting' ? 'сбор временно не удался' : 'сбор остановлен'}: ${reason}`;
  }
  if (job.state === 'queued' || job.state === 'running') return job.mode === 'history' ? 'история собирается' : 'обновления собираются';
  return job.mode === 'history' ? 'история собрана, обновления будут проверяться' : 'обновления проверены';
}

export async function handleReceiverUpdate(
  update: unknown,
  ownerId: string,
  coordinator: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> },
  bot: { sendMessage?: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown>; answerCallbackQuery?: (id: string, options?: Record<string, unknown>) => Promise<unknown>; downloadFile?: (fileId: string) => Promise<Uint8Array> },
): Promise<void> {
  if (await handleReceiverDeletionUpdate(update, ownerId, coordinator, bot)) return;
  if (await handleReceiverGroupsUpdate(update, ownerId, coordinator, bot)) return;
  const callback = (update as { callback_query?: any })?.callback_query;
  if (callback) {
    if (String(callback.from?.id) !== ownerId || callback.message?.chat?.type !== 'private' || String(callback.message.chat.id) !== ownerId || typeof callback.data !== 'string') return;
    const [action, mode, ...parts] = callback.data.split(':');
    const ref = parts.join(':');
    const reference = /^[a-f0-9]{32}$/.test(ref) ? { ref_id: ref } : ref.startsWith('https://t.me/') ? { ref } : undefined;
    if (action === 's' && (mode === 'full' || mode === 'summary' || mode === 'personal_chat') && reference) {
      const result = await coordinator.callTool('source_add', { ...reference, mode }) as { success?: boolean; data?: { status?: string; job?: CollectionJob } };
      if (!result.success) throw new Error('Coordinator source add failed');
      await bot.sendMessage?.(ownerId, mode === 'personal_chat' ? `Переписка подключена: ${personalCollectionState(result.data?.job, result.data?.status)}` : 'Источник подключён', {});
    } else if (action === 'p' || action === 'c') {
      const source = [mode, ...parts].join(':');
      const sourceReference = /^[a-f0-9]{32}$/.test(source) ? { ref_id: source } : { ref: source };
      const result = await coordinator.callTool(action === 'p' ? 'collect_pause' : 'collect_cancel', sourceReference) as { success?: boolean };
      if (!result.success) throw new Error('Coordinator collection command failed');
      await bot.sendMessage?.(ownerId, action === 'p' ? 'Сбор приостановлен' : 'Сбор отменён', {});
    } else if (action === 'i' && (mode === '0' || mode === '1') && reference?.ref_id) {
      const result = await coordinator.callTool('source_settings_set', { ...reference, download_images: mode === '1' }) as { success?: boolean; data?: { title?: string } };
      if (!result.success) throw new Error('Coordinator source settings failed');
      await bot.sendMessage?.(ownerId, `Картинки ${result.data?.title ?? 'источника'}: ${mode === '1' ? 'включены' : 'выключены'}, действует со следующего сбора`, {});
    } else if (callback.data !== 's:none') {
      throw new Error('Invalid receiver callback');
    }
    if (typeof callback.id === 'string') await bot.answerCallbackQuery?.(callback.id);
    return;
  }
  const message = (update as { message?: any })?.message;
  if (!message || message.chat?.type !== 'private' || String(message.chat.id) !== ownerId || String(message.from?.id) !== ownerId || !Number.isSafeInteger(message.message_id) || message.message_id < 0 || !Number.isSafeInteger(message.date) || message.date < 0) return;
  const file = ownerFile(message);
  const text: string = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
  if (!text.trim() && !file) return;
  if (/^\/digest_time(?:\s|$)/i.test(text.trim())) {
    const value = text.trim().split(/\s+/);
    if (value.length !== 2 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value[1])) {
      await bot.sendMessage?.(ownerId, 'Укажите час сводки: /digest_time HH:MM', {});
      return;
    }
    const result = await coordinator.callTool('settings_set', { digest_time: value[1] }) as { success?: boolean };
    if (!result.success) throw new Error('Coordinator settings update failed');
    await bot.sendMessage?.(ownerId, `Время сводки ${value[1]} будет действовать со следующего дня`, {});
    return;
  }
  const command = /^\/(status|pause|cancel)(?:\s+(.+))?$/i.exec(text.trim());
  if (command?.[1].toLowerCase() === 'status') {
    const result = await coordinator.callTool('collect_status', {}) as { success?: boolean; data?: { sources?: Array<{ source?: { ref?: string; ref_id?: string; title?: string; status?: string; mode?: string; download_images?: boolean }; job?: CollectionJob }> } };
    if (!result.success) throw new Error('Coordinator status failed');
    const sources = result.data?.sources ?? [];
    const rows = sources.flatMap((item) => {
      const refId = item.source?.ref_id;
      const images = item.source?.mode === 'summary' ? [] : [{ text: `🖼 Картинки: ${item.source?.download_images ? 'вкл' : 'выкл'}`, callback_data: `i:${item.source?.download_images ? 0 : 1}:${refId}` }];
      return typeof refId === 'string' && /^[a-f0-9]{32}$/.test(refId) ? [[
        { text: `⏸ Пауза ${item.source?.title ?? item.source?.ref ?? 'источник'}`, callback_data: `p:${refId}` },
        { text: '✖️ Отменить', callback_data: `c:${refId}` },
        ...images,
      ]] : [];
    });
    const lines = sources.map((item) => `${item.source?.title ?? item.source?.ref ?? 'Источник'}: ${item.source?.status === 'paused' ? 'приостановлен' : 'подключён'} (${item.source?.mode === 'personal_chat' ? `личная переписка; ${personalCollectionState(item.job, item.source?.status)}` : item.source?.mode === 'summary' ? 'только сводка' : 'полный сбор'})`);
    await bot.sendMessage?.(ownerId, lines.length ? `Источники:\n${lines.join('\n')}` : 'Источники не подключены', { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (command) {
    const ref = command[2]?.trim();
    if (!ref || !/^https:\/\/t\.me\/\S+$/i.test(ref)) {
      await bot.sendMessage?.(ownerId, `Укажите ссылку: /${command[1].toLowerCase()} https://t.me/источник`, {});
      return;
    }
    const name = command[1].toLowerCase() === 'pause' ? 'collect_pause' : 'collect_cancel';
    const result = await coordinator.callTool(name, { ref }) as { success?: boolean };
    if (!result.success) throw new Error('Coordinator collection command failed');
    await bot.sendMessage?.(ownerId, name === 'collect_pause' ? 'Сбор приостановлен' : 'Сбор отменён', {});
    return;
  }
  const date = new Date(message.date * 1000);
  if (!Number.isFinite(date.getTime())) return;
  const rawEntities = Array.isArray(message.entities) ? message.entities : Array.isArray(message.caption_entities) ? message.caption_entities : [];
  const entities = rawEntities.flatMap((entity: any) => {
    if (!['url', 'mention', 'text_link'].includes(entity?.type)) return [];
    const value = entity.type === 'text_link' ? entity.url : text.slice(entity.offset, entity.offset + entity.length);
    return typeof value === 'string' ? [{ type: entity.type, value }] : [];
  });
  let attachment: { name: string; mime_type: string | null; base64: string } | undefined;
  if (file) {
    if ((file.file_size ?? 0) > BOT_API_FILE_LIMIT) { await bot.sendMessage?.(ownerId, 'Файл больше 20 МБ: Telegram не даёт боту его скачать', {}); return; }
    if (!bot.downloadFile) throw new Error('Bot API cannot download files');
    attachment = { name: file.file_name, mime_type: file.mime_type ?? null, base64: Buffer.from(await bot.downloadFile(file.file_id)).toString('base64') };
  }
  const result = await coordinator.callTool('inbox_save', {
    chat_id: ownerId,
    message_id: String(message.message_id),
    date: date.toISOString(),
    text,
    entities,
    ...(attachment ? { attachment } : {}),
    ...(Object.hasOwn(message, 'forward_origin') ? { forward_origin: message.forward_origin } : {}),
  }) as { success?: boolean; error?: { code?: string }; data?: { records?: Array<{ archive_id: string; short_id: string }>; offers?: Array<{ ref: string; ref_id: string; actions: string[] }>; web_failures?: Array<{ url: string; reason: string }>; deleted?: boolean } };
  if (result?.error?.code === 'unsupported_attachment') { await bot.sendMessage?.(ownerId, 'Формат не поддерживается, файл не сохранён', {}); return; }
  const shortId = result?.data?.records?.[0]?.short_id;
  if (!result?.success || typeof shortId !== 'string' || !/^[a-f0-9]{32}$/.test(shortId)) throw new Error('Coordinator did not save the message');
  if (!bot.sendMessage) throw new Error('Bot API cannot send a confirmation');
  if (result.data?.deleted) { await bot.sendMessage(ownerId, 'Запись уже удалена', {}); return; }
  const buttons = [[{ text: '🗑 Удалить', callback_data: shortId }]];
  for (const offer of result.data?.offers ?? []) {
    if (!/^[a-f0-9]{32}$/.test(offer.ref_id)) continue;
    if (offer.actions.includes('personal_chat')) {
      buttons.push([{ text: '👤 Подключить переписку', callback_data: `s:personal_chat:${offer.ref_id}` }, { text: '✖️ Не нужно', callback_data: 's:none' }]);
      continue;
    }
    buttons.push([
      { text: '📥 Собирать полностью', callback_data: `s:full:${offer.ref_id}` },
      { text: '📰 Только сводка', callback_data: `s:summary:${offer.ref_id}` },
      { text: '✖️ Не нужно', callback_data: 's:none' },
    ]);
  }
  const failures = result.data?.web_failures ?? [];
  const reply = failures.length ? `Заметка сохранена. Страницы не сохранены:\n${failures.map((item) => `${item.url}: ${item.reason}`).join('\n')}` : 'Сохранено';
  await bot.sendMessage(ownerId, reply, { reply_markup: { inline_keyboard: buttons } });
}
