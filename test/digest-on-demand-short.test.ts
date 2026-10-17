import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';

const ownerId = '12345';
const tokens = { mine: 'mine-short-digest-token', shared: 'shared-short-digest-token', receiver: 'receiver-short-digest-token' };
const now = () => new Date('2026-09-25T12:00:00.000Z');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const principals = [
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: hash(tokens.mine) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: hash(tokens.shared) },
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: hash(tokens.receiver) },
];

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-short-digest-')), ownerId, now });
  const access = createAccess({ principals, legacyToken: 'system-short-digest-token', ownerId, archive });
  const gatewayCalls: Array<{ name: string; args: unknown }> = [];
  let messages: Array<{ id: number; sender: string; date: string; text: string }> = [];
  let groups = Array.from({ length: 12 }, (_, index) => ({ chat_id: -1000 - index, title: `Группа ${index + 1}`, type: 'group', username: `group${index + 1}` }));
  let atLimit = false;
  let historyError: string | undefined;
  let recentRaw: string | undefined;
  // telegram-mcp v3.2.46: list_messages and list_chats return a JSON string with a results array.
  const gateway = {
    resolveSource(ref: string): any {
      if (ref.includes('missing')) throw new Error('private resolver detail');
      if (ref.includes('private')) return { chatId: '777', title: 'Человек', kind: 'user' };
      return { chatId: ref.includes('channel') ? '-1002' : '-1001', title: 'Группа', kind: ref.includes('channel') ? 'channel' : 'group' };
    },
    async history(args: unknown) {
      gatewayCalls.push({ name: 'list_messages', args });
      if (historyError) return historyError;
      const limit = Number((args as { limit?: unknown })?.limit ?? 20);
      const results = atLimit ? Array.from({ length: limit }, (_, index) => ({ id: index + 1, sender: 'A', date: '2026-09-20T15:00:00+00:00', text: `Сообщение ${index + 1}` })) : messages.slice(0, limit);
      return JSON.stringify({ results });
    },
    async recentGroups(args: unknown) {
      gatewayCalls.push({ name: 'list_chats', args });
      if (recentRaw) return recentRaw;
      return JSON.stringify({ results: groups.slice(0, Number((args as { limit?: unknown })?.limit ?? 20)) });
    },
    async callTool(name: string, args: unknown) {
      if (name === 'list_messages') return this.history(args);
      if (name === 'list_chats') return this.recentGroups(args);
      throw new Error(`Unexpected telegram-mcp tool: ${name}`);
    },
  };
  const coordinator = new Coordinator({ archive, ownerId, now, access, telegram: gateway });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string | undefined, name: string, args: Record<string, unknown>) => handler({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: { name, arguments: args },
  }) as Promise<any>;
  const coordinatorCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: tokens.mine,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      coordinatorCalls.push({ name: request.params.name, args: request.params.arguments });
      const response = await handler({ ...request, headers: { authorization: `Bearer ${tokens.mine}` } });
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'fake-key' },
    receiver: { name: 'receiver', token: 'fake-receiver-bot-token', coordToken: tokens.receiver },
    talkers: [{ name: 'mine', token: 'fake-mine-bot-token', coordToken: tokens.mine, model: 'digest-model', ownerOnly: true, digest: true }],
  };
  return {
    archive, coordinator, call, client, config, gatewayCalls, coordinatorCalls,
    setMessages(value: typeof messages) { messages = value; },
    setGroups(value: typeof groups) { groups = value; },
    setAtLimit() { atLimit = true; },
    setHistoryError(value: string) { historyError = value; },
    setRecentRaw(value: string) { recentRaw = value; },
    close() { coordinator.close(); archive.close(); },
  };
}

const digestRequest = (groups: string[], from: string, to: string) => ({ groups, from, to, scheduled: false, chat_id: ownerId });
const content = (response: any) => response.result?.structuredContent;

function update(id: number, text: string) {
  return { update_id: id, message: { message_id: id, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text } };
}

