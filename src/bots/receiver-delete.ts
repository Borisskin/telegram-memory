export async function handleReceiverDeletionUpdate(
  update: unknown,
  ownerId: string,
  coordinator: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> },
  bot: { sendMessage?: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown>; answerCallbackQuery?: (id: string, options?: Record<string, unknown>) => Promise<unknown> },
): Promise<boolean> {
  const input = update as { callback_query?: any; message?: any };
  const callback = input?.callback_query;
  const message = input?.message;
  let shortId: string | undefined;
  if (callback) {
    if (String(callback.from?.id) !== ownerId || callback.message?.chat?.type !== 'private' || String(callback.message.chat.id) !== ownerId) return false;
    shortId = callback.data;
  } else if (typeof message?.text === 'string' && /^\/undo(?:\s|$)/i.test(message.text.trim())) {
    if (message.chat?.type !== 'private' || String(message.chat.id) !== ownerId || String(message.from?.id) !== ownerId) return false;
    const buttons = message.reply_to_message?.reply_markup?.inline_keyboard;
    shortId = Array.isArray(buttons) ? buttons.flat().find((button: any) => /^[a-f0-9]{32}$/.test(button?.callback_data))?.callback_data : undefined;
    if (!shortId) {
      await bot.sendMessage?.(ownerId, 'Ответьте /undo на сообщение с кнопкой «🗑 Удалить»', {});
      return true;
    }
  } else return false;
  if (typeof shortId !== 'string' || !/^[a-f0-9]{32}$/.test(shortId)) return false;
  const result = await coordinator.callTool('record_delete', { short_id: shortId }) as { success?: boolean };
  if (!result.success) {
    if (typeof callback?.id === 'string') await bot.answerCallbackQuery?.(callback.id, { text: 'Не удалось удалить запись', show_alert: true });
    else await bot.sendMessage?.(ownerId, 'Не удалось удалить запись', {});
    return true;
  }
  if (!bot.sendMessage) throw new Error('Bot API cannot confirm deletion');
  await bot.sendMessage(ownerId, 'Запись удалена', {});
  if (typeof callback?.id === 'string') await bot.answerCallbackQuery?.(callback.id);
  return true;
}
