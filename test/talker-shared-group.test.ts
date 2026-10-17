import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { deliverGroupAlerts } from '../src/bots/receiver-groups.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const ownerId = '12345';
const groupId = '-100999';
const botId = 900;
const tokens = { receiver: 'receiver-shared-group-token', shared: 'shared-group-token', system: 'system-shared-group-token' };
const refs = { channel: 'https://t.me/allowed_channel', group: 'https://t.me/other_group' };
const now = () => new Date('2026-09-25T12:00:00.000Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: sha256(tokens.receiver) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: sha256(tokens.shared) },
];

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-shared-bot-')), ownerId, now });
  const channel = archive.saveTelegram({ kind: 'channel', chatId: '-10011', messageId: '1', text: 'Пароль канала: АЛЬФА' });
  const other = archive.saveTelegram({ kind: 'group', chatId: '-10022', messageId: '1', text: 'Пароль другой группы: БЕТА' });
  const personal = archive.savePersonalTelegram({ text: 'Личная тайна: ГАММА', operationId: 'private-shared-test' });
  const uri = (path: string) => `viking://resources/${relative(archive.rootDir, path).split(sep).join('/')}`;
  const resources = [uri(channel.path), uri(other.path), uri(personal.path)];
  let coordinator: Coordinator;
  const access = createAccess({ principals, legacyToken: tokens.system, ownerId, archive, sourceTargetUri: (ref: string) => coordinator.sourceTargetUri(ref) });
  const searches: string[] = [];
  const integrations = new Stage3Service({
    archive, ownerId, tokenSecret: 'group-read-secret', now,
    openViking: {
      async search({ target_uri }: { target_uri: string }) {
        searches.push(target_uri);
        return resources.filter((value) => value.startsWith(target_uri)).map((target_uri) => ({ target_uri }));
      },
    },
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => { throw new Error('web access is outside this test'); },
  } as any);
  coordinator = new Coordinator({
    archive, ownerId, now, access, integrations,
    telegram: { resolveSource: (ref: string) => ref === refs.channel
      ? { chatId: '-10011', title: 'Разрешённый канал', kind: 'channel' as const }
      : { chatId: '-10022', title: 'Другая группа', kind: 'group' as const } },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => handler({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    headers: { authorization: `Bearer ${token}` }, params: { name, arguments: args },
  }) as Promise<any>;
  const calls: Array<{ bot: string; name: string; args: Record<string, unknown> }> = [];
  const client = (bot: 'receiver' | 'shared') => createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: tokens[bot],
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      calls.push({ bot, name: request.params.name, args: request.params.arguments });
      const response = await handler({ ...request, headers: { authorization: `Bearer ${tokens[bot]}` } });
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'fake-key' },
    receiver: { name: 'receiver', token: 'fake-receiver-token', coordToken: tokens.receiver },
    talkers: [{ name: 'shared', token: 'fake-shared-token', coordToken: tokens.shared, model: 'shared-model', ownerOnly: false, digest: false }],
  };
  return { archive, coordinator, call, client, config, calls, searches, uris: { channel: resources[0], other: resources[1], personal: resources[2] }, close() { coordinator.close(); archive.close(); } };
}

function groupMessage(id: number, text: string, extra: Record<string, unknown> = {}) {
  return { update_id: id, message: { message_id: id, date: Math.floor(now().getTime() / 1000), from: { id: 777 }, chat: { id: Number(groupId), type: 'supergroup', title: 'Тестовая группа' }, text, ...extra } };
}
const assistant = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const toolCall = (name: string, args: object) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

