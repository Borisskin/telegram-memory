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
const tokens = { receiver: 'scheduled-receiver', mine: 'scheduled-mine', shared: 'scheduled-shared' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: hash(tokens.receiver) },
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: hash(tokens.mine) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: hash(tokens.shared) },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-scheduled-'));
  const clock = { time: Date.parse('2026-09-25T06:00:00.000Z') }; // 09:00 в Москве.
  const archive = new Archive({ rootDir: root, ownerId, now: () => new Date(clock.time) });
  const access = createAccess({ principals, legacyToken: 'scheduled-system', ownerId, archive });
  const history = new Map<string, Array<{ id: number; sender: string; date: string; text: string }>>();
  const telegramCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const telegram = {
    resolveSource(ref: string) {
      const id = ref.includes('second') ? '-1002' : ref.includes('full') ? '-1003' : '-1001';
      return { chatId: id, title: id === '-1002' ? 'Вторая группа' : id === '-1003' ? 'Полная группа' : 'Первая группа', kind: 'group' as const };
    },
    history(args: Record<string, unknown>) {
      telegramCalls.push({ name: 'list_messages', args });
      return JSON.stringify({ results: history.get(String(args.chat_id)) ?? [] });
    },
    recentGroups(args: Record<string, unknown>) {
      telegramCalls.push({ name: 'list_chats', args });
      return JSON.stringify({ results: [] });
    },
  };
  const coordinator = new Coordinator({ archive, ownerId, now: () => new Date(clock.time), access, telegram });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', headers: { authorization: `Bearer ${token}` }, params: { name, arguments: args } }) as any;
    return response.result.structuredContent as any;
  };
  const calls: Array<{ bot: string; name: string; args: Record<string, unknown> }> = [];
  const client = (bot: 'receiver' | 'mine') => createCoordinatorClient({ endpoint: 'http://coordinator.test/mcp', token: tokens[bot], fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body));
    calls.push({ bot, name: request.params.name, args: request.params.arguments });
    const response = await handler({ ...request, headers: { authorization: `Bearer ${tokens[bot]}` } });
    return new Response(JSON.stringify(response), { status: 200 });
  } });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'fake-key' },
    receiver: { name: 'receiver', token: 'fake-receiver-token', coordToken: tokens.receiver },
    talkers: [{ name: 'mine', token: 'fake-mine-token', coordToken: tokens.mine, model: 'digest-model', ownerOnly: true, digest: true }],
  };
  return { archive, coordinator, clock, history, telegramCalls, call, calls, client, config, close() { coordinator.close(); archive.close(); } };
}

const digestRequest = { scheduled: true, chat_id: ownerId };

function update(id: number, text: string) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text } };
}

async function runReceiver(f: ReturnType<typeof fixture>, updates: unknown[]) {
  const controller = new AbortController();
  const sent: string[] = [];
  let polls = 0;
  try {
    await runBots({
      config: { ...f.config, talkers: [] }, signal: controller.signal,
      botApiFactory: () => ({ async getUpdates() { if (++polls === 1) return updates as any; controller.abort(); return []; }, async sendMessage(_chatId, text) { sent.push(text); } }),
      coordinatorClientFactory: () => f.client('receiver'), log: () => {},
    });
    return sent;
  } finally { controller.abort(); }
}

async function runScheduled(f: ReturnType<typeof fixture>, options: { sendFails?: boolean; modelFails?: boolean } = {}) {
  const controller = new AbortController();
  const sent: string[] = [];
  const modelRequests: unknown[] = [];
  let polls = 0;
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: (name) => ({
        async getUpdates() {
          if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
          if (++polls > 4) controller.abort();
          return [];
        },
        async sendMessage(_chatId, text) { if (options.sendFails) throw new Error('Bot API unavailable'); sent.push(text); },
      }),
      coordinatorClientFactory: (name) => f.client(name === 'receiver' ? 'receiver' : 'mine'),
      modelClientFactory: () => ({ async complete(request) {
        modelRequests.push(request);
        if (options.modelFails) throw new Error('proxy unavailable');
        return { choices: [{ message: { role: 'assistant', content: 'Сводка по группам' } }] };
      } }),
      log: () => {}, sleep: async () => {},
    });
    return { sent, modelRequests };
  } finally { controller.abort(); }
}

