import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { handleOwnerTalkerUpdate } from '../src/bots/talker.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const ownerId = '12345';
const coordinatorToken = 'mine-coordinator-token';
const now = () => new Date('2026-09-25T12:00:00.000Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-mine-')), ownerId, now });
  const note = archive.savePersonalTelegram({ text: 'Чай хранится в синей коробке.', operationId: 'mine-note', receivedAt: now() });
  const row = (archive.getState().records as Array<{ path: string }>)[0];
  const uri = `viking://resources/${relative(archive.rootDir, row.path).split(sep).join('/')}`;
  const access = createAccess({
    ownerId, archive, legacyToken: 'system-test-token',
    principals: [{ name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: sha256(coordinatorToken) }],
  });
  let searchFails = false;
  const integrations = new Stage3Service({
    archive, ownerId, tokenSecret: 'mine-read-secret', now,
    openViking: {
      async search({ target_uri, query }: { target_uri: string; query: string }) {
        if (searchFails) throw new Error('index unavailable');
        return query.includes('чай') && uri.startsWith(target_uri) ? [{ target_uri: uri }] : [];
      },
    },
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => { throw new Error('web access is outside this test'); },
  } as any);
  const coordinator = new Coordinator({
    archive, ownerId, now, access, integrations,
    telegram: { resolveSource: () => { throw new Error('Telegram access is outside this test'); } },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: coordinatorToken,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${coordinatorToken}`);
      calls.push({ name: request.params.name, args: request.params.arguments });
      const response = await handler({ ...request, headers: { authorization: `Bearer ${coordinatorToken}` } });
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp',
    model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'fake-model-key' },
    receiver: { name: 'receiver', token: 'unused-receiver-token', coordToken: 'unused-receiver-coordinator-token' },
    talkers: [{ name: 'mine', token: 'fake-mine-token', coordToken: coordinatorToken, model: 'mine-model', ownerOnly: true, digest: true }],
  };
  return { archive, note, uri, config, client, calls, failSearch() { searchFails = true; }, close() { coordinator.close(); archive.close(); } };
}

function message(updateId: number, fromId: number, chatId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, date: Math.floor(now().getTime() / 1000), from: { id: fromId }, chat: { id: chatId, type: 'private' }, text } };
}

type ModelReply = (request: any, number: number) => object;
const assistant = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const toolCall = (name: string, args: object) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

async function runQuestion(f: ReturnType<typeof fixture>, updates: ReturnType<typeof message>[], reply: ModelReply) {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  const modelRequests: any[] = [];
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(url, 'https://proxy.invalid/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-model-key');
    const request = JSON.parse(String(init?.body));
    modelRequests.push(request);
    return new Response(JSON.stringify(reply(request, modelRequests.length)), { status: 200 });
  };
  let minePolls = 0;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runBots({
        config: f.config, signal: controller.signal,
        botApiFactory: (name) => ({
          async getUpdates() {
            if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
            if (++minePolls === 1) return updates;
            controller.abort();
            return [];
          },
          async sendMessage(...args: unknown[]) { sent.push(args); return { message_id: sent.length }; },
        }),
        coordinatorClientFactory: (name, token) => {
          if (name === 'receiver') return { async callTool() { throw new Error('receiver must not call coordinator in this test'); } };
          assert.equal(name, 'mine');
          assert.equal(token, coordinatorToken);
          return f.client;
        },
        log: (line) => { logs.push(line); },
        sleep: async () => { controller.abort(); },
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('bots process did not finish')), 2000); }),
    ]);
    return { sent, modelRequests, logs };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    globalThis.fetch = originalFetch;
  }
}

test('Б-10: тестовая личная запись доступна Собеседнику через настоящий обработчик координатора', async () => {
  const f = fixture();
  try {
    const search = await f.client.callTool('knowledge_search', { query: 'чай', chat_id: ownerId, limit: 10 }) as any;
    assert.equal(search.success, true);
    assert.equal(search.data.results.length, 1);
    assert.equal(search.data.results[0].target_uri, f.uri);
    const read = await f.client.callTool('knowledge_read', { read_token: search.data.results[0].read_token, chat_id: ownerId }) as any;
    assert.equal(read.success, true);
    assert.match(JSON.stringify(read.data), /синей коробке/);
  } finally { f.close(); }
});

test('Б-10: мой ищет и читает личную запись через координатор, затем отвечает со ссылкой', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [message(1, 12345, 12345, 'Где лежит чай?')], (request, step) => {
      assert.equal(request.model, 'mine-model');
      assert.deepEqual(request.tools.map((tool: any) => tool.function.name).sort(), ['knowledge_read', 'knowledge_search']);
      assert.ok(!JSON.stringify(request.tools).includes('chat_id'), 'chat_id must not be available to the model');
      if (step === 1) return toolCall('knowledge_search', { query: 'чай', chat_id: '-100999' });
      if (step === 2) {
        const transcript = JSON.stringify(request.messages);
        const token = /read_token[^A-Za-z0-9_-]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(transcript)?.[1];
        assert.ok(token, 'search result must be visible to the model');
        return toolCall('knowledge_read', { read_token: token, chat_id: '-100999' });
      }
      assert.match(JSON.stringify(request.messages), /синей коробке/);
      return assistant(`Чай лежит в синей коробке. Источник: ${f.uri}`);
    });
    assert.deepEqual(f.calls.map((call) => call.name), ['knowledge_search', 'knowledge_read']);
    assert.equal(f.calls[0].args.chat_id, ownerId);
    assert.equal(f.calls[1].args.chat_id, ownerId);
    assert.match(JSON.stringify(result.sent), /синей коробке/);
    assert.ok(JSON.stringify(result.sent).includes(f.uri));
  } finally { f.close(); }
});

test('Б-10: пустой поиск даёт прямое «не нашёл» без придуманного ответа', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [message(2, 12345, 12345, 'Где лежит ключ?')], (_request, step) => step === 1 ? toolCall('knowledge_search', { query: 'ключ' }) : assistant('Ключ в красном шкафу.'));
    assert.equal(f.calls[0]?.name, 'knowledge_search');
    assert.equal(result.sent.length, 1);
    assert.match(JSON.stringify(result.sent), /не наш[её]л|не найден/i);
    assert.doesNotMatch(JSON.stringify(result.sent), /красном шкафу/i);
  } finally { f.close(); }
});

test('Б-10: после пустого поиска модель может уточнить запрос и прочитать найденное', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [message(8, 12345, 12345, 'Где лежит чай?')], (request, step) => {
      if (step === 1) return toolCall('knowledge_search', { query: 'нет такого' });
      if (step === 2) {
        assert.deepEqual(JSON.parse(request.messages.at(-1).content).results, []);
        return toolCall('knowledge_search', { query: 'чай' });
      }
      if (step === 3) {
        const token = JSON.parse(request.messages.at(-1).content).results[0].read_token;
        return toolCall('knowledge_read', { read_token: token });
      }
      assert.match(JSON.stringify(request.messages), /синей коробке/);
      return assistant('Чай лежит в синей коробке.');
    });
    assert.equal(result.modelRequests.length, 4);
    assert.deepEqual(f.calls.map((call) => call.name), ['knowledge_search', 'knowledge_search', 'knowledge_read']);
    assert.match(JSON.stringify(result.sent), /синей коробке/);
    assert.match(JSON.stringify(result.sent), /viking:/);
  } finally { f.close(); }
});

test('Б-10: ответ содержит все прочитанные источники', async () => {
  const sent: string[] = [];
  let step = 0;
  await handleOwnerTalkerUpdate(message(9, 12345, 12345, 'Что известно?'), ownerId, 'mine-model', {
    async complete() {
      step += 1;
      if (step === 1) return { choices: [{ message: { tool_calls: [{ id: 'search', function: { name: 'knowledge_search', arguments: '{"query":"тема"}' } }] } }] };
      if (step === 2) return { choices: [{ message: { tool_calls: [
        { id: 'read_1', function: { name: 'knowledge_read', arguments: '{"read_token":"one"}' } },
        { id: 'read_2', function: { name: 'knowledge_read', arguments: '{"read_token":"two"}' } },
      ] } }] };
      return assistant('По материалам найден ответ. Источник: viking://one');
    },
  }, {
    async callTool(name) {
      if (name === 'knowledge_search') return { success: true, data: { results: [
        { read_token: 'one', target_uri: 'viking://one' },
        { read_token: 'two', target_uri: 'viking://two' },
      ] } };
      return { success: true, data: { markdown: 'Подтверждение' } };
    },
  }, { async sendMessage(_chatId, text) { sent.push(text); } });
  assert.equal(step, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /viking:\/\/one/);
  assert.match(sent[0], /viking:\/\/two/);
});

test('Б-10: сбой отправки не повторяет вопрос модели при следующем опросе', async () => {
  const f = fixture();
  const controller = new AbortController();
  const offsets: number[] = [];
  const logs: string[] = [];
  let modelCalls = 0;
  let sendCalls = 0;
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: (name) => ({
        async getUpdates({ offset }) {
          if (name === 'receiver') return new Promise<never[]>((resolve) => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
          offsets.push(offset);
          if (offset <= 10 && offsets.length < 4) return [message(10, 12345, 12345, 'Где чай?')];
          controller.abort();
          return [];
        },
        async sendMessage() { sendCalls += 1; throw new Error('secret-token-in-send-error'); },
      }),
      coordinatorClientFactory: () => f.client,
      modelClientFactory: () => ({ async complete() { modelCalls += 1; return assistant('Ответ.'); } }),
      log: (line) => { logs.push(line); },
      sleep: async () => {},
    });
    assert.deepEqual(offsets, [0, 11]);
    assert.equal(modelCalls, 1);
    assert.equal(sendCalls, 1);
    assert.match(logs.join('\n'), /Ошибка обработки обновления/);
    assert.doesNotMatch(logs.join('\n'), /secret-token|Где чай/);
  } finally { controller.abort(); f.close(); }
});

test('Б-10: больше четырёх шагов модели не выполняется', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [message(3, 12345, 12345, 'Где чай?')], () => toolCall('knowledge_search', { query: 'чай' }));
    assert.equal(result.modelRequests.length, 4);
    assert.equal(result.sent.length, 1);
    assert.match(JSON.stringify(result.sent), /не заверш|не удалось|не наш[её]л/i);
  } finally { f.close(); }
});

test('Б-10: чужой пользователь и чужой личный чат не вызывают модель и координатор', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [
      message(4, 67890, 67890, 'Где чай?'),
      message(11, 12345, 67890, 'Где чай?'),
    ], () => { throw new Error('model must not be called'); });
    assert.deepEqual(result.modelRequests, []);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(result.sent, []);
  } finally { f.close(); }
});

test('Б-10: ошибка прокси возвращает владельцу понятное сообщение без ключа в журнале', async () => {
  const f = fixture();
  try {
    const result = await runQuestion(f, [message(5, 12345, 12345, 'Где чай?')], () => { throw new Error('proxy unavailable fake-model-key'); });
    assert.equal(result.sent.length, 1);
    assert.match(JSON.stringify(result.sent), /ошиб|недоступ|попробуйте/i);
    assert.doesNotMatch(JSON.stringify(result.sent), /синей коробке/);
    assert.doesNotMatch(JSON.stringify(result.sent), /fake-model-key/);
    assert.doesNotMatch(result.logs.join('\n'), /fake-model-key|Где чай/);
  } finally { f.close(); }
});

test('Б-10: ошибка координатора не превращается в выдуманный ответ', async () => {
  const f = fixture();
  f.failSearch();
  try {
    const result = await runQuestion(f, [message(6, 12345, 12345, 'Где чай?')], (_request, step) => step === 1 ? toolCall('knowledge_search', { query: 'чай' }) : assistant('Чай лежит на крыше.'));
    assert.equal(f.calls[0]?.name, 'knowledge_search');
    assert.equal(result.sent.length, 1);
    assert.match(JSON.stringify(result.sent), /ошиб|недоступ|попробуйте/i);
    assert.doesNotMatch(JSON.stringify(result.sent), /на крыше/);
  } finally { f.close(); }
});

test('Б-10: необъявленное средство модели не исполняется', async () => {
  const f = fixture();
  try {
    const before = f.archive.getState().records.length;
    const result = await runQuestion(f, [message(7, 12345, 12345, 'Удали запись')], () => toolCall('record_delete', { archive_id: f.note.archiveId }));
    assert.deepEqual(f.calls, []);
    assert.equal(f.archive.getState().records.length, before);
    assert.equal(result.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(result.sent), /удалено|сделано/i);
  } finally { f.close(); }
});
