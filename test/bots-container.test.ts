import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

async function botsModule(): Promise<any> {
  const url = new URL('src/bots/index.ts', root);
  assert.ok(existsSync(url), 'public src/bots/index.ts module is required');
  return import(url.href);
}

function secretConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-memory-bots-config-'));
  const secret = (name: string, value: string) => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  return {
    owner_user_id_file: secret('owner_user_id', '12345\n'),
    coordinator_url: 'http://coordinator:8787/mcp',
    model: { base_url: 'https://proxy.invalid/v1', api_key_file: secret('model_api_key', 'proxy-key') },
    receiver: { bot_token_file: secret('receiver_bot_token', 'receiver-bot-token'), coord_token_file: secret('receiver_coord_token', 'receiver-coord-token') },
    talkers: [{ name: 'shared', bot_token_file: secret('talker_shared_bot_token', 'shared-bot-token'), coord_token_file: secret('talker_shared_coord_token', 'shared-coord-token'), model: 'test-model', owner_only: false, digest: false }],
  };
}

test('bots config rejects missing settings and empty secret files before polling', async () => {
  const { loadBotsConfig } = await botsModule();
  assert.equal(typeof loadBotsConfig, 'function');
  const config = secretConfig();
  const valid = loadBotsConfig(JSON.stringify(config));
  assert.ok(valid);
  assert.equal(valid.receiver.token, 'receiver-bot-token');
  assert.equal(valid.receiver.coordToken, 'receiver-coord-token');
  assert.equal(valid.talkers[0].token, 'shared-bot-token');
  assert.equal(valid.talkers[0].coordToken, 'shared-coord-token');
  for (const broken of [
    { ...config, model: { ...config.model, base_url: '' } },
    { ...config, talkers: [{ ...config.talkers[0], model: '' }] },
    { ...config, receiver: { ...config.receiver, bot_token_file: join(tmpdir(), 'missing-bot-secret') } },
  ]) {
    assert.throws(() => loadBotsConfig(JSON.stringify(broken)), /model|secret|token|config|missing/i);
  }
  writeFileSync(config.receiver.coord_token_file, ' \n');
  assert.throws(() => loadBotsConfig(JSON.stringify(config)), /secret|token|empty/i);
});

test('bots config is loaded from a file; a missing or empty file fails with its path', async () => {
  const { loadBotsConfigFile } = await botsModule();
  const dir = mkdtempSync(join(tmpdir(), 'telegram-memory-bots-file-'));
  const file = join(dir, 'bots.json');
  writeFileSync(file, JSON.stringify(secretConfig()));
  assert.equal(loadBotsConfigFile(file).receiver.token, 'receiver-bot-token');
  assert.throws(() => loadBotsConfigFile(join(dir, 'missing.json')), /BOTS_CONFIG_FILE.*missing\.json/);
  writeFileSync(file, ' \n');
  assert.throws(() => loadBotsConfigFile(file), /BOTS_CONFIG_FILE.*empty/);
});

test('bots process reads its config file, not JSON from the environment', () => {
  const main = read('src/bots/main.ts');
  assert.match(main, /BOTS_CONFIG_FILE/);
  assert.doesNotMatch(main, /env\.BOTS_CONFIG\b(?!_FILE)/);
});

test('Bot API adapter long polls through fetch with an abortable timeout', async () => {
  const { createBotApi } = await botsModule();
  assert.equal(typeof createBotApi, 'function');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = createBotApi({
    token: 'fake-bot-token',
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 7, message: { text: 'private payload' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const updates = await api.getUpdates({ offset: 7, timeoutSeconds: 1 });
  assert.equal(updates[0].update_id, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botfake-bot-token\/getUpdates/);
  assert.match(`${calls[0].url} ${String(calls[0].init.body ?? '')}`, /offset[^0-9]*7/);
  assert.match(`${calls[0].url} ${String(calls[0].init.body ?? '')}`, /timeout[^0-9]*1/);
  assert.ok(calls[0].init.signal, 'polling request must be abortable');
});

test('Bot API adapter aborts a stalled poll after its timeout', async () => {
  const { createBotApi } = await botsModule();
  const api = createBotApi({
    token: 'fake-bot-token',
    fetch: async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('poll aborted')), { once: true });
    }),
  });
  const started = performance.now();
  await assert.rejects(Promise.race([
    api.getUpdates({ offset: 1, timeoutSeconds: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('poll hung')), 13000)),
  ]), /abort|timeout|timed out/i);
  assert.ok(performance.now() - started >= 10_000, 'network timeout needs at least ten seconds beyond long polling');
});