test('Б-12: расписание берёт только summary-группы, пропускает пустые и выдаёт batch_id', async () => {
  const f = fixture();
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Новое обсуждение' }]);
  f.history.set('-1002', []);
  try {
    for (const ref of ['https://t.me/first', 'https://t.me/second']) assert.equal((await f.call(tokens.receiver, 'source_add', { ref, mode: 'summary' })).success, true);
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/full', mode: 'full' })).success, true);
    f.archive.saveTelegram({ kind: 'group', chatId: '-1003', messageId: '9', text: 'Не включать', publishedAt: '2026-09-25T05:00:00Z' });
    const result = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(result.success, true);
    assert.equal(result.data.kind, 'raw');
    assert.ok(typeof result.data.batch_id === 'string' && result.data.batch_id);
    assert.match(result.data.markdown, /Первая группа[\s\S]*Новое обсуждение/);
    assert.doesNotMatch(result.data.markdown, /Вторая группа|Полная группа|Не включать/);
    assert.deepEqual(f.telegramCalls.map((item) => item.args.chat_id).sort(), ['-1001', '-1002']);
  } finally { f.close(); }
});

test('Б-12: окно остаётся прежним до digest_commit и после подтверждения исключает старые сообщения', async () => {
  const f = fixture();
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Пропущенное сообщение' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    const first = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(first.success, true);
    assert.equal(first.data.kind, 'raw');
    assert.match(first.data.markdown, /Пропущенное сообщение/);
    f.clock.time = Date.parse('2026-09-26T06:00:00Z');
    f.history.get('-1001')!.push({ id: 2, sender: 'Б', date: '2026-09-26T05:00:00Z', text: 'Новое сообщение' });
    const retry = await f.call(tokens.mine, 'digest', digestRequest);
    assert.match(retry.data.markdown, /Пропущенное сообщение/);
    assert.match(retry.data.markdown, /Новое сообщение/);
    assert.equal((await f.call(tokens.mine, 'digest_commit', { batch_id: retry.data.batch_id })).success, true);
    f.clock.time = Date.parse('2026-09-26T06:01:00Z');
    const afterCommit = await f.call(tokens.mine, 'digest', digestRequest);
    assert.doesNotMatch(String(afterCommit.data?.markdown ?? ''), /Пропущенное сообщение|Новое сообщение/);
  } finally { f.close(); }
});

test('Б-12: до 09:00 Москвы расписание не срабатывает, ровно в 09:00 готовит партию', async () => {
  const f = fixture();
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Утренняя тема' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    f.clock.time = Date.parse('2026-09-25T05:59:59Z');
    const early = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(early.data.kind, 'not_due');
    assert.deepEqual(f.telegramCalls, []);
    f.clock.time = Date.parse('2026-09-25T06:00:00Z');
    const due = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(due.data.kind, 'raw');
    assert.match(due.data.markdown, /Утренняя тема/);
  } finally { f.close(); }
});

test('Б-12: сообщение после пустой проверки не теряется к следующему дню', async () => {
  const f = fixture();
  f.history.set('-1001', []);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    const empty = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(empty.data.kind, 'empty');
    f.history.get('-1001')!.push({ id: 2, sender: 'Б', date: '2026-09-25T07:00:00Z', text: 'После пустой проверки' });
    f.clock.time = Date.parse('2026-09-26T06:00:00Z');
    const next = await f.call(tokens.mine, 'digest', digestRequest);
    assert.equal(next.data.kind, 'raw');
    assert.match(next.data.markdown, /После пустой проверки/);
  } finally { f.close(); }
});

test('Б-12: settings_set доступно только Приёмщику и отвергает неверный час без изменения настройки', async () => {
  const f = fixture();
  try {
    const denied = await f.call(tokens.mine, 'settings_set', { digest_time: '10:30' });
    assert.equal(denied.error.code, 'forbidden');
    const accepted = await f.call(tokens.receiver, 'settings_set', { digest_time: '10:30' });
    assert.equal(accepted.success, true);
    const invalid = await f.call(tokens.receiver, 'settings_set', { digest_time: '25:61' });
    assert.equal(invalid.error.code, 'invalid_argument');
  } finally { f.close(); }
});

