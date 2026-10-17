import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const now = () => new Date('2026-09-25T12:00:00.000Z');
const ownerId = '12345';
const receiverToken = 'receiver-first-path-coordinator-token';
const talkerToken = 'talker-first-path-coordinator-token';
const systemToken = 'system-first-path-coordinator-token';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: digest(receiverToken) },
  { name: 'talker', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: digest(talkerToken) },
];

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-receiver-')), ownerId, now });
  const access = createAccess({ principals, legacyToken: systemToken, ownerId, archive });
  const searched: string[] = [];
  const indexed = new Map<string, string>();
  const openViking = {
    async importText({ uri, text }: { uri: string; text: string }) { indexed.set(uri, text); },
    async search({ target_uri, query }: { target_uri: string; query: string }) {
      searched.push(target_uri);
      return [...indexed].filter(([uri, text]) => uri.startsWith(target_uri) && text.includes(query)).map(([target_uri]) => ({ target_uri }));
    },
  };
  const integrations = new Stage3Service({
    archive, openViking, ownerId, tokenSecret: 'receiver-read-secret', now,
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => { throw new Error('web access is outside this test'); },
  } as any);
  const coordinator = new Coordinator({
    archive, ownerId, now, access, integrations,
    telegram: { resolveSource: () => { throw new Error('Telegram source resolution is outside this test'); } },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string | undefined, name: string, args: Record<string, unknown>) => handler({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: { name, arguments: args },
  }) as Promise<any>;
  const mcpCalls: Array<{ name: string; authorization: string | null; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: receiverToken,
    fetch: async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const authorization = new Headers(init.headers).get('authorization');
      mcpCalls.push({ name: request.params.name, authorization, args: request.params.arguments });
      const response = await handler({ ...request, headers: { authorization } });
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'unused' },
    receiver: { name: 'receiver', token: 'fake-telegram-bot-token', coordToken: receiverToken }, talkers: [],
  };
  return {
    archive, coordinator, handler, call, client, config, mcpCalls, searched,
    project: () => integrations.callTool('projection_run'),
    close() { coordinator.close(); archive.close(); },
  };
}

function message(updateId: number, messageId: number, fromId: number, chatId: number, type: string, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId, date: Math.floor(now().getTime() / 1000),
      from: { id: fromId }, chat: { id: chatId, type }, text,
    },
  };
}

async function runUpdates(f: ReturnType<typeof fixture>, updates: ReturnType<typeof message>[]) {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  const logs: string[] = [];
  let polls = 0;
  await Promise.race([
    runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates() {
          if (++polls === 1) return updates;
          controller.abort();
          return [];
        },
        async sendMessage(...args: unknown[]) { sent.push(args); return { message_id: sent.length }; },
      }),
      coordinatorClientFactory: (_name, token) => {
        assert.equal(token, receiverToken);
        return f.client;
      },
      log: (line: string) => { logs.push(line); },
      sleep: async () => { controller.abort(); },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('receiver process did not finish')), 2000)),
  ]);
  return { sent, logs };
}

test('Б-02: inbox_save is receiver-only and one Telegram message creates one dated note', async () => {
  const f = fixture();
  try {
    const input = { chat_id: ownerId, message_id: '17', date: now().toISOString(), text: 'Запомни эту мысль', entities: [] };
    const denied = await f.call(talkerToken, 'inbox_save', input);
    assert.equal(denied.result.structuredContent.error.code, 'forbidden');
    assert.deepEqual(f.archive.getState().records, []);
    const unknown = await f.call(undefined, 'inbox_save', input);
    assert.equal(unknown.error?.message, 'Unauthorized');
    assert.deepEqual(f.archive.getState().records, []);

    const saved = await f.call(receiverToken, 'inbox_save', input);
    assert.equal(saved.result.structuredContent.success, true);
    assert.equal(saved.result.structuredContent.data.records.length, 1);
    const shortId = saved.result.structuredContent.data.records[0].short_id;
    assert.ok(typeof shortId === 'string' && Buffer.byteLength(shortId, 'utf8') <= 64);
    assert.equal(f.coordinator.resolveInboxRecord(shortId), saved.result.structuredContent.data.records[0].archive_id);
    const negative = await f.call(receiverToken, 'inbox_save', { ...input, message_id: '-17' });
    assert.equal(negative.result.structuredContent.error.code, 'invalid_argument');
    const rows = f.archive.getState().records as Array<{ archive_id: string; path: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0].path.replaceAll('\\', '/'), /personal\/12345\/notes\//);
    assert.match(basename(rows[0].path), /^2026-09-25_150000_tg(?:_\d+)?\.md$/);
    assert.match(readFileSync(rows[0].path, 'utf8'), /Запомни эту мысль/);
  } finally {
    f.close();
  }
});

