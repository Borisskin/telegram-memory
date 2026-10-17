import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { handleReceiverUpdate } from '../src/bots/receiver.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';
// @ts-expect-error Docker adapter is plain JavaScript.
import { collectTelegramPage } from '../src/server/telegram-collect.mjs';

const ownerId = '12345';
const receiverToken = 'personal-chat-receiver';
const talkerToken = 'personal-chat-talker';
const sharedToken = 'personal-chat-shared';
const now = () => new Date('2026-09-25T12:00:00.000Z');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: digest(receiverToken) },
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: false, token_sha256: digest(talkerToken) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: digest(sharedToken) },
];

function fixture(root = mkdtempSync(join(tmpdir(), 'telegram-memory-personal-chat-')), collectError?: Error) {
  const archive = new Archive({ rootDir: root, ownerId, now });
  const access = createAccess({ principals, legacyToken: 'personal-chat-system', ownerId, archive });
  const searched: string[] = [];
  const integrations = new Stage3Service({
    archive, ownerId, now, tokenSecret: 'personal-chat-read-secret',
    openViking: { async search({ target_uri }: { target_uri: string }) {
      searched.push(target_uri);
      return (archive.getState().records as Array<{ path: string }>).map((row) => `viking://resources/${relative(root, row.path).split(sep).join('/')}`)
        .filter((uri) => uri.startsWith(target_uri)).map((target_uri) => ({ target_uri }));
    } },
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test/', remoteAddress: '93.184.216.34', headers: { 'content-type': 'text/html' }, body: '<article>Тест</article>' }),
  } as any);
  const collected: Array<{ source: any; mode: string }> = [];
  let personName = 'Анна Первая';
  const coordinator = new Coordinator({ archive, ownerId, now, access, integrations, telegram: {
    resolveSource: (ref: string) => ({ chatId: '777', title: personName, kind: 'user', username: 'anna_test', ref } as any),
    collect: ({ source, mode }: any) => {
      collected.push({ source, mode });
      if (collectError) throw collectError;
      return { messages: [
        { id: 101, text: 'Первое сообщение', publishedAt: '2026-09-10T10:00:00.000Z', sourceName: personName },
        { id: 102, text: 'Второе сообщение', publishedAt: '2026-09-11T11:00:00.000Z', sourceName: personName },
      ] };
    },
  } });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', headers: { authorization: `Bearer ${token}` }, params: { name, arguments: args } }) as any;
    return response.result.structuredContent as any;
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({ endpoint: 'http://coordinator.test/mcp', token: receiverToken, fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body));
    calls.push({ name: request.params.name, args: request.params.arguments });
    const response = await handler({ ...request, headers: { authorization: `Bearer ${receiverToken}` } });
    return new Response(JSON.stringify(response), { status: 200 });
  } });
  const config: BotsConfig = { ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'unused' }, receiver: { name: 'receiver', token: 'fake-bot-token', coordToken: receiverToken }, talkers: [] };
  const input = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ chat_id: ownerId, message_id: id, date: now().toISOString(), text, entities: [], ...extra });
  return { root, archive, coordinator, call, client, config, calls, input, searched, collected, setPersonName(value: string) { personName = value; }, close() { coordinator.close(); archive.close(); } };
}

function message(updateId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text } };
}

test('Б-03: человек по @username, ссылке и открытой пересылке получает только предложение личной переписки', async () => {
  const f = fixture();
  try {
    for (const [id, text, extra] of [
      ['1', '@anna_test', {}],
      ['2', 'https://t.me/anna_test', {}],
      ['3', 'Переслано от Анны', { forward_origin: { type: 'user', sender_user: { id: 777, first_name: 'Анна' } } }],
    ] as const) {
      const saved = await f.call(receiverToken, 'inbox_save', f.input(id, text, extra));
      assert.equal(saved.success, true);
      assert.deepEqual(saved.data.offers.map((offer: any) => offer.actions), [['personal_chat', 'none']]);
      assert.equal(saved.data.offers[0].kind, 'person');
    }
    const hidden = await f.call(receiverToken, 'inbox_save', f.input('4', 'Переслано анонимно', { forward_origin: { type: 'hidden_user', sender_user_name: 'Анна' } }));
    assert.deepEqual(hidden.data.offers, []);
  } finally { f.close(); }
});