async function runProcess(f: ReturnType<typeof fixture>, active: 'shared' | 'receiver', updates: unknown[] | ((sent: Array<{ bot: string; args: unknown[] }>) => unknown[][]), reply: (request: any, step: number) => object = () => assistant('Ответ'), joinFailures = 0) {
  const controller = new AbortController();
  const sent: Array<{ bot: string; args: unknown[] }> = [];
  const modelRequests: any[] = [];
  const offsets: number[] = [];
  let polls = 0;
  let joinAttempts = 0;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runBots({
        config: f.config, signal: controller.signal,
        botApiFactory: (name) => ({
          async getUpdates({ offset }: { offset: number }) {
            if (name !== active) return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
            offsets.push(offset);
            if (typeof updates === 'function') {
              if (++polls <= 2) return updates(sent)[polls - 1] as any;
            } else if (++polls === 1) return updates as any;
            controller.abort();
            return [];
          },
          async sendMessage(...args: unknown[]) { sent.push({ bot: name, args }); return { message_id: 500 + sent.length, text: args[1], chat: { id: args[0], type: 'private' }, reply_markup: (args[2] as any)?.reply_markup }; },
          async answerCallbackQuery() { return true; },
          async getMe() { return { id: botId, username: 'shared_bot' }; },
        }),
        coordinatorClientFactory: (name, token) => {
          assert.equal(token, tokens[name as 'receiver' | 'shared']);
          const client = f.client(name as 'receiver' | 'shared');
          return name === 'shared' && joinFailures ? { callTool: (tool: string, args: Record<string, unknown> = {}) => {
            if (tool === 'chat_joined' && ++joinAttempts <= joinFailures) throw new Error('temporary coordinator failure');
            return client.callTool(tool, args);
          } } : client;
        },
        modelClientFactory: (name) => ({ async complete(request) { modelRequests.push({ name, request }); return reply(request, modelRequests.length); } }),
        log: () => {}, sleep: async () => { if (!joinFailures) controller.abort(); },
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('bots process did not finish')), 2000); }),
    ]);
    return { sent, modelRequests, joinAttempts, offsets };
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('Б-10: ordinary group messages are ignored; mention, reply and /ask reach the model', async () => {
  const f = fixture();
  try {
    const ordinary = await runProcess(f, 'shared', [groupMessage(1, 'Обычный разговор')]);
    assert.deepEqual(ordinary.modelRequests, []);
    assert.deepEqual(f.calls.filter((call) => call.bot === 'shared'), []);
    const updates = [
      groupMessage(2, '@shared_bot Где пароль?', { entities: [{ type: 'mention', offset: 0, length: 11 }] }),
      groupMessage(3, 'Где пароль?', { reply_to_message: { message_id: 500, from: { id: botId, is_bot: true } } }),
      groupMessage(4, '/ask Где пароль?', { entities: [{ type: 'bot_command', offset: 0, length: 4 }] }),
    ];
    const result = await runProcess(f, 'shared', updates);
    assert.equal(result.modelRequests.length, 3);
    assert.ok(result.modelRequests.every((entry) => entry.name === 'shared'));
  } finally { f.close(); }
});

test('Б-10/Б-15: before access is configured, a prompted group search is empty and the bot stays silent', async () => {
  const f = fixture();
  try {
    const result = await runProcess(f, 'shared', [groupMessage(5, '/ask Пароль?', { entities: [{ type: 'bot_command', offset: 0, length: 4 }] })], (_request, step) => step === 1 ? toolCall('knowledge_search', { query: 'пароль' }) : assistant('Выдуманный ответ'));
    assert.ok(result.modelRequests.length >= 1);
    assert.equal(f.calls.find((call) => call.name === 'knowledge_search')?.args.chat_id, groupId);
    assert.deepEqual(f.searches, []);
    assert.deepEqual(result.sent, []);
  } finally { f.close(); }
});

test('Б-05: granted group search reads only the selected channel and never personal memory', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).result.structuredContent.success, true);
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.group, mode: 'full' })).result.structuredContent.success, true);
    assert.equal((await f.call(tokens.receiver, 'chat_access_set', { chat_id: groupId, access: [refs.channel] })).result.structuredContent.success, true);
    const result = await runProcess(f, 'shared', [groupMessage(6, '/ask Что известно?', { entities: [{ type: 'bot_command', offset: 0, length: 4 }] })], (request, step) => {
      if (step === 1) return toolCall('knowledge_search', { query: 'пароль', chat_id: ownerId });
      if (step === 2) {
        const results = JSON.parse(request.messages.at(-1).content).results;
        assert.deepEqual(results.map((item: any) => item.target_uri), [f.uris.channel]);
        return toolCall('knowledge_read', { read_token: results[0].read_token, chat_id: ownerId });
      }
      assert.match(JSON.stringify(request.messages), /АЛЬФА/);
      return assistant('Пароль: АЛЬФА');
    });
    assert.deepEqual(f.calls.filter((call) => call.bot === 'shared').map((call) => call.name), ['knowledge_search', 'knowledge_read']);
    assert.ok(f.calls.filter((call) => call.bot === 'shared').every((call) => call.args.chat_id === groupId));
    assert.match(JSON.stringify(result.sent), /АЛЬФА/);
    assert.match(JSON.stringify(result.sent), /viking:\/\/resources\/telegram\/channels/);
    assert.doesNotMatch(JSON.stringify(result.sent), /ГАММА|БЕТА/);
  } finally { f.close(); }
});