test('Б-12: /digest_time Приёмщика меняет час; неверный ввод даёт подсказку и не сохраняется как заметка', async () => {
  const f = fixture();
  try {
    const sent = await runReceiver(f, [update(10, '/digest_time 10:30'), update(11, '/digest_time 25:61')]);
    assert.deepEqual(f.calls.filter((item) => item.name === 'settings_set').map((item) => item.args), [{ digest_time: '10:30' }]);
    assert.ok(!f.calls.some((item) => item.name === 'inbox_save'));
    assert.match(sent[0] ?? '', /10:30/);
    assert.match(sent[1] ?? '', /формат|час|время|HH:MM/i);
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-12: в 09:00 Москвы Собеседник отправляет одну сводку, подтверждает окно и не дублирует её после перезапуска', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Новая тема' }]);
  f.history.set('-1002', [{ id: 2, sender: 'Б', date: '2026-09-25T05:40:00Z', text: 'Другая тема' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/second', mode: 'summary' })).success, true);
    t.mock.timers.setTime(f.clock.time);
    const first = await runScheduled(f);
    assert.equal(first.modelRequests.length, 1);
    assert.match(JSON.stringify(first.modelRequests[0]), /Новая тема/);
    assert.match(JSON.stringify(first.modelRequests[0]), /Другая тема/);
    assert.deepEqual(first.sent, ['Сводка по группам']);
    assert.equal(f.calls.filter((item) => item.name === 'digest_commit').length, 1);
    const restarted = await runScheduled(f);
    assert.deepEqual(restarted.sent, []);
    assert.equal(restarted.modelRequests.length, 0);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('Б-12: сбой digest_commit повторяет подтверждение той же партии без повторной отправки', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  const controller = new AbortController();
  const sent: string[] = [];
  const batches: string[] = [];
  let polls = 0;
  let modelCalls = 0;
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Факт' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    t.mock.timers.setTime(f.clock.time);
    const mine = f.client('mine');
    await runBots({ config: f.config, signal: controller.signal,
      botApiFactory: (name) => ({
        async getUpdates() {
          if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
          if (++polls > 3) { controller.abort(); return []; }
          t.mock.timers.setTime(f.clock.time + (polls - 1) * 60_000);
          return [];
        },
        async sendMessage(_chatId, text) { sent.push(text); },
      }),
      coordinatorClientFactory: (name) => name === 'receiver' ? f.client('receiver') : { async callTool(tool, args = {}) {
        if (tool === 'digest_commit') {
          batches.push(String(args.batch_id));
          if (batches.length === 1) throw new Error('Coordinator temporarily unavailable');
        }
        return mine.callTool(tool, args);
      } },
      modelClientFactory: () => ({ async complete() { modelCalls += 1; return { choices: [{ message: { role: 'assistant', content: 'Сводка по группам' } }] }; } }),
      log: () => {}, sleep: async () => {},
    });
    assert.deepEqual(sent, ['Сводка по группам']);
    assert.equal(modelCalls, 1);
    assert.equal(batches.length, 2);
    assert.equal(batches[0], batches[1]);
    assert.equal((await f.call(tokens.mine, 'digest_commit', { batch_id: batches[0] })).success, true, 'повтор подтверждённой партии идемпотентен');
  } finally { controller.abort(); f.close(); t.mock.timers.reset(); }
});

test('Б-12: повторные сбои модели получают нарастающий отступ даже при пустом опросе', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  const controller = new AbortController();
  let polls = 0;
  let modelCalls = 0;
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Факт' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    t.mock.timers.setTime(f.clock.time);
    await runBots({ config: f.config, signal: controller.signal,
      botApiFactory: (name) => ({
        async getUpdates() {
          if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
          if (++polls > 12) { controller.abort(); return []; }
          t.mock.timers.setTime(f.clock.time + (polls - 1) * 30_000);
          return [];
        },
      }),
      coordinatorClientFactory: (name) => f.client(name === 'receiver' ? 'receiver' : 'mine'),
      modelClientFactory: () => ({ async complete() { modelCalls += 1; throw new Error('proxy unavailable'); } }),
      log: () => {}, sleep: async () => {},
    });
    assert.equal(modelCalls, 3, 'за шесть минут модель вызывается через 0, 1 и 3 минуты');
  } finally { controller.abort(); f.close(); t.mock.timers.reset(); }
});