test('Б-03: кнопка человека подключает personal_chat; уже подключённый человек повторно не предлагается', async () => {
  const f = fixture();
  const controller = new AbortController();
  const sent: unknown[][] = [];
  let buttonData: string | undefined;
  let polls = 0;
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates() {
          polls += 1;
          if (polls === 1) return [message(10, '@anna_test')];
          if (polls === 2) {
            const rows = (sent[0]?.[2] as any)?.reply_markup?.inline_keyboard ?? [];
            const button = rows.flat().find((item: any) => item.text === '👤 Подключить переписку');
            buttonData = button?.callback_data;
            if (!buttonData) { controller.abort(); return []; }
            return [{ update_id: 11, callback_query: { id: 'person-click', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: buttonData } }];
          }
          controller.abort();
          return [];
        },
        async sendMessage(...args: unknown[]) { sent.push(args); },
        async answerCallbackQuery() { return true; },
      }),
      coordinatorClientFactory: () => f.client,
      log: () => {},
    });
    assert.ok(buttonData, 'Приёмщик должен предложить подключение человека');
    assert.ok(Buffer.byteLength(buttonData, 'utf8') <= 64);
    assert.ok(f.calls.some((item) => item.name === 'source_add' && item.args.mode === 'personal_chat'));
    assert.ok(f.calls.every((item) => item.name !== 'collect_start'), 'Приёмщик не запускает сбор отдельным вызовом');
    const status = await f.call(receiverToken, 'collect_status');
    assert.equal(status.data.sources[0].source.chat_id, '777');
    const repeated = await f.call(receiverToken, 'inbox_save', f.input('12', '@anna_test'));
    assert.deepEqual(repeated.data.offers, []);
  } finally { controller.abort(); f.close(); }
});

test('Б-08: Приёмщик сообщает о сбое личного сбора при подключении и в /status', async () => {
  for (const [failure, expectedState, reason] of [
    [new Error('Telegram history exceeds one-day collection limit'), 'needs_attention', /1000 сообщений/],
    [new Error('temporary Telegram failure'), 'waiting', /Telegram недоступен/],
  ] as const) {
    const f = fixture(undefined, failure);
    const sent: string[] = [];
    const bot = { async sendMessage(_chatId: string, text: string) { sent.push(text); }, async answerCallbackQuery() {} };
    try {
      const saved = await f.call(receiverToken, 'inbox_save', f.input('41', '@anna_test'));
      const refId = saved.data.offers[0].ref_id;
      await handleReceiverUpdate({ callback_query: { id: 'connect-person', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: `s:personal_chat:${refId}` } }, ownerId, f.client, bot);
      assert.match(sent[0], reason);
      assert.doesNotMatch(sent[0], /^Источник подключён$/);
      const status = await f.call(receiverToken, 'collect_status');
      assert.equal(status.data.sources[0].job.state, expectedState);
      await handleReceiverUpdate(message(42, '/status'), ownerId, f.client, bot);
      assert.match(sent[1], reason);
    } finally { f.close(); }
  }
});

