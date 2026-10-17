type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };
type ModelMessage = { role?: string; content?: string | null; tool_calls?: ToolCall[] };
type ModelReply = { choices?: Array<{ message?: ModelMessage }> };

export type ModelClient = { complete(request: Record<string, unknown>): Promise<ModelReply> };

const tools = [
  { type: 'function', function: { name: 'knowledge_search', description: 'Search memory', parameters: { type: 'object', properties: { query: { type: 'string' }, person_id: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'knowledge_read', description: 'Read a search result', parameters: { type: 'object', properties: { read_token: { type: 'string' } }, required: ['read_token'] } } },
];

const notFound = 'Не нашёл подтверждения в памяти.';
const unavailable = 'Поиск сейчас недоступен. Попробуйте позже.';

export function createModelClient(config: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): ModelClient {
  const request = config.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async complete(body) {
      const response = await request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Model returned HTTP ${response.status}`);
      return await response.json() as ModelReply;
    },
  };
}

export async function answer(
  question: string,
  chatId: string,
  modelName: string,
  model: ModelClient,
  coordinator: { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> },
): Promise<string> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'Отвечай только по прочитанным материалам. Если подтверждения нет, прямо скажи об этом. Укажи URI источника.' },
    { role: 'user', content: question },
  ];
  const readTokens = new Map<string, string>();
  const sources = new Set<string>();
  for (let step = 0; step < 4; step += 1) {
    let reply: ModelReply;
    try { reply = await model.complete({ model: modelName, messages, tools, tool_choice: 'auto' }); }
    catch { return 'Не удалось получить ответ модели. Попробуйте позже.'; }
    const message = reply.choices?.[0]?.message;
    if (!message) return 'Не удалось получить ответ модели. Попробуйте позже.';
    if (!message.tool_calls?.length) {
      const content = message.content;
      if (!sources.size || typeof content !== 'string' || !content.trim()) return notFound;
      const missing = [...sources].filter((source) => !content.includes(source));
      return missing.length ? `${content}\nИсточники: ${missing.join(', ')}` : content;
    }
    messages.push(message as Record<string, unknown>);
    for (const call of message.tool_calls) {
      const name = call.function?.name;
      if (name !== 'knowledge_search' && name !== 'knowledge_read') return 'Не могу выполнить запрошенное действие.';
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.function?.arguments ?? '');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid arguments');
        args = parsed as Record<string, unknown>;
      } catch { return 'Не могу разобрать запрос к памяти.'; }
      const value = name === 'knowledge_search' ? args.query : args.read_token;
      if (typeof value !== 'string' || !value.trim()) return 'Не могу разобрать запрос к памяти.';
      if (name === 'knowledge_read' && !readTokens.has(value)) return notFound;
      const input = name === 'knowledge_search'
        ? { query: value, limit: 10, ...(typeof args.person_id === 'string' ? { person_id: args.person_id } : {}), chat_id: chatId }
        : { read_token: value, chat_id: chatId };
      let result: { success?: boolean; data?: any };
      try { result = await coordinator.callTool(name, input) as typeof result; }
      catch { return unavailable; }
      if (!result?.success) return unavailable;
      if (name === 'knowledge_search') {
        const found = result.data?.results;
        if (Array.isArray(found)) for (const item of found) if (typeof item.read_token === 'string' && typeof item.target_uri === 'string') readTokens.set(item.read_token, item.target_uri);
      } else {
        sources.add(readTokens.get(value)!);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.data) });
    }
  }
  return 'Не удалось завершить поиск за четыре шага.';
}

export async function handleOwnerTalkerUpdate(
  update: unknown,
  ownerId: string,
  modelName: string,
  model: ModelClient,
  coordinator: { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> },
  bot: { sendMessage?: (chatId: string, text: string, options: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
  const message = (update as { message?: any })?.message;
  if (!message || message.chat?.type !== 'private' || String(message.chat.id) !== ownerId || String(message.from?.id) !== ownerId || typeof message.text !== 'string' || !message.text.trim()) return;
  const response = await answer(message.text, ownerId, modelName, model, coordinator);
  if (!bot.sendMessage) throw new Error('Bot API cannot send an answer');
  await bot.sendMessage(ownerId, response, {});
}
