import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { createCoordinatorClient, runBots, type BotsConfig } from '../src/bots/index.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const ownerId = '12345';
const receiverToken = 'receiver-full-inbox-token';
const now = () => new Date('2026-09-25T12:00:00.000Z');
const principals = [{ name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: createHash('sha256').update(receiverToken).digest('hex') }];

function fixture() {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-full-inbox-')), ownerId, now });
  const access = createAccess({ principals, legacyToken: 'system-full-inbox-token', ownerId, archive });
  const fetched: string[] = [];
  const resolved: string[] = [];
  let collected = 0;
  const integrations = new Stage3Service({
    archive, ownerId, tokenSecret: 'full-inbox-read-secret', now,
    openViking: { async search() { return []; } },
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async (url: string) => {
      fetched.push(url);
      return { status: 200, finalUrl: url, remoteAddress: '93.184.216.34', headers: { 'content-type': 'text/html' }, body: '<article>Содержимое страницы</article>' };
    },
    clipper: async () => ({ content: '# Содержимое страницы', title: 'Страница' }),
  } as any);
  const coordinator = new Coordinator({
    archive, ownerId, now, access, integrations,
    telegram: {
      resolveSource: (ref: string) => {
        resolved.push(ref);
        return { chatId: ref.includes('group') ? '-10022' : '-10011', title: ref.includes('group') ? 'Группа' : 'Канал', kind: ref.includes('group') ? 'group' : 'channel' };
      },
      collect: () => { collected += 1; return { messages: [{ id: 1, text: 'Сообщение источника' }] }; },
    },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (name: string, args: Record<string, unknown>) => handler({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    headers: { authorization: `Bearer ${receiverToken}` },
    params: { name, arguments: args },
  }) as Promise<any>;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = createCoordinatorClient({
    endpoint: 'http://coordinator.test/mcp', token: receiverToken,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      calls.push({ name: request.params.name, args: request.params.arguments });
      return new Response(JSON.stringify(await handler({ ...request, headers: { authorization: `Bearer ${receiverToken}` } })), { status: 200 });
    },
  });
  const config: BotsConfig = {
    ownerId, coordinatorUrl: 'http://coordinator.test/mcp', model: { baseUrl: 'https://proxy.invalid/v1', apiKey: 'unused' },
    receiver: { name: 'receiver', token: 'fake-receiver-token', coordToken: receiverToken }, talkers: [],
  };
  const input = (messageId: string, text: string, extra: Record<string, unknown> = {}) => ({ chat_id: ownerId, message_id: messageId, date: now().toISOString(), text, entities: [], ...extra });
  return { archive, coordinator, call, client, config, calls, fetched, resolved, input, collected: () => collected, close() { coordinator.close(); archive.close(); } };
}

function telegramMessage(id: number, text: string, extra: Record<string, unknown> = {}) {
  return { update_id: id, message: { message_id: id, date: Math.floor(now().getTime() / 1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text, ...extra } };
}

function records(f: ReturnType<typeof fixture>): Array<{ path: string; archive_id: string }> {
  return f.archive.getState().records as Array<{ path: string; archive_id: string }>;
}

async function runUpdates(f: ReturnType<typeof fixture>, updates: unknown[] | ((sent: unknown[][]) => unknown[][])) {
  const controller = new AbortController();
  const sent: unknown[][] = [];
  let polls = 0;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runBots({
        config: f.config, signal: controller.signal,
        botApiFactory: () => ({
          async getUpdates() {
            if (typeof updates === 'function') {
              if (++polls <= 2) return updates(sent)[polls - 1] as any;
            } else if (++polls === 1) return updates as any;
            controller.abort();
            return [];
          },
          async sendMessage(...args: unknown[]) { sent.push(args); return { message_id: sent.length }; },
          async answerCallbackQuery(...args: unknown[]) { sent.push(args); return true; },
        }),
        coordinatorClientFactory: (_name, token) => { assert.equal(token, receiverToken); return f.client; },
        log: () => {}, sleep: async () => { controller.abort(); },
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('receiver process did not finish')), 2000); }),
    ]);
    return sent;
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('Б-02: inbox_save keeps plain text in notes and saves every web link as a page', async () => {
  const f = fixture();
  try {
    const plain = await f.call('inbox_save', f.input('1', 'Простая заметка'));
    assert.equal(plain.result.structuredContent.success, true);
    assert.match(records(f)[0].path.replaceAll('\\', '/'), /\/notes\/.*_tg\.md$/);
    const links = await f.call('inbox_save', f.input('2', 'Читайте https://example.test/one и https://example.test/two'));
    assert.equal(links.result.structuredContent.success, true);
    assert.deepEqual(f.fetched, ['https://example.test/one', 'https://example.test/two']);
    const web = records(f).filter((row) => /_web(?:_\d{2})?\.md$/.test(row.path));
    assert.equal(web.length, 2);
    assert.ok(web.every((row) => readFileSync(row.path, 'utf8').includes('Содержимое страницы')));
    const count = records(f).length;
    await f.call('inbox_save', f.input('2', 'Читайте https://example.test/one и https://example.test/two'));
    assert.equal(records(f).length, count, 'redelivery must not add pages or notes');
  } finally { f.close(); }
});