test('Б-08: private сохраняет сообщения по месяцам с редакциями, вложением и мягким удалением', () => {
  const f = fixture();
  try {
    const first = f.archive.saveTelegram({ kind: 'private', chatId: '777', messageId: '101', text: 'Старая редакция', publishedAt: '2026-09-10T10:00:00.000Z', attachments: [{ type: 'document', name: 'note.txt', data: 'вложение' }] } as any);
    assert.equal(first.path, join(f.root, 'personal', ownerId, 'people', '777', 'chat', '2026-09', '101.md'));
    assert.equal(first.revision, 1);
    assert.equal((f.archive.read(first.archiveId).metadata.attachments as any[]).length, 1);
    const edited = f.archive.saveTelegram({ kind: 'private', chatId: '777', messageId: '101', text: 'Новая редакция', editedAt: '2026-09-11T10:00:00.000Z' } as any);
    assert.equal(edited.revision, 2);
    assert.equal(edited.path, first.path);
    const deleted = f.archive.markTelegramDeleted({ kind: 'private', chatId: '777', messageId: '101' } as any);
    assert.equal(deleted.revision, 3);
    assert.equal(f.archive.read(first.archiveId).metadata.status, 'deleted');
    assert.ok(existsSync(join(f.root, '.history')) || existsSync(join(f.root, 'personal', ownerId, 'people', '777', 'chat', '2026-09', '.history')));
  } finally { f.close(); }
});

