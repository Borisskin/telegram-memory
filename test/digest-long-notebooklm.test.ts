import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as publicApi from '../src/index.ts';
import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';

const ownerId = '12345';
const tokens = { mine: 'long-digest-mine', receiver: 'long-digest-receiver', shared: 'long-digest-shared' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: hash(tokens.mine) },
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: hash(tokens.receiver) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: hash(tokens.shared) },
];
const request = (groups: string[] = ['https://t.me/group']) => ({ groups, from: '2026-09-01T00:00:00Z', to: '2026-09-09T00:00:00Z', scheduled: false, chat_id: ownerId });

function fixture() {
  const clock = { time: new Date('2026-09-25T12:00:00Z') };
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-long-digest-')), ownerId, now: () => clock.time });
  const access = createAccess({ principals, legacyToken: 'long-digest-system', ownerId, archive });
  const telegramCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gatewayCalls: Array<{ markdown: string; prompt: string }> = [];
  let gatewayError: unknown;
  const telegram = {
    resolveSource(ref: string) {
      if (ref.includes('private')) return { chatId: '777', title: 'Личная переписка', kind: 'user' } as any;
      if (ref.includes('channel')) return { chatId: '-1002', title: 'Канал', kind: 'channel' as const };
      return { chatId: '-1001', title: 'Группа', kind: 'group' as const };
    },
    history(args: Record<string, unknown>) {
      telegramCalls.push({ name: 'list_messages', args });
      return JSON.stringify({ results: [{ id: 1, sender: 'Участник', date: '2026-09-04T10:00:00Z', text: 'Обсуждали проект' }] });
    },
  };
  const notebookGateway = { async summarize(markdown: string, prompt: string) {
    gatewayCalls.push({ markdown, prompt });
    if (gatewayError) throw gatewayError;
    return 'Готовая сводка NotebookLM';
  } };
  const coordinator = new Coordinator({ archive, ownerId, now: () => clock.time, access, telegram, notebookGateway } as any);
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', headers: { authorization: `Bearer ${token}` }, params: { name, arguments: args } }) as any;
    return response.result.structuredContent as any;
  };
  const client = createCoordinatorClient({ endpoint: 'http://coordinator.test/mcp', token: tokens.mine, fetch: async (_url, init) => {
    const rpc = JSON.parse(String(init.body));
    const response = await handler({ ...rpc, headers: { authorization: `Bearer ${tokens.mine}` } });
    return new Response(JSON.stringify(response), { status: 200 });
  } });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'fake-key' },
    receiver: { name: 'receiver', token: 'fake-receiver-token', coordToken: tokens.receiver },
    talkers: [{ name: 'mine', token: 'fake-mine-token', coordToken: tokens.mine, model: 'fake-model', ownerOnly: true, digest: true }],
  };
  return { archive, clock, telegramCalls, gatewayCalls, call, client, config, setGatewayError(value: unknown) { gatewayError = value; }, close() { coordinator.close(); archive.close(); } };
}

async function runCommand(f: ReturnType<typeof fixture>, text: string) {
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
          if (++polls === 1) return [{ update_id: 1, message: { message_id: 1, date: 1_780_000_000, from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text } }];
          controller.abort();
          return [];
        },
        async sendMessage(_chatId, body) { sent.push(body); },
      }),
      coordinatorClientFactory: () => f.client,
      modelClientFactory: () => ({ async complete(input) { modelRequests.push(input); return { choices: [{ message: { role: 'assistant', content: 'Ответ модели прокси' } }] }; } }),
      log: () => {},
    });
    return { sent, modelRequests };
  } finally { controller.abort(); }
}

const createGateway = (publicApi as Record<string, unknown>).createNotebookGateway as ((options: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }) => { summarize(markdown: string, prompt: string): Promise<string> }) | undefined;

test('Б-11: публичный адаптер NotebookLM создаёт блокнот, добавляет текст, запрашивает и удаляет его', async () => {
  assert.equal(typeof createGateway, 'function', 'нужен публичный адаптер NotebookGateway');
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = createGateway!({ async callTool(name, args) {
    calls.push({ name, args });
    if (name === 'notebook_create') return { status: 'success', notebook_id: 'nb-test', notebook: { id: 'nb-test', title: 'Сводка', url: 'https://notebook.invalid/nb-test' }, message: 'Created' };
    if (name === 'source_add') return { status: 'success', ready: true, source_type: 'text', source_id: 'src-test', title: 'Материал' };
    if (name === 'notebook_query') return { status: 'success', answer: 'Итог из NotebookLM', question: args.query, conversation_id: 'conv', sources_used: ['src-test'], citations: [], references: [] };
    if (name === 'notebook_delete') return { status: 'success', message: 'Deleted' };
    throw new Error(`Unexpected NotebookLM tool: ${name}`);
  } });
  assert.equal(await gateway.summarize('# Материал', 'Составь сводку'), 'Итог из NotebookLM');
  assert.deepEqual(calls.map((item) => item.name), ['notebook_create', 'source_add', 'notebook_query', 'notebook_delete']);
  assert.equal(calls[1].args.notebook_id, 'nb-test');
  assert.equal(calls[1].args.source_type, 'text');
  assert.equal(calls[1].args.text, '# Материал');
  assert.equal(calls[1].args.wait, true);
  assert.equal(calls[2].args.notebook_id, 'nb-test');
  assert.equal(calls[2].args.query, 'Составь сводку');
  assert.deepEqual(calls[3].args, { notebook_id: 'nb-test', confirm: true });
});