test('Б-05: all_shared cannot expose personal search results or read a personal token', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).result.structuredContent.success, true);
    assert.equal((await f.call(tokens.receiver, 'chat_access_set', { chat_id: groupId, access: 'all_shared' })).result.structuredContent.success, true);
    const before = f.archive.getState();
    const result = await f.call(tokens.shared, 'knowledge_search', { query: 'ГАММА', scope: 'personal', chat_id: groupId, limit: 20 });
    assert.equal(result.result.structuredContent.success, true);
    assert.ok(result.result.structuredContent.data.results.every((item: any) => item.target_uri !== f.uris.personal));
    assert.ok(f.searches.length > 0);
    assert.ok(f.searches.every((target) => !target.includes('/personal/')));
    const owner = await f.call(tokens.system, 'knowledge_search', { query: 'ГАММА', scope: 'personal', chat_id: ownerId, limit: 20 });
    const token = owner.result.structuredContent.data.results.find((item: any) => item.target_uri === f.uris.personal)?.read_token;
    assert.ok(token, 'personal record must be available to the system principal');
    const denied = await f.call(tokens.shared, 'knowledge_read', { read_token: token, chat_id: groupId });
    assert.equal(denied.result.structuredContent.success, false);
    assert.deepEqual(f.archive.getState(), before);
  } finally { f.close(); }
});

test('Б-15: joining a group creates one coordinator alert while access remains closed', async () => {
  const f = fixture();
  try {
    const event = { update_id: 7, my_chat_member: { chat: { id: Number(groupId), type: 'supergroup', title: 'Тестовая группа' }, from: { id: 12345 }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: botId, username: 'shared_bot' } } } };
    await runProcess(f, 'shared', [event, { ...event, update_id: 8 }]);
    assert.ok(f.calls.some((call) => call.name === 'chat_joined'));
    const alerts = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(alerts.result.structuredContent.data.length, 1);
    assert.equal(alerts.result.structuredContent.data[0].chat_id, groupId);
    assert.deepEqual((await f.call(tokens.receiver, 'chat_access_list', { chat_id: groupId })).result.structuredContent.data, []);
  } finally { f.close(); }
});

test('Б-15: temporary chat_joined failure is retried before the polling offset advances', async () => {
  const f = fixture();
  try {
    const event = { update_id: 30, my_chat_member: { chat: { id: Number(groupId), type: 'supergroup', title: 'Тестовая группа' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } };
    const result = await runProcess(f, 'shared', [event], () => assistant('Ответ'), 1);
    assert.equal(result.joinAttempts, 2);
    assert.deepEqual(result.offsets.slice(0, 2), [0, 31]);
    const pending = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(pending.result.structuredContent.data.length, 1);
    assert.equal(pending.result.structuredContent.data[0].chat_id, groupId);
  } finally { f.close(); }
});

test('Б-15: persistent chat_joined failure stops after three attempts and advances the polling offset', async () => {
  const f = fixture();
  try {
    const event = { update_id: 31, my_chat_member: { chat: { id: Number(groupId), type: 'supergroup', title: 'Тестовая группа' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } };
    const result = await runProcess(f, 'shared', [event], () => assistant('Ответ'), 10);
    assert.equal(result.joinAttempts, 3);
    assert.deepEqual(result.offsets.slice(0, 2), [0, 32]);
    assert.deepEqual((await f.call(tokens.receiver, 'alerts_take')).result.structuredContent.data, []);
  } finally { f.close(); }
});

test('Б-15: failed second send leaves only that alert pending', async () => {
  const f = fixture();
  try {
    await f.call(tokens.shared, 'chat_joined', { chat_id: '-100100', title: 'Первая группа' });
    await f.call(tokens.shared, 'chat_joined', { chat_id: '-100200', title: 'Вторая группа' });
    let sends = 0;
    await assert.rejects(deliverGroupAlerts(ownerId, f.client('receiver'), {
      async sendMessage() { if (++sends === 2) throw new Error('send failed'); return true; },
    }), /send failed/);
    assert.equal(sends, 2);
    const pending = await f.call(tokens.receiver, 'alerts_take');
    assert.deepEqual(pending.result.structuredContent.data.map((item: any) => item.chat_id), ['-100200']);
  } finally { f.close(); }
});

test('Б-15: receiver delivers a pending group alert with access buttons and applies all_shared on click', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.shared, 'chat_joined', { chat_id: groupId, title: 'Тестовая группа' })).result.structuredContent.success, true);
    const first = await runProcess(f, 'receiver', []);
    assert.ok(f.calls.some((call) => call.name === 'alerts_take'));
    assert.match(JSON.stringify(first.sent), /Тестовая группа/);
    assert.match(JSON.stringify(first.sent), /Нет доступа/);
    assert.match(JSON.stringify(first.sent), /Вся общая память/);
    assert.match(JSON.stringify(first.sent), /канал/i);
    const buttons = (first.sent[0]?.args[2] as any)?.reply_markup?.inline_keyboard?.flat() ?? [];
    const callback = buttons.find((button: any) => button.text === 'Вся общая память')?.callback_data;
    assert.ok(callback);
    await runProcess(f, 'receiver', [{ update_id: 9, callback_query: { id: 'access-click', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]);
    assert.equal([...f.calls].reverse().find((call) => call.name === 'chat_access_set')?.args.access, 'all_shared');
    assert.deepEqual((await f.call(tokens.receiver, 'chat_access_list', { chat_id: groupId })).result.structuredContent.data, [{ chat_id: groupId, access: 'all_shared' }]);
  } finally { f.close(); }
});