test('Б-08: personal_chat собирает историю по user_id, сохраняет профиль и управляется паузой и отменой', async () => {
  const f = fixture();
  try {
    const added = await f.call(receiverToken, 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' });
    assert.equal(added.success, true);
    assert.equal(added.data.chat_id, '777');
    assert.equal(added.data.mode, 'personal_chat');
    assert.equal(added.data.status, 'enabled');
    assert.equal(f.collected[0].mode, 'history', 'сбор истории начинается после подключения');
    for (const id of ['101', '102']) assert.ok(existsSync(join(f.root, 'personal', ownerId, 'people', '777', 'chat', '2026-09', `${id}.md`)));
    const started = await f.call('personal-chat-system', 'collect_start', { ref: 'https://t.me/anna_test', mode: 'history', manifest: [101, 102], limit: 2 });
    assert.equal(started.success, true);
    assert.equal(started.data.state, 'completed');
    assert.equal(f.collected[0].source.chatId, '777');
    assert.equal(f.collected[0].mode, 'history');
    for (const id of ['101', '102']) assert.ok(existsSync(join(f.root, 'personal', ownerId, 'people', '777', 'chat', '2026-09', `${id}.md`)));
    const profile = readFileSync(join(f.root, 'personal', ownerId, 'people', '777', 'profile.md'), 'utf8');
    assert.match(profile, /Анна Первая/);
    assert.match(profile, /anna_test/);
    await f.coordinator.pollPersonalChats();
    assert.equal(f.collected.at(-1)?.mode, 'updates');
    await f.call(receiverToken, 'collect_pause', { ref: 'https://t.me/anna_test' });
    const beforePausedPoll = f.collected.length;
    await f.coordinator.pollPersonalChats();
    assert.equal(f.collected.length, beforePausedPoll);
    assert.equal((await f.call(receiverToken, 'collect_pause', { ref: 'https://t.me/anna_test' })).data.source.status, 'paused');
    assert.equal((await f.call(receiverToken, 'collect_cancel', { ref: 'https://t.me/anna_test' })).success, true);
  } finally { f.close(); }
});

test('Б-08: только Приёмщик подключает личную переписку; внутренний опрос получает обновления', async () => {
  const f = fixture();
  try {
    const before = f.archive.getState();
    const denied = await f.call('personal-chat-system', 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' });
    assert.equal(denied.error.code, 'forbidden');
    assert.equal(f.collected.length, 0);
    assert.deepEqual((await f.call(receiverToken, 'collect_status')).data.sources, []);
    assert.deepEqual(f.archive.getState(), before);
    assert.equal((await f.call(receiverToken, 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' })).success, true);
    await f.coordinator.pollPersonalChats();
    assert.deepEqual(f.collected.map((item) => item.mode), ['history', 'updates']);
  } finally { f.close(); }
});

test('Б-08: подключённая переписка после перезапуска продолжает обновления без повторного сбора истории', async () => {
  const first = fixture();
  try {
    const added = await first.call(receiverToken, 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' });
    assert.equal(added.success, true);
    assert.deepEqual(first.collected.map((item) => item.mode), ['history']);
  } finally { first.close(); }
  const reopened = fixture(first.root);
  try {
    const records = () => (reopened.archive.getState().records as Array<{ archive_id: string; revision: number }>).map((item) => ({ archive_id: item.archive_id, revision: item.revision }));
    const before = records();
    await reopened.coordinator.pollPersonalChats();
    assert.deepEqual(reopened.collected.map((item) => item.mode), ['updates']);
    assert.deepEqual(records(), before);
    assert.equal((await reopened.call(receiverToken, 'collect_status')).data.sources[0].source.status, 'enabled');
  } finally { reopened.close(); }
});

test('Б-08: адаптер сбора читает JSON list_messages поставщика и не принимает произвольный текст за пустую историю', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const page = await collectTelegramPage(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return JSON.stringify({ results: [{ id: 101, sender: 'Анна (@anna_test) [id=777]', date: '2026-09-10T10:00:00+00:00', text: 'Первое сообщение' }] });
  }, { source: { chatId: '777', title: 'Анна', username: 'anna_test' }, cursor: null, limit: 100, mode: 'history' });
  assert.deepEqual(calls, [{ name: 'list_messages', args: { chat_id: '777', limit: 100, from_date: '1970-01-01' } }]);
  assert.equal(page.messages[0].id, 101);
  assert.equal(page.messages[0].publishedAt, '2026-09-10T10:00:00+00:00');
  assert.equal(page.messages[0].text, 'Первое сообщение');
  await assert.rejects(() => collectTelegramPage(async () => 'ID: 101 | Message: Первое сообщение', { source: { chatId: '777' }, cursor: null, limit: 100 }), /invalid collection page/);
});

test('Б-08: история проходит границу дня, а переполненный день не объявляется собранным', async () => {
  const rows = [
    { id: 1, sender: 'Анна', date: '2026-09-10T10:00:00+00:00', text: 'Первое' },
    { id: 2, sender: 'Анна', date: '2026-09-11T10:00:00+00:00', text: 'Второе' },
    { id: 3, sender: 'Анна', date: '2026-09-12T10:00:00+00:00', text: 'Третье' },
  ];
  const requests: Array<Record<string, unknown>> = [];
  const call = async (_name: string, args: Record<string, unknown>) => {
    requests.push(args);
    return JSON.stringify({ results: rows.filter((row) => row.date.slice(0, 10) >= String(args.from_date) && (!args.to_date || row.date.slice(0, 10) <= String(args.to_date))).slice(0, Number(args.limit)) });
  };
  const source = { chatId: '777', title: 'Анна' };
  const first = await collectTelegramPage(call, { source, cursor: null, limit: 2, mode: 'history' });
  assert.equal(first.nextCursor, 'boundary:2026-09-11');
  assert.equal(first.done, false);
  const boundary = await collectTelegramPage(call, { source, cursor: first.nextCursor, limit: 2, mode: 'history' });
  assert.equal(boundary.nextCursor, 'from:2026-09-12');
  const final = await collectTelegramPage(call, { source, cursor: boundary.nextCursor, limit: 2, mode: 'history' });
  assert.deepEqual(final.messages.map((row: any) => row.id), [3]);
  assert.equal(final.done, true);
  assert.deepEqual(requests.map((request) => [request.from_date, request.to_date]), [['1970-01-01', undefined], ['2026-09-11', '2026-09-11'], ['2026-09-12', undefined]]);
  await assert.rejects(() => collectTelegramPage(async () => JSON.stringify({ results: rows.slice(0, 2).map((row) => ({ ...row, date: '2026-09-11T10:00:00+00:00' })) }), { source, cursor: 'boundary:2026-09-11', limit: 2, mode: 'history' }), /one-day collection limit/);
});

test('П-03: JSON list_messages поставщика сохраняет сообщение канала через координатор', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-channel-json-'));
  const archive = new Archive({ rootDir: root, ownerId, now });
  const coordinator = new Coordinator({ archive, ownerId, now, telegram: {
    resolveSource: () => ({ chatId: '-1001', title: 'Канал', kind: 'channel' }),
    collect: (args) => collectTelegramPage(async () => JSON.stringify({ results: [
      { id: 101, sender: 'Автор [id=777]', date: '2026-09-10T10:00:00+00:00', text: 'Сообщение канала' },
    ] }), args),
  } });
  try {
    assert.equal((await coordinator.callTool('source_add', { ref: 'https://t.me/channel_test', mode: 'full' })).success, true);
    const collected = await coordinator.callTool('collect_start', { ref: 'https://t.me/channel_test', manifest: [101], limit: 1 });
    assert.equal(collected.success, true);
    assert.equal((collected as any).data.state, 'completed');
    assert.match(archive.read('telegram_channel:-1001:101').content, /Сообщение канала/);
  } finally { coordinator.close(); archive.close(); }
});

test('Б-08: поиск по человеку возвращает его переписку и пересылку, но исключает чужие записи', async () => {
  const f = fixture();
  try {
    const added = await f.call(receiverToken, 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' });
    assert.equal(added.success, true);
    assert.equal((await f.call('personal-chat-system', 'collect_start', { ref: 'https://t.me/anna_test', mode: 'history', manifest: [101], limit: 1 })).success, true);
    await f.call(receiverToken, 'inbox_save', f.input('20', 'Пересылка Анны', { forward_origin: { type: 'user', sender_user: { id: 777 } } }));
    await f.call(receiverToken, 'inbox_save', f.input('21', 'Пересылка Бориса', { forward_origin: { type: 'user', sender_user: { id: 888 } } }));
    const found = await f.call(talkerToken, 'knowledge_search', { query: 'сообщение', chat_id: ownerId, person_id: '777', limit: 10 });
    assert.equal(found.success, true);
    const paths = found.data.results.map((item: any) => item.target_uri);
    assert.ok(paths.some((path: string) => path.includes('/people/777/chat/2026-09/101.md')));
    assert.ok(paths.some((path: string) => path.includes('/forwards/')));
    assert.ok(paths.every((path: string) => !path.includes('/people/888/') && !path.includes('/notes/')));
    assert.equal(paths.filter((path: string) => path.includes('/forwards/')).length, 1);
    const denied = await f.call(sharedToken, 'knowledge_search', { query: 'сообщение', chat_id: '-10011', person_id: '777', limit: 10 });
    assert.equal(denied.error.code, 'forbidden');
    assert.equal(f.searched.length, 2, 'отказ чужому принципалу не обращается к поиску');
  } finally { f.close(); }
});

test('Б-08: смена имени обновляет profile.md и сохраняет прежнее имя', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(receiverToken, 'source_add', { ref: 'https://t.me/anna_test', mode: 'personal_chat' })).success, true);
    assert.equal((await f.call('personal-chat-system', 'collect_start', { ref: 'https://t.me/anna_test', mode: 'history', manifest: [101], limit: 1 })).success, true);
    f.setPersonName('Анна Новая');
    assert.equal((await f.call('personal-chat-system', 'collect_start', { ref: 'https://t.me/anna_test', mode: 'updates', manifest: [102], limit: 1 })).success, true);
    const profile = readFileSync(join(f.root, 'personal', ownerId, 'people', '777', 'profile.md'), 'utf8');
    assert.match(profile, /Анна Новая/);
    assert.match(profile, /previous_names[\s\S]*Анна Первая/);
  } finally { f.close(); }
});