async function runCommand(f: ReturnType<typeof fixture>, updates: unknown[] | ((sent: unknown[][]) => unknown[][]), modelFails = false) {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  const modelRequests: Record<string, unknown>[] = [];
  let polls = 0;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runBots({
        config: f.config, signal: controller.signal,
        botApiFactory: (name) => ({
          async getUpdates() {
            if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
            if (typeof updates === 'function') {
              if (++polls <= 2) return updates(sent)[polls - 1] as any;
            } else if (++polls === 1) return updates as any;
            controller.abort();
            return [];
          },
          async sendMessage(...args: unknown[]) { sent.push(args); return { message_id: sent.length, chat: { id: 12345, type: 'private' }, text: args[1], reply_markup: (args[2] as any)?.reply_markup }; },
          async answerCallbackQuery() { return true; },
        }),
        coordinatorClientFactory: (name, token) => { if (name === 'mine') { assert.equal(token, tokens.mine); return f.client; } return { async callTool() { throw new Error('receiver must stay idle'); } }; },
        modelClientFactory: () => ({ async complete(request) { modelRequests.push(request); if (modelFails) throw new Error('private proxy key'); return { choices: [{ message: { role: 'assistant', content: 'Краткая сводка: обсуждали встречу.' } }] }; } }),
        log: () => {}, sleep: async () => { controller.abort(); },
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('bots process did not finish')), 2000); }),
    ]);
    return { sent, modelRequests };
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('Б-11: digest is available only to a talker with digest permission', async () => {
  const f = fixture();
  try {
    const args = digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z');
    const mine = await f.call(tokens.mine, 'digest', args);
    assert.equal(content(mine).success, true);
    assert.equal(content(mine).data.kind, 'raw');
    for (const token of [tokens.shared, tokens.receiver]) {
      const denied = await f.call(token, 'digest', args);
      assert.equal(content(denied).error.code, 'forbidden');
    }
    const missing = await f.call(undefined, 'digest', args);
    assert.equal(missing.error?.message, 'Unauthorized');
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-11: short digest parses telegram-mcp JSON, trims exact UTC times, and never archives or marks read', async () => {
  const f = fixture();
  f.setMessages([
    { id: 1, sender: 'A', date: '2026-09-20T11:59:59+00:00', text: 'Слишком рано' },
    { id: 2, sender: 'B', date: '2026-09-20T12:00:00+00:00', text: 'Встреча началась' },
    { id: 3, sender: 'C', date: '2026-09-21T12:00:00+00:00', text: 'Встреча закончилась' },
    { id: 4, sender: 'D', date: '2026-09-21T12:00:01+00:00', text: 'Слишком поздно' },
  ]);
  try {
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T12:00:00Z', '2026-09-21T12:00:00Z'));
    assert.equal(content(response).success, true);
    assert.equal(content(response).data.kind, 'raw');
    const markdown = content(response).data.markdown;
    assert.match(markdown, /Встреча началась/);
    assert.match(markdown, /Встреча закончилась/);
    assert.doesNotMatch(markdown, /Слишком рано|Слишком поздно/);
    const history = f.gatewayCalls.find((call) => call.name === 'list_messages');
    assert.ok(history);
    const argumentsText = JSON.stringify(history.args);
    assert.match(argumentsText, /-1001/);
    assert.match(argumentsText, /2026-09-20/);
    assert.match(argumentsText, /2026-09-21/);
    assert.ok(!f.gatewayCalls.some((call) => call.name === 'mark_as_read'));
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-11: a full-collection group uses the archive and does not call telegram-mcp history', async () => {
  const f = fixture();
  try {
    assert.equal(content(await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/group', mode: 'full' })).success, true);
    f.archive.saveTelegram({ kind: 'group', chatId: '-1001', messageId: '10', text: 'Архивное обсуждение', publishedAt: '2026-09-20T14:00:00Z' });
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(response).success, true);
    assert.match(content(response).data.markdown, /Архивное обсуждение/);
    assert.ok(!f.gatewayCalls.some((call) => call.name === 'list_messages'));
  } finally { f.close(); }
});

test('Б-11: группа режима сводки читается через Telegram и не попадает в архив', async () => {
  const f = fixture();
  f.setMessages([{ id: 7, sender: 'A', date: '2026-09-20T15:00:00+00:00', text: 'Сообщение без сохранения' }]);
  try {
    assert.equal(content(await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/group', mode: 'summary' })).success, true);
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.match(content(response).data.markdown, /Сообщение без сохранения/);
    assert.ok(f.gatewayCalls.some((call) => call.name === 'list_messages'));
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-11: a telegram-mcp result at its limit warns that the digest is incomplete', async () => {
  const f = fixture();
  f.setAtLimit();
  try {
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(response).success, true);
    assert.match(content(response).data.markdown, /неполн|лимит|частич/i);
  } finally { f.close(); }
});

test('Б-11: personal sources and oversized ranges fail before reading Telegram or the archive', async () => {
  const f = fixture();
  try {
    const personal = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/private'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(personal).error.code, 'forbidden_area');
    assert.deepEqual(f.gatewayCalls, []);
    const tooLong = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-05-01T00:00:00Z', '2026-09-25T00:00:00Z'));
    assert.equal(content(tooLong).error.code, 'range_too_long');
    assert.deepEqual(f.gatewayCalls, []);
    const waiting = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z'));
    assert.equal(content(waiting).success, false);
    assert.match(content(waiting).error.message, /длинн|ещё не подключен|позже/i);
    assert.deepEqual(f.gatewayCalls, []);
  } finally { f.close(); }
});

test('Б-11: /digest with one date or a range sends raw Markdown to the model and replies with a summary', async () => {
  const f = fixture();
  f.setMessages([{ id: 5, sender: 'A', date: '2026-09-20T15:00:00+00:00', text: 'Обсуждали встречу' }]);
  try {
    const result = await runCommand(f, [update(1, '/digest https://t.me/group 2026-09-20'), update(6, '/digest @group 2026-09-20..2026-09-21')]);
    assert.equal(f.coordinatorCalls[0]?.name, 'digest');
    assert.equal(f.coordinatorCalls[1]?.name, 'digest');
    assert.equal(result.modelRequests.length, 2);
    assert.match(JSON.stringify(result.modelRequests[0]), /Обсуждали встречу/);
    assert.match(JSON.stringify(result.sent), /Краткая сводка/);
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-11: /digest without arguments shows at most ten recent groups and asks for dates after selection', async () => {
  const f = fixture();
  try {
    const result = await runCommand(f, (sent) => {
      const first = JSON.stringify(sent[0] ?? []);
      const callback = /"callback_data":"([^"]+)"/.exec(first)?.[1];
      return [[update(2, '/digest')], [{ update_id: 3, callback_query: { id: 'group-click', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]];
    });
    const recent = f.gatewayCalls.find((call) => call.name === 'list_chats');
    assert.ok(recent);
    assert.match(JSON.stringify(recent.args), /group/);
    assert.match(JSON.stringify(recent.args), /10/);
    assert.match(JSON.stringify(result.sent), /Группа 1/);
    assert.doesNotMatch(JSON.stringify(result.sent), /Группа 11|Группа 12/);
    assert.match(JSON.stringify(result.sent), /дат/i);
    assert.equal(result.modelRequests.length, 0);
  } finally { f.close(); }
});

test('Б-11: реальные типы групп list_chats проходят фильтр без имени пользователя', async () => {
  const f = fixture();
  f.setGroups([{ chat_id: -1001, title: 'Закрытая группа', type: 'Supergroup', username: '' }]);
  try {
    const recent = await f.call(tokens.mine, 'digest', { chat_id: ownerId });
    assert.deepEqual(content(recent).data.groups, [{ ref: '-1001', title: 'Закрытая группа' }]);
    const response = await f.call(tokens.mine, 'digest', digestRequest(['-1001'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(response).success, true);
    assert.ok(f.gatewayCalls.some((call) => call.name === 'list_messages'));
  } finally { f.close(); }
});

test('Б-11: malformed digest dates and missing group get an explanation without reading or model calls', async () => {
  const f = fixture();
  try {
    const result = await runCommand(f, [update(4, '/digest https://t.me/group 2026-02-30'), update(5, '/digest 2026-09-20')]);
    assert.equal(result.modelRequests.length, 0);
    assert.deepEqual(f.gatewayCalls, []);
    assert.match(JSON.stringify(result.sent), /формат|дата|группа|использ/i);
  } finally { f.close(); }
});

test('Б-11: недоступная модель даёт владельцу ошибку без выдуманной сводки', async () => {
  const f = fixture();
  f.setMessages([{ id: 5, sender: 'A', date: '2026-09-20T15:00:00+00:00', text: 'Факт встречи' }]);
  try {
    const result = await runCommand(f, [update(90, '/digest https://t.me/group 2026-09-20')], true);
    assert.equal(result.modelRequests.length, 1);
    assert.match(JSON.stringify(result.sent), /Не удалось получить сводку от модели/);
    assert.doesNotMatch(JSON.stringify(result.sent), /Факт встречи|Краткая сводка|private proxy key/);
  } finally { f.close(); }
});

test('Б-11: неразрешимая группа возвращает понятную ошибку до чтения сообщений', async () => {
  const f = fixture();
  try {
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/missing'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(response).error.code, 'source_unavailable');
    assert.equal(content(response).error.message, 'Не удалось определить группу');
    assert.deepEqual(f.gatewayCalls, []);
  } finally { f.close(); }
});

test('Б-11: текстовый отказ telegram-mcp сохраняет короткую причину без содержимого переписки', async () => {
  const f = fixture();
  f.setHistoryError('Rate limit exceeded (FloodWait): wait 30 seconds.\nPRIVATE-CONTENT');
  try {
    const response = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(response).success, false);
    assert.match(content(response).error.message, /FloodWait.*30 seconds/);
    assert.doesNotMatch(content(response).error.message, /PRIVATE-CONTENT/);
  } finally { f.close(); }
});

test('Б-11: текстовые ответы telegram-mcp об отсутствии сообщений и групп означают пустую выборку', async () => {
  const f = fixture();
  f.setHistoryError('No messages found matching the criteria.');
  f.setRecentRaw('No chats found matching the criteria.');
  try {
    const digest = await f.call(tokens.mine, 'digest', digestRequest(['https://t.me/group'], '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'));
    assert.equal(content(digest).success, true);
    assert.match(content(digest).data.markdown, /Нет сообщений за период/);
    const recent = await f.call(tokens.mine, 'digest', { chat_id: ownerId });
    assert.equal(content(recent).success, true);
    assert.deepEqual(content(recent).data.groups, []);
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-11: отказ telegram-mcp в списке чатов объясняется кратко и без содержимого', async () => {
  const f = fixture();
  f.setRecentRaw('Listing chats is not supported for bot accounts (Telegram API restriction: bots cannot fetch dialog lists).\nPRIVATE-CONTENT');
  try {
    const response = await f.call(tokens.mine, 'digest', { chat_id: ownerId });
    assert.equal(content(response).success, false);
    assert.match(content(response).error.message, /Listing chats is not supported/);
    assert.doesNotMatch(content(response).error.message, /PRIVATE-CONTENT/);
  } finally { f.close(); }
});