test('Б-02: unsafe web links are rejected before fetching and do not create a web page', async () => {
  const f = fixture();
  try {
    await f.call('inbox_save', f.input('3', 'http://127.0.0.1/private'));
    assert.deepEqual(f.fetched, []);
    assert.equal(records(f).filter((row) => row.path.endsWith('_web.md')).length, 0);
  } finally { f.close(); }
});

test('Б-02: forwarded channel and named people use forwards with the correct sender metadata', async () => {
  const f = fixture();
  try {
    const cases = [
      ['4', { type: 'channel', chat: { id: -10011, type: 'channel', username: 'channel' }, message_id: 12, date: Math.floor(now().getTime() / 1000) }, null, null],
      ['5', { type: 'user', sender_user: { id: 777, first_name: 'Оля' }, date: Math.floor(now().getTime() / 1000) }, 'from_user_id', '777'],
      ['6', { type: 'hidden_user', sender_user_name: 'Скрытый автор', date: Math.floor(now().getTime() / 1000) }, 'sender_name', 'Скрытый автор'],
    ] as const;
    for (const [id, forwardOrigin, metadataKey, value] of cases) {
      const response = await f.call('inbox_save', f.input(id, `Пересланное сообщение ${id}`, { forward_origin: forwardOrigin }));
      assert.equal(response.result.structuredContent.success, true);
      const record = records(f).at(-1)!;
      assert.match(record.path.replaceAll('\\', '/'), /\/forwards\/.*_fwd(?:_\d{2})?\.md$/);
      if (metadataKey) assert.equal(String(f.archive.read(record.archive_id).metadata[metadataKey]), value);
    }
    assert.equal(records(f).length, 3);
  } finally { f.close(); }
});

test('Б-02: receiver passes Telegram forward origin through MCP into forwards', async () => {
  const f = fixture();
  try {
    await runUpdates(f, [telegramMessage(12, 'Пересланный текст', {
      forward_origin: { type: 'user', sender_user: { id: 777, first_name: 'Оля' }, date: Math.floor(now().getTime() / 1000) },
    })]);
    assert.equal(f.calls[0]?.name, 'inbox_save');
    assert.equal(records(f).length, 1);
    assert.match(records(f)[0].path.replaceAll('\\', '/'), /\/forwards\/.*_fwd\.md$/);
    assert.equal(String(f.archive.read(records(f)[0].archive_id).metadata.from_user_id), '777');
  } finally { f.close(); }
});

test('Б-03: t.me and @username produce full, summary, none offers; connected sources do not', async () => {
  const f = fixture();
  try {
    for (const [id, text] of [['7', 'https://t.me/channel'], ['8', '@group']]) {
      const response = await f.call('inbox_save', f.input(id, text));
      assert.equal(response.result.structuredContent.success, true);
      const offers = JSON.stringify(response.result.structuredContent.data.offers);
      assert.match(offers, /full/);
      assert.match(offers, /summary/);
      assert.match(offers, /none/);
    }
    assert.ok(f.resolved.length >= 2, 'Telegram references must be resolved through the gateway');
    const connected = await f.call('source_add', { ref: 'https://t.me/channel', mode: 'full' });
    assert.equal(connected.result.structuredContent.success, true);
    const repeat = await f.call('inbox_save', f.input('9', 'https://t.me/channel'));
    assert.deepEqual(repeat.result.structuredContent.data.offers, []);
  } finally { f.close(); }
});