test('М-01: вложение из list_messages сохраняется пометкой skipped без скачивания', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-media-mark-'));
  const archive = new Archive({ rootDir: root, ownerId, now });
  const calls: string[] = [];
  const rows = [
    { id: 101, sender: 'Автор', date: '2026-09-10T10:00:00+00:00', text: 'Фото', media: 'photo' },
    { id: 102, sender: 'Автор', date: '2026-09-10T10:01:00+00:00', text: '', media: 'document: report.pdf' },
    { id: 103, sender: 'Автор', date: '2026-09-10T10:02:00+00:00', text: 'Голос', media: 'voice' },
    { id: 104, sender: 'Автор', date: '2026-09-10T10:03:00+00:00', text: 'Стикер', media: 'sticker 😀' },
    { id: 105, sender: 'Автор', date: '2026-09-10T10:04:00+00:00', text: 'Опрос', media: 'poll' },
    { id: 106, sender: 'Автор', date: '2026-09-10T10:05:00+00:00', text: 'Просто текст' },
  ];
  const coordinator = new Coordinator({ archive, ownerId, now, telegram: {
    resolveSource: () => ({ chatId: '-1001', title: 'Канал', kind: 'channel' }),
    collect: (args) => collectTelegramPage(async (name: string) => { calls.push(name); return JSON.stringify({ results: rows }); }, args),
  } });
  try {
    await coordinator.callTool('source_add', { ref: 'https://t.me/channel_test', mode: 'full' });
    const manifest = rows.map((row) => row.id);
    assert.equal((await coordinator.callTool('collect_start', { ref: 'https://t.me/channel_test', manifest, limit: 6 }) as any).data.state, 'completed');
    const marks = (id: number) => ((archive.read(`telegram_channel:-1001:${id}`).metadata.attachments ?? []) as any[]).map((a: any) => [a.type, a.name, a.state, a.path]);
    assert.deepEqual(marks(101), [['image', '', 'skipped', null]]);
    assert.deepEqual(marks(102), [['document', 'report.pdf', 'skipped', null]]);
    assert.deepEqual(marks(103), [['audio', '', 'skipped', null]]);
    assert.deepEqual(marks(104), [['sticker', '', 'skipped', null]]);
    assert.deepEqual(marks(105), [['other', '', 'skipped', null]]);
    assert.deepEqual(marks(106), []);
    assert.deepEqual([...new Set(calls)], ['list_messages']);
    const revision = archive.read('telegram_channel:-1001:101').metadata.revision;
    assert.equal((await coordinator.callTool('collect_start', { ref: 'https://t.me/channel_test', manifest, limit: 6 }) as any).data.state, 'completed');
    assert.equal(archive.read('telegram_channel:-1001:101').metadata.revision, revision);
  } finally { coordinator.close(); archive.close(); }
});