test('Б-01/Б-02: owner text passes through bots and MCP, is searchable, and receives a delete button', async () => {
  const f = fixture();
  try {
    const result = await runUpdates(f, [message(100, 17, 12345, 12345, 'private', 'Тихая заметка')]);
    const saved = f.mcpCalls.find((call) => call.name === 'inbox_save');
    assert.ok(saved);
    assert.equal(saved.authorization, `Bearer ${receiverToken}`);
    assert.equal(saved.args.message_id, '17');
    const rows = f.archive.getState().records as Array<{ archive_id: string; path: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0].path.replaceAll('\\', '/'), /personal\/12345\/notes\//);
    assert.match(readFileSync(rows[0].path, 'utf8'), /Тихая заметка/);

    assert.equal(result.sent.length, 1);
    const reply = JSON.stringify(result.sent[0]);
    assert.match(reply, /Сохранено/);
    assert.match(reply, /🗑 Удалить/);
    const callback = /"callback_data":"([^"]+)"/.exec(reply)?.[1];
    assert.ok(callback, 'delete button needs callback_data');
    assert.match(callback, /^[a-f0-9]{32}$/, 'button contains only a short record ID');
    assert.ok(Buffer.byteLength(callback, 'utf8') <= 64);
    assert.ok(!callback.includes('Тихая заметка'), 'button must not contain message content');
    assert.equal(f.coordinator.resolveInboxRecord(callback), rows[0].archive_id);
    assert.equal(f.coordinator.resolveInboxRecord('unknown-id'), undefined);

    const projection = await f.project() as any;
    assert.equal(projection.success, true);
    assert.equal(projection.data.completed, 1);
    const searched = await f.call(systemToken, 'knowledge_search', { query: 'Тихая заметка', scope: 'personal', limit: 10 });
    assert.equal(searched.result.structuredContent.success, true);
    assert.equal(searched.result.structuredContent.data.results.length, 1);
    assert.ok(searched.result.structuredContent.data.results[0].target_uri.includes('/personal/12345/notes/'));
    assert.deepEqual(f.searched, ['viking://resources/personal/12345/']);
  } finally {
    f.close();
  }
});

test('Б-01: receiver ignores another user and the owner in a group without coordinator calls or replies', async () => {
  const f = fixture();
  try {
    const result = await runUpdates(f, [
      message(200, 18, 67890, 67890, 'private', 'Чужая заметка'),
      message(201, 19, 12345, -10011, 'supergroup', 'Сообщение владельца в группе'),
    ]);
    assert.deepEqual(f.mcpCalls, []);
    assert.deepEqual(result.sent, []);
    assert.deepEqual(f.archive.getState().records, []);
  } finally {
    f.close();
  }
});

test('Б-02: redelivered message is idempotent while a new message with equal text is a new note', async () => {
  const f = fixture();
  try {
    const result = await runUpdates(f, [
      message(300, 20, 12345, 12345, 'private', 'Одинаковый текст'),
      message(301, 20, 12345, 12345, 'private', 'Одинаковый текст'),
      message(302, 21, 12345, 12345, 'private', 'Одинаковый текст'),
    ]);
    const rows = f.archive.getState().records as Array<{ archive_id: string; path: string }>;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].path, rows[1].path);
    assert.equal(result.sent.length, 3, 'each delivery receives a confirmation, including the duplicate');
    const callbacks = result.sent.map((sent) => /"callback_data":"([^"]+)"/.exec(JSON.stringify(sent))?.[1]);
    assert.equal(callbacks[0], callbacks[1]);
    assert.notEqual(callbacks[0], callbacks[2]);
    assert.equal(f.coordinator.resolveInboxRecord(callbacks[0]!), rows[0].archive_id);
    assert.equal(f.coordinator.resolveInboxRecord(callbacks[2]!), rows[1].archive_id);
  } finally {
    f.close();
  }
});

test('Б-02: short button ID and retry identity survive reopening the same SQLite', async () => {
  const f = fixture();
  const rootDir = f.archive.rootDir;
  let closed = false;
  try {
    const first = await f.call(receiverToken, 'inbox_save', {
      chat_id: ownerId, message_id: '0', date: now().toISOString(), text: 'Заметка после перезапуска', entities: [],
    });
    assert.equal(first.result.structuredContent.success, true);
    const record = first.result.structuredContent.data.records[0];
    assert.match(record.short_id, /^[a-f0-9]{32}$/);
    assert.equal(f.coordinator.resolveInboxRecord(record.short_id), record.archive_id);
    f.close();
    closed = true;

    const archive = new Archive({ rootDir, ownerId, now });
    const access = createAccess({ principals, legacyToken: systemToken, ownerId, archive });
    const coordinator = new Coordinator({
      archive, ownerId, now, access,
      telegram: { resolveSource: () => { throw new Error('Telegram access is outside this test'); } },
    });
    try {
      assert.equal(coordinator.resolveInboxRecord(record.short_id), record.archive_id);
      const handler = createCoordinatorMcpHandler(coordinator, access);
      const retried = await handler({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        headers: { authorization: `Bearer ${receiverToken}` },
        params: { name: 'inbox_save', arguments: { chat_id: ownerId, message_id: '0', date: now().toISOString(), text: 'Заметка после перезапуска' } },
      }) as any;
      assert.equal(retried.result.structuredContent.success, true);
      assert.equal(retried.result.structuredContent.data.records[0].short_id, record.short_id);
      assert.equal(archive.getState().records.length, 1);
    } finally {
      coordinator.close();
      archive.close();
    }
  } finally {
    if (!closed) f.close();
  }
});
