import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const ownerId = '12345';
const receiverToken = 'receiver-record-delete-token';
const talkerToken = 'talker-record-delete-token';
const systemToken = 'system-record-delete-token';
const now = () => new Date('2026-09-25T12:00:00.000Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: sha256(receiverToken) },
  { name: 'talker', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: sha256(talkerToken) },
];

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-delete-')), ownerId, now });
  const access = createAccess({ principals, legacyToken: systemToken, ownerId, archive });
  const indexed = new Map<string, string>();
  const removed: string[] = [];
  const openViking = {
    async importText({ uri, text }: { uri: string; text: string }) { indexed.set(uri, text); },
    async delete({ uri }: { uri: string }) { removed.push(uri); indexed.delete(uri); },
    async search({ target_uri, query }: { target_uri: string; query: string }) {
      return [...indexed].filter(([uri, text]) => uri.startsWith(target_uri) && text.includes(query)).map(([target_uri]) => ({ target_uri }));
    },
  };
  const integrations = new Stage3Service({
    archive, openViking, ownerId, tokenSecret: 'delete-read-secret', now,
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => { throw new Error('web access is outside this test'); },
  } as any);
  const coordinator = new Coordinator({
    archive, ownerId, now, access, integrations,
    telegram: { resolveSource: () => { throw new Error('Telegram access is outside this test'); } },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string | undefined, name: string, args: Record<string, unknown>) => handler({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: { name, arguments: args },
  }) as Promise<any>;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: receiverToken,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      calls.push({ name: request.params.name, args: request.params.arguments });
      const response = await handler({ ...request, headers: { authorization: `Bearer ${receiverToken}` } });
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'unused' },
    receiver: { name: 'receiver', token: 'fake-receiver-token', coordToken: receiverToken }, talkers: [],
  };
  const uri = (path: string) => `viking://resources/${relative(archive.rootDir, path).split(sep).join('/')}`;
  return { archive, coordinator, call, client, config, calls, removed, indexed, uri, project: () => integrations.callTool('projection_run') as Promise<any>, close() { coordinator.close(); archive.close(); } };
}

function message(updateId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
  return { update_id: updateId, message: { message_id: messageId, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text, ...extra } };
}

async function runFlow(f: ReturnType<typeof fixture>, action: 'button' | 'undo') {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  let confirmation: Record<string, unknown> | undefined;
  let polls = 0;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runBots({
        config: f.config, signal: controller.signal,
        botApiFactory: () => ({
          async getUpdates() {
            if (++polls === 1) return [message(100, 17, 'Ошибочная заметка')];
            if (polls === 2) {
              assert.ok(confirmation, 'first message must have a confirmation');
              const shortId = (confirmation.reply_markup as any)?.inline_keyboard?.[0]?.[0]?.callback_data;
              assert.match(shortId, /^[a-f0-9]{32}$/);
              if (action === 'button') return [{ update_id: 101, callback_query: { id: 'delete-click', from: { id: 12345 }, message: confirmation, data: shortId } }];
              return [message(101, 18, '/undo', { reply_to_message: confirmation })];
            }
            controller.abort();
            return [];
          },
          async sendMessage(...args: unknown[]) {
            sent.push(args);
            const reply = { message_id: 500 + sent.length, chat: { id: 12345, type: 'private' }, text: args[1], reply_markup: (args[2] as any)?.reply_markup };
            if (!confirmation) confirmation = reply;
            return reply;
          },
          async answerCallbackQuery(...args: unknown[]) { sent.push(args); return true; },
          async editMessageText(...args: unknown[]) { sent.push(args); return true; },
        }),
        coordinatorClientFactory: (_name, token) => { assert.equal(token, receiverToken); return f.client; },
        log: () => {}, sleep: async () => { controller.abort(); },
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('receiver process did not finish')), 2000); }),
    ]);
    return sent;
  } finally { clearTimeout(timeout); controller.abort(); }
}

async function runBatch(f: ReturnType<typeof fixture>, updates: unknown[]) {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  const answers: unknown[][] = [];
  const offsets: number[] = [];
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates({ offset }) {
          offsets.push(offset);
          if (offsets.length === 1) return updates as any;
          controller.abort();
          return [];
        },
        async sendMessage(...args: unknown[]) { sent.push(args); },
        async answerCallbackQuery(...args: unknown[]) { answers.push(args); },
      }),
      coordinatorClientFactory: () => f.client,
      log: () => {},
    });
    return { sent, answers, offsets };
  } finally { controller.abort(); }
}