test('М-02: настройка «скачивать картинки» выключена при подключении и переключается кнопкой /status', async () => {
  const f = fixture();
  const sent: Array<{ text: string; options: any }> = [];
  const bot = { async sendMessage(_chatId: string, text: string, options: any) { sent.push({ text, options }); }, async answerCallbackQuery() {} };
  try {
    const saved = await f.call(receiverToken, 'inbox_save', f.input('41', '@anna_test'));
    const refId = saved.data.offers[0].ref_id;
    assert.equal((await f.call(receiverToken, 'source_add', { ref_id: refId, mode: 'personal_chat', download_images: true })).error.code, 'invalid_argument');
    assert.equal((await f.call(receiverToken, 'source_add', { ref_id: refId, mode: 'personal_chat' })).data.download_images, false);
    assert.equal((await f.call(talkerToken, 'source_settings_set', { ref_id: refId, download_images: true })).error.code, 'forbidden');
    assert.equal((await f.call(receiverToken, 'source_settings_set', { ref_id: refId, download_images: 'yes' })).error.code, 'invalid_argument');

    await handleReceiverUpdate(message(42, '/status'), ownerId, f.client, bot);
    const button = sent.at(-1)!.options.reply_markup.inline_keyboard.flat().find((b: any) => /Картинки/.test(b.text));
    assert.equal(button.text, '🖼 Картинки: выкл');
    await handleReceiverUpdate({ callback_query: { id: 'images', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: button.callback_data } }, ownerId, f.client, bot);
    assert.match(sent.at(-1)!.text, /Картинки .*включены/);
    assert.equal((await f.call(receiverToken, 'collect_status', { ref_id: refId })).data.source.download_images, true);
    await handleReceiverUpdate(message(43, '/status'), ownerId, f.client, bot);
    assert.ok(sent.at(-1)!.options.reply_markup.inline_keyboard.flat().some((b: any) => b.text === '🖼 Картинки: вкл'));
  } finally { f.close(); }
});