test('Б-11: после ошибок добавления и запроса временный блокнот удаляется с confirm: true', async () => {
  assert.equal(typeof createGateway, 'function', 'нужен публичный адаптер NotebookGateway');
  for (const failedStep of ['source_add', 'notebook_query']) {
    const calls: string[] = [];
    const gateway = createGateway!({ async callTool(name, args) {
      calls.push(name);
      if (name === 'notebook_create') return { status: 'success', notebook_id: 'nb-test' };
      if (name === failedStep) return { status: 'error', error: `Failure at ${name}` };
      if (name === 'source_add') return { status: 'success', ready: true, source_id: 'src-test' };
      if (name === 'notebook_delete') { assert.deepEqual(args, { notebook_id: 'nb-test', confirm: true }); return { status: 'success', message: 'Deleted' }; }
      throw new Error(`Unexpected NotebookLM tool: ${name}`);
    } });
    await assert.rejects(() => gateway.summarize('# Материал', 'Составь сводку'));
    assert.equal(calls.at(-1), 'notebook_delete', `${failedStep} must still clean up the notebook`);
  }
});

test('Б-13: адаптер различает протухшие куки и лимит NotebookLM по ответам v0.11.7', async () => {
  assert.equal(typeof createGateway, 'function', 'нужен публичный адаптер NotebookGateway');
  const expiredCalls: string[] = [];
  const expired = createGateway!({ async callTool(name) {
    expiredCalls.push(name);
    if (name === 'notebook_create') return { status: 'expired', error: 'Auth tokens are no longer valid' };
    if (name === 'refresh_auth') return { status: 'expired', error: 'Auth tokens were reloaded but are no longer valid', reason: 'expired', details: 'Login required' };
    throw new Error(`Unexpected NotebookLM tool: ${name}`);
  } });
  await assert.rejects(() => expired.summarize('# Материал', 'Сводка'), (error: any) => error.code === 'notebook_auth');
  assert.ok(!expiredCalls.includes('notebook_delete'), 'если блокнот не создан, удалять нечего');

  const quotaCalls: string[] = [];
  const quota = createGateway!({ async callTool(name, args) {
    quotaCalls.push(name);
    if (name === 'notebook_create') return { status: 'success', notebook_id: 'nb-quota' };
    if (name === 'source_add') return { status: 'success', ready: true, source_id: 'src-quota' };
    if (name === 'notebook_query') return { status: 'error', error: 'Quota exhausted' };
    if (name === 'usage_get') return { status: 'success', windows: [{ window: '5h', percent_used: 100, percent_remaining: 0, resets_at: '2026-09-26T09:00:00Z' }], tier: 'free' };
    if (name === 'notebook_delete') { assert.deepEqual(args, { notebook_id: 'nb-quota', confirm: true }); return { status: 'success', message: 'Deleted' }; }
    throw new Error(`Unexpected NotebookLM tool: ${name}`);
  } });
  await assert.rejects(() => quota.summarize('# Материал', 'Сводка'), (error: any) => error.code === 'notebook_quota' && error.reset_at === '2026-09-26T09:00:00Z');
  assert.equal(quotaCalls.at(-1), 'notebook_delete');
});

test('Б-11: ошибка удаления временного блокнота не выдаётся за готовую сводку', async () => {
  assert.equal(typeof createGateway, 'function', 'нужен публичный адаптер NotebookGateway');
  const calls: string[] = [];
  const gateway = createGateway!({ async callTool(name) {
    calls.push(name);
    if (name === 'notebook_create') return { status: 'success', notebook_id: 'nb-test' };
    if (name === 'source_add') return { status: 'success', ready: true, source_id: 'src-test' };
    if (name === 'notebook_query') return { status: 'success', answer: 'Готовый ответ' };
    if (name === 'notebook_delete') return { status: 'error', error: 'Delete failed' };
    throw new Error(`Unexpected NotebookLM tool: ${name}`);
  } });
  await assert.rejects(() => gateway.summarize('# Материал', 'Сводка'));
  assert.equal(calls.at(-1), 'notebook_delete');
});