test('Б-12: сбой модели или Bot API не подтверждает окно, и следующая сводка включает пропущенное', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  f.history.set('-1001', [{ id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Пропущенный факт' }]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    t.mock.timers.setTime(f.clock.time);
    const modelFailure = await runScheduled(f, { modelFails: true });
    assert.ok(modelFailure.modelRequests.length >= 1);
    assert.equal(f.calls.filter((item) => item.name === 'digest_commit').length, 0);
    f.clock.time = Date.parse('2026-09-26T06:00:00Z');
    t.mock.timers.setTime(f.clock.time);
    f.history.get('-1001')!.push({ id: 2, sender: 'Б', date: '2026-09-26T05:00:00Z', text: 'Вчерашний факт' });
    const sendFailure = await runScheduled(f, { sendFails: true });
    assert.ok(sendFailure.modelRequests.length >= 1);
    assert.equal(f.calls.filter((item) => item.name === 'digest_commit').length, 0);
    f.clock.time = Date.parse('2026-09-27T06:00:00Z');
    t.mock.timers.setTime(f.clock.time);
    f.history.get('-1001')!.push({ id: 3, sender: 'В', date: '2026-09-27T05:00:00Z', text: 'Сегодняшний факт' });
    const recovered = await runScheduled(f);
    assert.match(JSON.stringify(recovered.modelRequests), /Пропущенный факт/);
    assert.match(JSON.stringify(recovered.modelRequests), /Вчерашний факт/);
    assert.match(JSON.stringify(recovered.modelRequests), /Сегодняшний факт/);
    assert.equal(recovered.sent.length, 1);
    assert.equal(f.calls.filter((item) => item.name === 'digest_commit').length, 1);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('Б-12: если в summary-группах нет новых сообщений, модель и отправка не вызываются', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    t.mock.timers.setTime(f.clock.time);
    const result = await runScheduled(f);
    assert.ok(f.calls.some((item) => item.name === 'digest' && item.args.scheduled === true), 'таймер должен проверить пустую выборку');
    assert.deepEqual(result.modelRequests, []);
    assert.deepEqual(result.sent, []);
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('Б-12: /digest_time меняет расписание со следующего дня', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture();
  f.history.set('-1001', [
    { id: 1, sender: 'А', date: '2026-09-25T05:30:00Z', text: 'Первый день' },
  ]);
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: 'https://t.me/first', mode: 'summary' })).success, true);
    f.clock.time = Date.parse('2026-09-25T05:30:00Z'); // 08:30 Москвы.
    t.mock.timers.setTime(f.clock.time);
    await runReceiver(f, [update(30, '/digest_time 10:30')]);
    assert.equal((await f.call(tokens.receiver, 'settings_set', { digest_time: '25:61' })).error.code, 'invalid_argument');
    f.clock.time = Date.parse('2026-09-25T06:00:00Z'); // Старое срабатывание в 09:00.
    t.mock.timers.setTime(f.clock.time);
    assert.equal((await runScheduled(f)).sent.length, 1);
    f.history.get('-1001')!.push({ id: 2, sender: 'Б', date: '2026-09-26T05:45:00Z', text: 'Второй день' });
    f.clock.time = Date.parse('2026-09-26T06:00:00Z');
    t.mock.timers.setTime(f.clock.time);
    assert.deepEqual((await runScheduled(f)).sent, [], 'на следующий день старый час уже не действует');
    f.clock.time = Date.parse('2026-09-26T07:30:00Z'); // Новое срабатывание в 10:30.
    t.mock.timers.setTime(f.clock.time);
    const next = await runScheduled(f);
    assert.equal(next.sent.length, 1);
    assert.match(JSON.stringify(next.modelRequests), /Второй день/);
  } finally { f.close(); t.mock.timers.reset(); }
});