test('М-02: настройка не применяется к источнику «только сводка», старая база получает false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-media-setting-'));
  const open = () => {
    const archive = new Archive({ rootDir: root, ownerId, now });
    return { archive, coordinator: new Coordinator({ archive, ownerId, now, telegram: { resolveSource: (ref: string) => ({ chatId: ref.endsWith('summary_test') ? '-1002' : '-1001', title: 'Чат', kind: 'group' }), collect: () => ({ messages: [] }) } as any }) };
  };
  let { archive, coordinator } = open();
  try {
    await coordinator.callTool('source_add', { ref: 'https://t.me/summary_test', mode: 'summary' });
    assert.equal((await coordinator.callTool('source_settings_set', { ref: 'https://t.me/summary_test', download_images: true }) as any).error.code, 'invalid_argument');
    await coordinator.callTool('source_add', { ref: 'https://t.me/full_test', mode: 'full' });
    coordinator.close(); archive.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'state.sqlite'));
    db.exec('ALTER TABLE sources DROP COLUMN download_images'); db.close();
    ({ archive, coordinator } = open());
    assert.equal((await coordinator.callTool('collect_status', { ref: 'https://t.me/full_test' }) as any).data.source.download_images, false);
  } finally { coordinator.close(); archive.close(); }
});

test('М-03: фото скачивается только при включённой настройке, файл из /exchange удаляется, сбой не останавливает сбор', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-media-collect-'));
  const exchangeDir = mkdtempSync(join(tmpdir(), 'telegram-memory-exchange-'));
  const archive = new Archive({ rootDir: root, ownerId, now });
  const downloads: any[] = [];
  const rows = [
    { id: 101, sender: 'Автор', date: '2026-09-10T10:00:00+00:00', text: 'Фото', media: 'photo' },
    { id: 102, sender: 'Автор', date: '2026-09-10T10:01:00+00:00', text: 'Док', media: 'document: a.pdf' },
    { id: 103, sender: 'Автор', date: '2026-09-10T10:02:00+00:00', text: 'Битое фото', media: 'photo' },
  ];
  const callTool = async (name: string, args: any) => {
    if (name === 'list_messages') return JSON.stringify({ results: rows });
    downloads.push(args);
    if (args.message_id === 103) return 'Download failed for message 103.';
    const { writeFileSync } = await import('node:fs');
    const saved = args.file_path.replace(/\.jpg$/, '.jpeg');
    writeFileSync(saved, 'jpeg-bytes');
    return `Media downloaded to ${saved}.`;
  };
  const coordinator = new Coordinator({ archive, ownerId, now, telegram: {
    resolveSource: () => ({ chatId: '-1001', title: 'Канал', kind: 'channel' }),
    collect: (args) => collectTelegramPage(callTool, { ...args, exchangeDir }),
  } });
  const ref = 'https://t.me/channel_test';
  const attachment = (id: number) => ((archive.read(`telegram_channel:-1001:${id}`).metadata.attachments ?? []) as any[])[0];
  try {
    await coordinator.callTool('source_add', { ref, mode: 'full' });
    await coordinator.callTool('collect_start', { ref, manifest: [101], limit: 1 });
    assert.equal(downloads.length, 0);
    assert.equal(attachment(101).state, 'skipped');

    await coordinator.callTool('source_settings_set', { ref, download_images: true });
    assert.equal((await coordinator.callTool('collect_start', { ref, manifest: [101, 102, 103], limit: 3 }) as any).data.state, 'completed');
    assert.deepEqual(downloads.map((d) => [d.chat_id, d.message_id]), [['-1001', 101], ['-1001', 103]]);
    assert.ok(downloads.every((d) => d.file_path.startsWith(exchangeDir)));
    const photo = attachment(101);
    assert.deepEqual([photo.type, photo.state], ['image', 'ready']);
    assert.equal(readFileSync(join(root, photo.path), 'utf8'), 'jpeg-bytes');
    assert.equal(attachment(102).state, 'skipped');
    assert.deepEqual([attachment(103).type, attachment(103).state], ['image', 'unavailable']);
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(exchangeDir), []);
  } finally { coordinator.close(); archive.close(); }
});

