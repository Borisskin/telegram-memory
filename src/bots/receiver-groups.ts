type Coordinator = { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
type Bot = {
  sendMessage?: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown>;
  answerCallbackQuery?: (id: string, options?: Record<string, unknown>) => Promise<unknown>;
};
type Source = { ref: string; ref_id: string; chat_id: string; title?: string; kind: string; mode: string };
type Grant = { chat_id: string; access: 'none' | 'all_shared' | string[] };
type Group = { chat_id: string; title: string; delivery_id?: number };

async function data<T>(coordinator: Coordinator, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await coordinator.callTool(name, args) as { success?: boolean; data?: T };
  if (!result?.success) throw new Error(`Coordinator ${name} failed`);
  return result.data as T;
}

async function controls(coordinator: Coordinator, chatId: string, title: string) {
  const [grants, status] = await Promise.all([
    data<Grant[]>(coordinator, 'chat_access_list', { chat_id: chatId }),
    data<{ sources: Array<{ source: Source }> }>(coordinator, 'collect_status', {}),
  ]);
  const access = grants[0]?.access ?? 'none';
  const sources = status.sources.map((item) => item.source).filter((source) => source.mode === 'full' && source.kind === 'channel');
  const prefix = `g:${chatId}:`;
  const buttons = [
    [{ text: `${access === 'none' ? '✓ ' : ''}Нет доступа`, callback_data: `${prefix}none` }],
    [{ text: `${access === 'all_shared' ? '✓ ' : ''}Вся общая память`, callback_data: `${prefix}all` }],
    ...sources.map((source) => [{ text: `${Array.isArray(access) && (access.includes(source.ref) || access.includes(source.chat_id)) ? '✓ ' : ''}${source.title ?? source.ref}`, callback_data: `${prefix}s:${source.ref_id}` }]),
  ];
  return { text: `Доступ группы «${title}»\n${sources.length ? 'Выберите каналы ниже' : 'Каналы пока не подключены'}`, options: { reply_markup: { inline_keyboard: buttons } } };
}

export async function deliverGroupAlerts(ownerId: string, coordinator: Coordinator, bot: Bot): Promise<void> {
  const alerts = await data<Group[]>(coordinator, 'alerts_take', {});
  if (!bot.sendMessage) throw new Error('Bot API cannot deliver alerts');
  for (const group of alerts) {
    if (group.chat_id.startsWith('notebook_auth:')) await bot.sendMessage(ownerId, group.title, {});
    else {
      const view = await controls(coordinator, group.chat_id, group.title);
      await bot.sendMessage(ownerId, view.text, view.options);
    }
    const ack = await data<{ acknowledged: boolean }>(coordinator, 'alerts_ack', { chat_id: group.chat_id, delivery_id: group.delivery_id });
    if (!ack.acknowledged) throw new Error('Coordinator did not confirm alert delivery');
  }
}

export async function handleReceiverGroupsUpdate(update: unknown, ownerId: string, coordinator: Coordinator, bot: Bot): Promise<boolean> {
  const input = update as { message?: any; callback_query?: any };
  const callback = input.callback_query;
  const message = input.message;
  const actor = callback ?? message;
  const chat = callback?.message?.chat ?? message?.chat;
  if (chat?.type !== 'private' || String(chat.id) !== ownerId || String(actor?.from?.id) !== ownerId) return false;

  if (typeof message?.text === 'string' && /^\/groups(?:\s|$)/i.test(message.text.trim())) {
    const groups = await data<Group[]>(coordinator, 'chat_access_list', { joined: true });
    if (!groups.length) await bot.sendMessage?.(ownerId, 'Групп с общим Собеседником пока нет', {});
    for (const group of groups) {
      const view = await controls(coordinator, group.chat_id, group.title);
      await bot.sendMessage?.(ownerId, view.text, { reply_markup: { inline_keyboard: [[{ text: group.title, callback_data: `g:${group.chat_id}:view` }], ...view.options.reply_markup.inline_keyboard] } });
    }
    return true;
  }
  if (typeof callback?.data !== 'string' || !callback.data.startsWith('g:')) return false;
  const match = /^g:(-?\d+):(view|none|all|s:([a-f0-9]{32}))$/.exec(callback.data);
  if (!match) throw new Error('Invalid group access callback');
  const [, chatId, action, sourceId] = match;
  const groups = await data<Group[]>(coordinator, 'chat_access_list', { joined: true });
  const group = groups.find((item) => item.chat_id === chatId);
  if (!group) throw new Error('Unknown group');
  if (action !== 'view') {
    let access: 'none' | 'all_shared' | string[] = action === 'all' ? 'all_shared' : 'none';
    if (sourceId) {
      const status = await data<{ sources: Array<{ source: Source }> }>(coordinator, 'collect_status', {});
      const source = status.sources.map((item) => item.source).find((item) => item.ref_id === sourceId && item.mode === 'full' && item.kind === 'channel');
      if (!source) throw new Error('Unknown group source');
      const grants = await data<Grant[]>(coordinator, 'chat_access_list', { chat_id: chatId });
      const current = grants[0]?.access;
      access = Array.isArray(current) ? current.filter((ref) => ref !== source.ref && ref !== source.chat_id) : [];
      if (access.length === (Array.isArray(current) ? current.length : 0)) access.push(source.ref);
    }
    await data(coordinator, 'chat_access_set', { chat_id: chatId, access });
  }
  const view = await controls(coordinator, chatId, group.title);
  await bot.sendMessage?.(ownerId, view.text, view.options);
  if (typeof callback.id === 'string') await bot.answerCallbackQuery?.(callback.id);
  return true;
}