test('Б-09: record_delete marks only a personal record and removes it from search after projection', async () => {
  const f = fixture();
  try {
    const saved = f.archive.savePersonalTelegram({ text: 'Секретная заметка', operationId: 'note-with-file', receivedAt: now(), attachments: [{ type: 'document', name: 'proof.txt', data: Buffer.from('evidence') }] });
    const before = f.archive.read(saved.archiveId);
    const attachment = (before.metadata.attachments as Array<{ path: string }>)[0];
    assert.ok(attachment?.path);
    assert.equal((await f.project()).success, true);
    const found = await f.call(systemToken, 'knowledge_search', { query: 'Секретная', scope: 'personal', limit: 10 });
    assert.equal(found.result.structuredContent.data.results.length, 1);

    const deleted = await f.call(receiverToken, 'record_delete', { archive_id: saved.archiveId });
    assert.equal(deleted.result.structuredContent.success, true);
    const after = f.archive.read(saved.archiveId);
    assert.equal(after.metadata.status, 'deleted');
    assert.equal(after.metadata.revision, 2);
    assert.deepEqual(after.metadata.attachments, before.metadata.attachments);
    assert.ok(existsSync(join(f.archive.rootDir, attachment.path)), 'attachment bytes remain in the archive');
    const history = readdirSync(join(dirname(saved.path), '.history'));
    assert.ok(history.some((name) => name.startsWith(`${basename(saved.path, '.md')}.r1-`)));
    assert.match(readFileSync(join(dirname(saved.path), '.history', history[0]), 'utf8'), /Секретная заметка/);

    const projection = await f.project();
    assert.equal(projection.success, true);
    assert.ok(f.removed.includes(f.uri(saved.path)));
    const missing = await f.call(systemToken, 'knowledge_search', { query: 'Секретная', scope: 'personal', limit: 10 });
    assert.deepEqual(missing.result.structuredContent.data.results, []);
  } finally { f.close(); }
});

test('Б-09: repeated record_delete is idempotent and adds no revision or projection work', async () => {
  const f = fixture();
  try {
    const saved = f.archive.savePersonalTelegram({ text: 'Повторное удаление', operationId: 'repeat-delete', receivedAt: now() });
    const first = await f.call(receiverToken, 'record_delete', { archive_id: saved.archiveId });
    assert.equal(first.result.structuredContent.success, true);
    const firstRevision = f.archive.read(saved.archiveId).metadata.revision;
    const outboxLength = f.archive.getState().outbox.length;
    const second = await f.call(receiverToken, 'record_delete', { archive_id: saved.archiveId });
    assert.equal(second.result.structuredContent.success, true);
    assert.equal(f.archive.read(saved.archiveId).metadata.revision, firstRevision);
    assert.equal(f.archive.getState().outbox.length, outboxLength);
  } finally { f.close(); }
});

test('Б-09: личные веб-страницы и пересылки удаляются без изменения других записей', async () => {
  const f = fixture();
  try {
    const web = f.archive.saveWeb({ requestedUrl: 'https://example.test/article', text: 'Страница', operationId: 'web-delete' });
    const forward = f.archive.savePersonalTelegram({ text: 'Пересланный текст', operationId: 'forward-delete', forward: { from_user_id: '777' } });
    const untouched = f.archive.savePersonalTelegram({ text: 'Оставить', operationId: 'untouched' });
    for (const record of [web, forward]) {
      const deleted = await f.call(receiverToken, 'record_delete', { archive_id: record.archiveId });
      assert.equal(deleted.result.structuredContent.success, true);
      assert.equal(f.archive.read(record.archiveId).metadata.status, 'deleted');
      assert.equal(f.archive.read(record.archiveId).metadata.revision, 2);
    }
    assert.equal(f.archive.read(untouched.archiveId).metadata.status, 'active');
    assert.equal(f.archive.read(untouched.archiveId).metadata.revision, 1);
  } finally { f.close(); }
});

test('Б-09: talker, unknown principal and channel record cannot delete or change archive state', async () => {
  const f = fixture();
  try {
    const personal = f.archive.savePersonalTelegram({ text: 'Оставить', operationId: 'leave-note', receivedAt: now() });
    const channel = f.archive.saveTelegram({ kind: 'channel', chatId: '-10011', messageId: '1', text: 'Канальная запись' });
    const group = f.archive.saveTelegram({ kind: 'group', chatId: '-10012', messageId: '2', text: 'Групповая запись' });
    const before = f.archive.getState().records;
    const denied = await f.call(talkerToken, 'record_delete', { archive_id: personal.archiveId });
    assert.equal(denied.result.structuredContent.error.code, 'forbidden');
    const unauthenticated = await f.call(undefined, 'record_delete', { archive_id: personal.archiveId });
    assert.equal(unauthenticated.error?.message, 'Unauthorized');
    const wrongArea = await f.call(receiverToken, 'record_delete', { archive_id: channel.archiveId });
    assert.equal(wrongArea.result.structuredContent.error.code, 'forbidden');
    const wrongGroup = await f.call(receiverToken, 'record_delete', { archive_id: group.archiveId });
    assert.equal(wrongGroup.result.structuredContent.error.code, 'forbidden');
    const system = await f.call(systemToken, 'record_delete', { archive_id: personal.archiveId });
    assert.equal(system.result.structuredContent.error.code, 'forbidden');
    assert.deepEqual(f.archive.getState().records, before);
    assert.notEqual(f.archive.read(personal.archiveId).metadata.status, 'deleted');
    assert.notEqual(f.archive.read(channel.archiveId).metadata.status, 'deleted');
    assert.notEqual(f.archive.read(group.archiveId).metadata.status, 'deleted');
  } finally { f.close(); }
});