function fileMessage(updateId: number, fields: Record<string, unknown>, from = 12345) {
  return { update_id: updateId, message: { message_id: updateId, date: Math.floor(now().getTime() / 1000), from: { id: from }, chat: { id: from, type: 'private' }, ...fields } };
}

test('М-04: файл владельца поддерживаемого формата сохраняется в личную область, прочие отклоняются', async () => {
  const f = fixture();
  const sent: string[] = [];
  const downloaded: string[] = [];
  const files: Record<string, string> = { pdf: '%PDF-1.7', exe: 'MZ', photo: 'jpeg-bytes' };
  const bot = {
    async sendMessage(_chatId: string, text: string) { sent.push(text); },
    async answerCallbackQuery() {},
    async downloadFile(fileId: string) { downloaded.push(fileId); return new TextEncoder().encode(files[fileId]); },
  };
  const attachments = (archiveId: string) => (f.archive.read(archiveId).metadata.attachments ?? []) as any[];
  try {
    await handleReceiverUpdate(fileMessage(60, { document: { file_id: 'pdf', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 8 }, caption: 'Отчёт' }), ownerId, f.client, bot);
    assert.match(sent.at(-1)!, /^Сохранено/);
    const saved = f.calls.filter((c) => c.name === 'inbox_save').at(-1)!;
    assert.equal(saved.args.text, 'Отчёт');
    const pdfRecord = f.archive.getState().records.find((r: any) => String(r.path).endsWith('_tg.md'))! as any;
    const [pdf] = attachments(pdfRecord.archive_id);
    assert.deepEqual([pdf.type, pdf.name, pdf.state], ['document', 'report.pdf', 'ready']);
    assert.equal(readFileSync(join(f.root, pdf.path), 'utf8'), '%PDF-1.7');

    await handleReceiverUpdate(fileMessage(60, { document: { file_id: 'pdf', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 8 }, caption: 'Отчёт' }), ownerId, f.client, bot);
    assert.equal(f.archive.getState().records.length, 1);

    await handleReceiverUpdate(fileMessage(61, { document: { file_id: 'exe', file_name: 'setup.exe', file_size: 2 } }), ownerId, f.client, bot);
    assert.equal(sent.at(-1), 'Формат не поддерживается, файл не сохранён');
    assert.equal(f.archive.getState().records.length, 1);

    await handleReceiverUpdate(fileMessage(62, { photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'photo', file_size: 10 }], forward_origin: { type: 'channel', chat: { id: -1009, username: 'some_channel' } } }), ownerId, f.client, bot);
    const forward = f.archive.getState().records.find((r: any) => String(r.path).endsWith('_fwd.md'))! as any;
    assert.deepEqual(attachments(forward.archive_id).map((a) => [a.type, a.state]), [['image', 'ready']]);
    assert.ok(!downloaded.includes('small'));

    const before = downloaded.length;
    await handleReceiverUpdate(fileMessage(63, { video: { file_id: 'big', file_name: 'clip.mp4', file_size: 21 * 1024 * 1024 } }), ownerId, f.client, bot);
    assert.equal(sent.at(-1), 'Файл больше 20 МБ: Telegram не даёт боту его скачать');
    assert.equal(downloaded.length, before);

    const calls = f.calls.length;
    await handleReceiverUpdate(fileMessage(64, { document: { file_id: 'pdf', file_name: 'report.pdf', file_size: 8 } }, 999), ownerId, f.client, bot);
    assert.equal(f.calls.length, calls);
  } finally { f.close(); }
});