test('Б-03: channel forwards offer source connection, hidden senders offer nothing', async () => {
  const f = fixture();
  try {
    const channel = await f.call('inbox_save', f.input('10', 'Новость', { forward_origin: { type: 'channel', chat: { id: -10011, type: 'channel', username: 'channel' }, message_id: 12, date: Math.floor(now().getTime() / 1000) } }));
    assert.equal(channel.result.structuredContent.success, true);
    assert.match(JSON.stringify(channel.result.structuredContent.data.offers), /full|summary/);
    const hidden = await f.call('inbox_save', f.input('11', 'Текст', { forward_origin: { type: 'hidden_user', sender_user_name: 'Скрытый автор', date: Math.floor(now().getTime() / 1000) } }));
    assert.equal(hidden.result.structuredContent.success, true);
    assert.deepEqual(hidden.result.structuredContent.data.offers, []);
  } finally { f.close(); }
});

test('Б-03: source_add records full and summary modes; summary groups never enter the archive', async () => {
  const f = fixture();
  try {
    const full = await f.call('source_add', { ref: 'https://t.me/channel', mode: 'full' });
    const summary = await f.call('source_add', { ref: 'https://t.me/group', mode: 'summary' });
    assert.equal(full.result.structuredContent.success, true);
    assert.equal(summary.result.structuredContent.success, true);
    const invalid = await f.call('source_add', { ref: 'https://t.me/invalid', mode: 'none' });
    assert.equal(invalid.result.structuredContent.success, false);
    const status = await f.call('collect_status', {});
    assert.equal(status.result.structuredContent.success, true);
    const sources = status.result.structuredContent.data.sources;
    assert.match(JSON.stringify(sources.find((entry: any) => JSON.stringify(entry).includes('channel'))), /full/);
    assert.match(JSON.stringify(sources.find((entry: any) => JSON.stringify(entry).includes('group'))), /summary/);
    const attempted = await f.call('collect_start', { ref: 'https://t.me/group', manifest: [1] });
    assert.equal(attempted.result.structuredContent.success, false);
    assert.equal(f.collected(), 0);
    assert.deepEqual(f.archive.getState().records, []);
  } finally { f.close(); }
});

test('Б-03: choosing a source button registers the requested mode through the bots process', async () => {
  const f = fixture();
  try {
    const sent = await runUpdates(f, (previous) => {
      const buttons = (previous[0]?.[2] as any)?.reply_markup?.inline_keyboard?.flat() ?? [];
      const callback = buttons.find((button: any) => button.text === '📥 Собирать полностью')?.callback_data;
      return [[telegramMessage(20, 'https://t.me/channel')], [{ update_id: 21, callback_query: { id: 'click-1', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]];
    });
    assert.match(JSON.stringify(sent), /📥 Собирать полностью/);
    assert.match(JSON.stringify(sent), /📰 Только сводка/);
    assert.match(JSON.stringify(sent), /✖️ Не нужно/);
    assert.ok(f.calls.some((call) => call.name === 'source_add' && call.args.mode === 'full'));
  } finally { f.close(); }
});

test('Б-03: /status, /pause, /cancel and status buttons call collection tools', async () => {
  const f = fixture();
  try {
    const connected = await f.call('source_add', { ref: 'https://t.me/channel', mode: 'full' });
    assert.equal(connected.result.structuredContent.success, true);
    const sent = await runUpdates(f, [
      telegramMessage(30, '/status'),
      telegramMessage(31, '/pause https://t.me/channel'),
      telegramMessage(32, '/cancel https://t.me/channel'),
    ]);
    assert.ok(f.calls.some((call) => call.name === 'collect_status'));
    assert.ok(f.calls.some((call) => call.name === 'collect_pause'));
    assert.ok(f.calls.some((call) => call.name === 'collect_cancel'));
    assert.match(JSON.stringify(sent), /callback_data/);
    assert.equal(f.archive.getState().records.length, 0, 'commands must not become personal notes');
  } finally { f.close(); }
});

test('Б-03: a pause button returned by /status invokes collect_pause', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call('source_add', { ref: 'https://t.me/channel', mode: 'full' })).result.structuredContent.success, true);
    const sent = await runUpdates(f, (previous) => {
      const buttons = (previous[0]?.[2] as any)?.reply_markup?.inline_keyboard?.flat() ?? [];
      const callback = buttons.find((button: any) => /пауза|приостановить/i.test(String(button.text)))?.callback_data;
      return [[telegramMessage(40, '/status')], [{ update_id: 41, callback_query: { id: 'status-click', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]];
    });
    assert.match(JSON.stringify(sent), /пауза|приостановить/i);
    assert.ok(f.calls.some((call) => call.name === 'collect_pause'));
  } finally { f.close(); }
});