for (const action of ['button', 'undo'] as const) {
  test(`Б-09: ${action} deletes the confirmed record through bots and tells the owner`, async () => {
    const f = fixture();
    try {
      const sent = await runFlow(f, action);
      const row = (f.archive.getState().records as Array<{ archive_id: string }>)[0];
      assert.ok(row);
      assert.equal(f.archive.read(row.archive_id).metadata.status, 'deleted');
      assert.ok(f.calls.some((call) => call.name === 'record_delete'));
      assert.match(JSON.stringify(sent.slice(1)), /удал[её]н/i);
      if (action === 'button') assert.equal(sent.filter((item) => item[0] === 'delete-click').length, 1, 'successful callback must be acknowledged');
      assert.equal(f.archive.getState().records.length, 1, '/undo must not become a new note');
    } finally { f.close(); }
  });
}

test('Б-09: /undo без кнопки даёт подсказку, а изменённый текст подтверждения не мешает удалению', async () => {
  const f = fixture();
  try {
    const saved = await f.call(receiverToken, 'inbox_save', { chat_id: ownerId, message_id: '71', date: now().toISOString(), text: 'Удалить по ответу' });
    const shortId = saved.result.structuredContent.data.records[0].short_id;
    const reply = { text: 'Текст подтверждения изменён', reply_markup: { inline_keyboard: [[{ text: '🗑 Удалить', callback_data: shortId }]] } };
    const result = await runBatch(f, [message(71, 72, '/undo', { reply_to_message: { text: 'Сохранено' } }), message(72, 73, '/undo', { reply_to_message: reply }), message(73, 74, '/undo не сейчас')]);
    assert.match(JSON.stringify(result.sent[0]), /Ответьте \/undo/);
    assert.match(JSON.stringify(result.sent[1]), /Запись удалена/);
    assert.match(JSON.stringify(result.sent[2]), /Ответьте \/undo/);
    assert.equal(f.calls.filter((call) => call.name === 'inbox_save').length, 0);
    assert.equal(f.archive.getState().records.length, 1);
    assert.equal(f.archive.read(saved.result.structuredContent.data.records[0].archive_id).metadata.status, 'deleted');
  } finally { f.close(); }
});

test('Б-09: неизвестная кнопка подтверждает отказ и не блокирует следующее обновление', async () => {
  const f = fixture();
  try {
    const result = await runBatch(f, [
      { update_id: 80, callback_query: { id: 'unknown-delete', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: 'f'.repeat(32) } },
      message(81, 81, 'Следующая заметка'),
    ]);
    assert.deepEqual(result.offsets, [0, 82]);
    assert.deepEqual(result.answers, [['unknown-delete', { text: 'Не удалось удалить запись', show_alert: true }]]);
    assert.ok(result.sent.some((item) => item[1] === 'Сохранено'));
    assert.equal(f.archive.getState().records.length, 1);
  } finally { f.close(); }
});

test('Б-09: повторная доставка после удаления не меняет результат сохранения и не выдаёт кнопку', async () => {
  const f = fixture();
  try {
    const saved = await f.call(receiverToken, 'inbox_save', { chat_id: ownerId, message_id: '91', date: now().toISOString(), text: 'Уже удалённая заметка' });
    const record = saved.result.structuredContent.data.records[0];
    const operationId = `receiver:${ownerId}:91`;
    const original = f.archive.getState().operations.find((item) => item.operation_id === operationId)?.result_json;
    assert.equal((await f.call(receiverToken, 'record_delete', { short_id: record.short_id })).result.structuredContent.success, true);
    const result = await runBatch(f, [message(91, 91, 'Уже удалённая заметка')]);
    assert.equal(result.sent[0]?.[1], 'Запись уже удалена');
    assert.deepEqual(result.sent[0]?.[2], {});
    assert.equal(f.archive.getState().operations.find((item) => item.operation_id === operationId)?.result_json, original);
    assert.equal(f.archive.getState().records.length, 1);
    assert.equal(f.archive.read(record.archive_id).metadata.status, 'deleted');
  } finally { f.close(); }
});