test('Bot API 429 waits for retry_after and caps an excessive wait', async () => {
  const { createBotApi, loadBotsConfig, runBots } = await botsModule();
  const raw = secretConfig();
  raw.talkers = [];
  const config = loadBotsConfig(JSON.stringify(raw));
  for (const [retryAfter, expected] of [[7, 7000], [99999, 300000]]) {
    const controller = new AbortController();
    const delays: number[] = [];
    let calls = 0;
    await runBots({
      config, signal: controller.signal,
      botApiFactory: () => createBotApi({ token: 'fake-bot-token', fetch: async () => {
        if (++calls === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }), { status: 429 });
        controller.abort();
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      } }),
      log: () => {},
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    });
    assert.equal(calls, 2);
    assert.equal(delays[0], expected);
  }
});

test('coordinator adapter sends MCP calls with its principal Bearer token', async () => {
  const { createCoordinatorClient } = await botsModule();
  assert.equal(typeof createCoordinatorClient, 'function');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator:8787/mcp', token: 'principal-secret',
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { success: true, data: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.callTool('collect_status', {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://coordinator:8787/mcp');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer principal-secret');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'collect_status');
});

test('bots process logs an update without its content and makes no coordinator call', async () => {
  const { loadBotsConfig, runBots } = await botsModule();
  assert.equal(typeof runBots, 'function');
  const controller = new AbortController();
  const logs: string[] = [];
  const coordinatorCalls: string[] = [];
  const polled: string[] = [];
  const config = loadBotsConfig(JSON.stringify(secretConfig()));
  const process = runBots({
    config, signal: controller.signal,
    botApiFactory: (name: string) => ({
      async getUpdates() {
        polled.push(name);
        if (name === 'receiver' && polled.filter((item) => item === name).length === 1) return [{ update_id: 1, message: { text: 'PRIVATE-CONTENT', chat: { id: 12345 } } }];
        return [];
      },
    }),
    coordinatorClientFactory: () => ({ async callTool(name: string) { coordinatorCalls.push(name); return {}; } }),
    log: (line: string) => { logs.push(line); if (polled.includes('receiver') && polled.includes('shared')) controller.abort(); },
    sleep: async () => { if (polled.includes('receiver') && polled.includes('shared')) controller.abort(); },
  });
  await Promise.race([process, new Promise((_, reject) => setTimeout(() => reject(new Error('bots process did not stop')), 2000))]);
  assert.ok(polled.includes('receiver') && polled.includes('shared'));
  assert.ok(logs.some((line) => /update|сообщени/i.test(line)));
  assert.ok(logs.every((line) => !line.includes('PRIVATE-CONTENT')));
  assert.deepEqual(coordinatorCalls, []);
});

test('bots process waits before retrying a failed Bot API poll', async () => {
  const { loadBotsConfig, runBots } = await botsModule();
  const raw = secretConfig();
  raw.talkers = [];
  const config = loadBotsConfig(JSON.stringify(raw));
  const controller = new AbortController();
  const delays: number[] = [];
  let polls = 0;
  await Promise.race([
    runBots({
      config, signal: controller.signal,
      botApiFactory: () => ({ async getUpdates() {
        polls += 1;
        if (polls === 1) throw new Error('temporary Bot API outage');
        controller.abort();
        return [];
      } }),
      coordinatorClientFactory: () => ({ async callTool() { throw new Error('unexpected coordinator call'); } }),
      log: () => {},
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('poll retry did not stop')), 2000)),
  ]);
  assert.equal(polls, 2);
  assert.ok(delays.some((milliseconds) => milliseconds > 0), 'errors must pause before retry');
});

test('bots process advances the polling offset past every received update', async () => {
  const { loadBotsConfig, runBots } = await botsModule();
  const raw = secretConfig();
  raw.talkers = [];
  const config = loadBotsConfig(JSON.stringify(raw));
  const controller = new AbortController();
  const offsets: number[] = [];
  await Promise.race([
    runBots({
      config, signal: controller.signal,
      botApiFactory: () => ({ async getUpdates({ offset }: { offset: number }) {
        offsets.push(offset);
        if (offsets.length === 1) return [
          { update_id: 7, message: { text: 'first' } },
          { update_id: 9, message: { text: 'second' } },
        ];
        controller.abort();
        return [];
      } }),
      log: () => {},
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('polling offset did not advance')), 2000)),
  ]);
  assert.deepEqual(offsets, [0, 10]);
});