test('Б-15: /groups lists joined groups and offers per-channel access controls', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).result.structuredContent.success, true);
    assert.equal((await f.call(tokens.shared, 'chat_joined', { chat_id: groupId, title: 'Тестовая группа' })).result.structuredContent.success, true);
    const result = await runProcess(f, 'receiver', [{ update_id: 10, message: { message_id: 10, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: '/groups' } }]);
    assert.match(JSON.stringify(result.sent), /Тестовая группа/);
    assert.match(JSON.stringify(result.sent), /Разрешённый канал/);
    assert.equal(f.archive.getState().records.length, 3, '/groups must not be saved as a personal note');
  } finally { f.close(); }
});

test('Б-15: selecting a channel through /groups updates access and shows its checked state', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).result.structuredContent.success, true);
    assert.equal((await f.call(tokens.shared, 'chat_joined', { chat_id: groupId, title: 'Тестовая группа' })).result.structuredContent.success, true);
    let result = await runProcess(f, 'receiver', [{ update_id: 20, message: { message_id: 20, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: '/groups' } }]);
    const buttons = (items: typeof result.sent) => items.flatMap((item) => ((item.args[2] as any)?.reply_markup?.inline_keyboard ?? []).flat());
    let channel = buttons(result.sent).find((button: any) => String(button.text).includes('Разрешённый канал'));
    if (!channel) {
      const group = buttons(result.sent).find((button: any) => String(button.text).includes('Тестовая группа'));
      assert.ok(group?.callback_data, 'group must be selectable');
      result = await runProcess(f, 'receiver', [{ update_id: 21, callback_query: { id: 'group-select', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: group.callback_data } }]);
      channel = buttons(result.sent).find((button: any) => String(button.text).includes('Разрешённый канал'));
    }
    assert.ok(channel?.callback_data, 'channel must be selectable');
    await runProcess(f, 'receiver', [{ update_id: 22, callback_query: { id: 'channel-select', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: channel.callback_data } }]);
    const access = await f.call(tokens.receiver, 'chat_access_list', { chat_id: groupId });
    const grant = access.result.structuredContent.data[0]?.access;
    assert.ok(Array.isArray(grant) && grant.length === 1 && [refs.channel, '-10011'].includes(grant[0]));
    let checked = await runProcess(f, 'receiver', [{ update_id: 23, message: { message_id: 23, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: '/groups' } }]);
    if (!JSON.stringify(checked.sent).includes('Разрешённый канал')) {
      const group = buttons(checked.sent).find((button: any) => String(button.text).includes('Тестовая группа'));
      assert.ok(group?.callback_data);
      checked = await runProcess(f, 'receiver', [{ update_id: 24, callback_query: { id: 'group-reopen', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: group.callback_data } }]);
    }
    assert.match(JSON.stringify(checked.sent), /[✓✔✅].*Разрешённый канал|Разрешённый канал.*[✓✔✅]/);
  } finally { f.close(); }
});

test('Б-15: owner documentation explains disabling shared bot privacy mode in BotFather', () => {
  const docs = readdirSync(join(process.cwd(), 'docs')).filter((name) => name.endsWith('.md'));
  const ownerGuides = docs.map((name) => readFileSync(join(process.cwd(), 'docs', name), 'utf8'));
  assert.ok(ownerGuides.some((body) => /BotFather/i.test(body) && /privacy mode/i.test(body) && /выключ|отключ|disable/i.test(body)));
});