test('Б-02: Приёмщик сообщает владельцу о каждой несохранённой веб-странице и причине', async () => {
  const f = fixture();
  try {
    const sent = await runUpdates(f, [telegramMessage(50, 'https://example.test/one http://127.0.0.1/private')]);
    assert.deepEqual(f.fetched, ['https://example.test/one']);
    assert.equal(records(f).filter((row) => /_web(?:_\d{2})?\.md$/.test(row.path)).length, 1);
    assert.match(String(sent[0]?.[1]), /127\.0\.0\.1\/private.*отклонена правилами безопасности/i);
  } finally { f.close(); }
});

test('Б-03: длинная ссылка остаётся доступной через короткие кнопки подключения и состояния', async () => {
  const f = fixture();
  const longRef = `https://t.me/channel/${'x'.repeat(120)}`;
  try {
    const sent = await runUpdates(f, (previous) => {
      const buttons = (previous[0]?.[2] as any)?.reply_markup?.inline_keyboard?.flat() ?? [];
      const callback = buttons.find((button: any) => button.text === '📥 Собирать полностью')?.callback_data;
      return [[telegramMessage(51, longRef)], [{ update_id: 52, callback_query: { id: 'long-click', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]];
    });
    const buttons = (sent[0]?.[2] as any).reply_markup.inline_keyboard.flat();
    assert.ok(buttons.every((button: any) => Buffer.byteLength(button.callback_data, 'utf8') <= 64));
    assert.ok(f.calls.some((call) => call.name === 'source_add' && typeof call.args.ref_id === 'string'));

    const longConnectedRef = `https://t.me/group/${'y'.repeat(120)}`;
    assert.equal((await f.call('source_add', { ref: longConnectedRef, mode: 'full' })).result.structuredContent.success, true);
    const status = await runUpdates(f, (previous) => {
      const statusButtons = (previous[0]?.[2] as any)?.reply_markup?.inline_keyboard?.flat() ?? [];
      const callback = statusButtons.find((button: any) => /Пауза Группа/.test(button.text))?.callback_data;
      return [[telegramMessage(53, '/status')], [{ update_id: 54, callback_query: { id: 'pause-long', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: callback } }]];
    });
    const statusButtons = (status[0]?.[2] as any).reply_markup.inline_keyboard.flat();
    assert.ok(statusButtons.every((button: any) => Buffer.byteLength(button.callback_data, 'utf8') <= 64));
    assert.ok(f.calls.some((call) => call.name === 'collect_pause' && typeof call.args.ref_id === 'string'));
  } finally { f.close(); }
});

test('Б-02: наличие forward_origin сохраняет пересылку даже при неверной форме поля', async () => {
  const f = fixture();
  try {
    await runUpdates(f, [telegramMessage(55, 'Пересланный текст', { forward_origin: 'неизвестный формат' })]);
    assert.match(records(f)[0].path.replaceAll('\\', '/'), /\/forwards\/.*_fwd\.md$/);
  } finally { f.close(); }
});

test('Б-03: команды с пробелами и без аргумента не становятся заметками', async () => {
  const f = fixture();
  try {
    const sent = await runUpdates(f, [telegramMessage(56, '  /status  '), telegramMessage(57, '/pause'), telegramMessage(58, '/cancel')]);
    assert.ok(f.calls.some((call) => call.name === 'collect_status'));
    assert.equal(f.calls.filter((call) => call.name === 'inbox_save').length, 0);
    assert.equal(records(f).length, 0);
    assert.match(JSON.stringify(sent), /Укажите ссылку.*\/pause/);
    assert.match(JSON.stringify(sent), /Укажите ссылку.*\/cancel/);
  } finally { f.close(); }
});

test('Б-03: электронные адреса не считаются упоминаниями Telegram', async () => {
  const f = fixture();
  try {
    const result = await f.call('inbox_save', f.input('59', 'user@example.com и юзер@example.com'));
    assert.equal(result.result.structuredContent.success, true);
    assert.deepEqual(result.result.structuredContent.data.offers, []);
    assert.deepEqual(f.resolved, []);
    const mention = await f.call('inbox_save', f.input('60', 'Смотрите @channel'));
    assert.equal(mention.result.structuredContent.data.offers.length, 1);
  } finally { f.close(); }
});

test('Б-02: ошибка координатора не задерживает следующее обновление Приёмщика', async () => {
  const f = fixture();
  const controller = new AbortController();
  const offsets: number[] = [];
  const sent: string[] = [];
  const logs: string[] = [];
  let calls = 0;
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates({ offset }) {
          offsets.push(offset);
          if (offsets.length === 1) return [telegramMessage(61, 'секрет первого сообщения'), telegramMessage(62, 'Вторая заметка')];
          controller.abort();
          return [];
        },
        async sendMessage(_chatId, text) { sent.push(text); },
      }),
      coordinatorClientFactory: () => ({ async callTool(name, args) {
        if (++calls === 1) throw new Error('секрет координатора');
        return f.client.callTool(name, args);
      } }),
      log: (line) => logs.push(line),
    });
    assert.deepEqual(offsets, [0, 63]);
    assert.deepEqual(sent, ['Не удалось обработать сообщение, пришлите ещё раз', 'Сохранено']);
    assert.equal(records(f).length, 1);
    assert.ok(logs.every((line) => !line.includes('секрет')));
  } finally { controller.abort(); f.close(); }
});

