import { answer, type ModelClient } from './talker.ts';

type Coordinator = { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> };

export function isSharedJoinUpdate(update: unknown): boolean {
  const membership = (update as { my_chat_member?: any })?.my_chat_member;
  return !!membership && ['group', 'supergroup'].includes(membership.chat?.type)
    && ['member', 'administrator'].includes(membership.new_chat_member?.status)
    && !['member', 'administrator'].includes(membership.old_chat_member?.status);
}

export async function handleSharedTalkerUpdate(
  update: unknown,
  identity: { id: number; username: string },
  modelName: string,
  model: ModelClient,
  coordinator: Coordinator,
  bot: { sendMessage?: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
  const event = update as { message?: any; my_chat_member?: any };
  const membership = event.my_chat_member;
  if (isSharedJoinUpdate(update)) {
    const result = await coordinator.callTool('chat_joined', { chat_id: String(membership.chat.id), title: String(membership.chat.title ?? membership.chat.id) }) as { success?: boolean };
    if (!result?.success) throw new Error('Coordinator did not record the joined group');
    return;
  }
  const message = event.message;
  if (!message || !['group', 'supergroup'].includes(message.chat?.type) || typeof message.text !== 'string') return;
  const text = message.text.trim();
  const mentioned = Array.isArray(message.entities) && message.entities.some((entity: any) =>
    (entity.type === 'mention' && message.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${identity.username.toLowerCase()}`)
    || (entity.type === 'text_mention' && entity.user?.id === identity.id));
  const command = /^\/ask(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
  const asked = !!command && (!command[1] || command[1].toLowerCase() === identity.username.toLowerCase());
  const replied = message.reply_to_message?.from?.id === identity.id;
  if (!text || (!mentioned && !asked && !replied)) return;
  const response = await answer(text, String(message.chat.id), modelName, model, coordinator);
  if (response === 'Не нашёл подтверждения в памяти.') return;
  if (!bot.sendMessage) throw new Error('Bot API cannot send an answer');
  await bot.sendMessage(String(message.chat.id), response, { reply_parameters: { message_id: message.message_id } });
}