test('Б-11: digest за 8 дней возвращает summary через NotebookGateway без записи и отметки о прочтении', async () => {
  const f = fixture();
  try {
    const result = await f.call(tokens.mine, 'digest', request());
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { kind: 'summary', text: 'Готовая сводка NotebookLM' });
    assert.equal(f.gatewayCalls.length, 1);
    assert.match(f.gatewayCalls[0].markdown, /Обсуждали проект/);
    assert.match(f.gatewayCalls[0].prompt, /сводк/i);
    assert.ok(!f.telegramCalls.some((item) => item.name === 'mark_as_read'));
    assert.deepEqual(f.archive.getState().records, []);
    const threeMonths = await f.call(tokens.mine, 'digest', { ...request(), from: '2026-06-25T00:00:00Z', to: '2026-09-25T23:59:59.999Z' });
    assert.equal(threeMonths.data.kind, 'summary');
    const beyondThreeMonths = await f.call(tokens.mine, 'digest', { ...request(), from: '2026-06-25T00:00:00Z', to: '2026-09-26T23:59:59.999Z' });
    assert.equal(beyondThreeMonths.error.code, 'range_too_long');
    const sevenDays = await f.call(tokens.mine, 'digest', { ...request(), to: '2026-09-07T23:59:59.999Z' });
    assert.equal(sevenDays.data.kind, 'raw');
    const eightDays = await f.call(tokens.mine, 'digest', { ...request(), to: '2026-09-08T23:59:59.999Z' });
    assert.equal(eightDays.data.kind, 'summary');
  } finally { f.close(); }
});

test('Б-11: личный источник в длинном диапазоне отклоняется до чтения групп и NotebookLM', async () => {
  const f = fixture();
  try {
    const before = f.archive.getState();
    const result = await f.call(tokens.mine, 'digest', request(['https://t.me/group', 'https://t.me/private']));
    assert.equal(result.error.code, 'forbidden_area');
    assert.deepEqual(f.telegramCalls, []);
    assert.deepEqual(f.gatewayCalls, []);
    assert.deepEqual(f.archive.getState(), before);
  } finally { f.close(); }
});

test('Б-11: Собеседник отправляет готовую длинную сводку без вызова модели прокси', async () => {
  const f = fixture();
  try {
    const result = await runCommand(f, '/digest https://t.me/group 2026-09-01..2026-09-09');
    assert.deepEqual(result.sent, ['Готовая сводка NotebookLM']);
    assert.deepEqual(result.modelRequests, []);
  } finally { f.close(); }
});

test('Б-13: ошибка входа создаёт оповещение не чаще одного раза в сутки и не вызывает модель прокси', async () => {
  const f = fixture();
  f.setGatewayError(Object.assign(new Error('cookies expired'), { code: 'notebook_auth' }));
  try {
    const first = await f.call(tokens.mine, 'digest', request());
    assert.equal(first.error.code, 'notebook_auth');
    const alert = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(alert.success, true);
    assert.equal(alert.data.length, 1);
    assert.match(JSON.stringify(alert.data), /Куки NotebookLM протухли, обновите/);
    assert.equal((await f.call(tokens.receiver, 'alerts_ack', { chat_id: alert.data[0].chat_id, delivery_id: alert.data[0].delivery_id })).success, true);
    const sameDay = await f.call(tokens.mine, 'digest', request());
    assert.equal(sameDay.error.code, 'notebook_auth');
    assert.deepEqual((await f.call(tokens.receiver, 'alerts_take')).data, []);
    f.clock.time = new Date('2026-09-26T12:00:00Z');
    assert.equal((await f.call(tokens.mine, 'digest', request())).error.code, 'notebook_auth');
    assert.equal((await f.call(tokens.receiver, 'alerts_take')).data.length, 1);
    const bot = await runCommand(f, '/digest https://t.me/group 2026-09-01..2026-09-09');
    assert.deepEqual(bot.modelRequests, []);
    assert.match(bot.sent[0] ?? '', /вход|куки|обнов/i);
  } finally { f.close(); }
});

test('Б-13: лимит NotebookLM сообщает время сброса и не переключает сводку на модель прокси', async () => {
  const f = fixture();
  f.setGatewayError(Object.assign(new Error('quota exhausted'), { code: 'notebook_quota', reset_at: '2026-09-26T09:00:00Z' }));
  try {
    const response = await f.call(tokens.mine, 'digest', request());
    assert.equal(response.error.code, 'notebook_quota');
    assert.equal(response.error.reset_at, '2026-09-26T09:00:00Z');
    assert.deepEqual((await f.call(tokens.receiver, 'alerts_take')).data, []);
    const bot = await runCommand(f, '/digest https://t.me/group 2026-09-01..2026-09-09');
    assert.deepEqual(bot.modelRequests, []);
    assert.match(bot.sent[0] ?? '', /2026-09-26|09:00/);
  } finally { f.close(); }
});