test('Б-03: отказ действия кнопки возвращает ошибку через answerCallbackQuery', async () => {
  const f = fixture();
  const controller = new AbortController();
  const answers: unknown[][] = [];
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates() {
          controller.abort();
          return [{ update_id: 63, callback_query: { id: 'bad-button', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: 's:full:0123456789abcdef0123456789abcdef' } }];
        },
        async answerCallbackQuery(...args) { answers.push(args); },
      }),
      coordinatorClientFactory: () => ({ async callTool() { return { success: false }; } }),
      log: () => {},
    });
    assert.deepEqual(answers, [['bad-button', { text: 'Не удалось выполнить действие. Попробуйте ещё раз', show_alert: true }]]);
  } finally { controller.abort(); f.close(); }
});

test('Б-03: чужой пользователь и чужой личный чат не подключают источник кнопкой', async () => {
  const f = fixture();
  try {
    const saved = await f.call('inbox_save', f.input('64', 'https://t.me/channel'));
    const refId = saved.result.structuredContent.data.offers[0].ref_id;
    const callback = (id: number, fromId: number, chatId: number) => ({
      update_id: id,
      callback_query: { id: `foreign-${id}`, from: { id: fromId }, message: { chat: { id: chatId, type: 'private' } }, data: `s:full:${refId}` },
    });
    const sent = await runUpdates(f, [callback(65, 67890, 12345), callback(66, 12345, 67890)]);
    assert.deepEqual(sent, []);
    assert.deepEqual(f.calls, []);
    const status = await f.call('collect_status', {});
    assert.deepEqual(status.result.structuredContent.data.sources, []);
  } finally { f.close(); }
});

test('Б-02: сбой отправки подтверждения не возвращает обработанное обновление и не теряет следующее', async () => {
  const f = fixture();
  const controller = new AbortController();
  const offsets: number[] = [];
  const sent: string[] = [];
  let firstSend = true;
  try {
    await runBots({
      config: f.config, signal: controller.signal,
      botApiFactory: () => ({
        async getUpdates({ offset }) {
          offsets.push(offset);
          if (offsets.length === 1) return [telegramMessage(70, 'Первая заметка'), telegramMessage(71, 'Вторая заметка')];
          controller.abort();
          return [];
        },
        async sendMessage(_chatId, text) {
          if (firstSend) { firstSend = false; throw new Error('sendMessage failed'); }
          sent.push(text);
        },
      }),
      coordinatorClientFactory: () => f.client,
      log: () => {},
    });
    assert.deepEqual(offsets, [0, 72]);
    assert.deepEqual(sent, ['Не удалось обработать сообщение, пришлите ещё раз', 'Сохранено']);
    assert.equal(records(f).length, 2);
  } finally { controller.abort(); f.close(); }
});
