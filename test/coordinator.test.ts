import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Archive } from '../src/archive.ts';
import { Coordinator, createCoordinatorMcpHandler, FloodWaitError, type ResolvedTelegramSource, type TelegramGateway, type TelegramPage } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

function setup(gateway: TelegramGateway, now = () => new Date('2026-09-21T10:00:00.000Z')) {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-coordinator-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now });
  const coordinator = new Coordinator({ archive, telegram: gateway, now });
  return { root, archive, coordinator };
}

test('П-02: source_add resolves a URL once and keeps a paused source', async () => {
  let resolves = 0;
  const { coordinator } = setup({
    resolveSource: (ref) => { resolves += 1; return { chatId: '-1001', title: ref.includes('group') ? 'Group' : 'Channel', kind: ref.includes('group') ? 'group' : 'channel' }; },
  });
  try {
    const first = await coordinator.callTool('source_add', { ref: 'https://t.me/channel' });
    const second = await coordinator.callTool('source_add', { ref: 'https://t.me/channel/' });
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(resolves, 1);
    assert.equal((first as any).data.chat_id, '-1001');
    assert.equal((second as any).data.status, 'paused');
    const invalid = await coordinator.callTool('source_add', { ref: 'https://t.me/+invite' });
    assert.equal(invalid.success, false);
    assert.equal((invalid as any).error.code, 'unsupported_source');
  } finally { coordinator.close(); }
});

test('П-03: pilot validates an immutable unique manifest and archives only approved messages', async () => {
  let calls = 0;
  const page: TelegramPage = { messages: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 2, text: 'duplicate' }, { id: 99, text: 'not approved' }] };
  const { coordinator } = setup({
    resolveSource: () => ({ chatId: '-1002', title: 'Channel', kind: 'channel' }),
    collect: () => { calls += 1; return page; },
  });
  try {
    const duplicate = await coordinator.callTool('collect_start', { ref: 'https://t.me/channel', manifest: [1, 1], limit: 2 });
    assert.equal(duplicate.success, false);
    assert.equal((duplicate as any).error.code, 'invalid_argument');
    const tooLarge = await coordinator.callTool('collect_start', { ref: 'https://t.me/channel', manifest: [1], limit: 101 });
    assert.equal(tooLarge.success, false);
    const started = await coordinator.callTool('collect_start', { ref: 'https://t.me/channel', manifest: [1, 2], limit: 2 });
    assert.equal(started.success, true);
    assert.equal((started as any).data.state, 'completed');
    assert.deepEqual((started as any).data.counts, { saved: 2, unchanged: 0, skipped: 0, errors: 0 });
    assert.equal(calls, 1);
    assert.equal(coordinator.archive.getState().records.length, 2);
    const changed = await coordinator.callTool('collect_start', { ref: 'https://t.me/channel', manifest: [2, 1], limit: 2 });
    assert.equal(changed.success, true);
    assert.notEqual((changed as any).data.job_id, (started as any).data.job_id);
  } finally { coordinator.close(); }
});

test('П-04: pause and cancel do not call Telegram and preserve archive state', async () => {
  let collectCalls = 0;
  let available = true;
  const { coordinator } = setup({
    resolveSource: () => { if (!available) throw new Error('offline'); return { chatId: '-1003', title: 'Channel', kind: 'channel' }; },
    collect: () => { collectCalls += 1; return { messages: [{ id: 1, text: 'saved' }] }; },
  });
  try {
    await coordinator.callTool('source_add', { ref: 'https://t.me/pause-me' });
    const started = await coordinator.callTool('collect_start', { ref: 'https://t.me/pause-me', manifest: [1] });
    assert.equal(started.success, true);
    const records = coordinator.archive.getState().records.length;
    available = false;
    const paused = await coordinator.callTool('collect_pause', { ref: 'https://t.me/pause-me' });
    const pausedAgain = await coordinator.callTool('collect_pause', { ref: 'https://t.me/pause-me' });
    assert.equal(paused.success, true);
    assert.equal(pausedAgain.success, true);
    assert.equal((paused as any).data.source.status, 'paused');
    const cancelled = await coordinator.callTool('collect_cancel', { ref: 'https://t.me/pause-me' });
    assert.equal(cancelled.success, true);
    assert.equal((cancelled as any).data.job.state, 'completed');
    assert.equal(coordinator.archive.getState().records.length, records);
    assert.equal(collectCalls, 1);
  } finally { coordinator.close(); }
});

test('П-19: FloodWait is durable and does not retry before its deadline after restart', async () => {
  let now = new Date('2026-09-21T10:00:00.000Z');
  let calls = 0;
  const gateway: TelegramGateway = {
    resolveSource: () => ({ chatId: '-1004', title: 'Channel', kind: 'channel' }),
    collect: () => { calls += 1; if (calls === 1) throw new FloodWaitError(30); return { messages: [{ id: 4, text: 'after wait' }] }; },
  };
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-flood-'));
  const firstArchive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  const first = new Coordinator({ archive: firstArchive, telegram: gateway, now: () => now });
  const started = await first.callTool('collect_start', { ref: 'https://t.me/flood', manifest: [4] });
  assert.equal(started.success, true);
  assert.equal((started as any).data.state, 'waiting');
  first.close();
  now = new Date('2026-09-21T10:00:10.000Z');
  const secondArchive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  const second = new Coordinator({ archive: secondArchive, telegram: gateway, now: () => now });
  try {
    const early = await second.callTool('collect_start', { ref: 'https://t.me/flood', manifest: [4] });
    assert.equal(early.success, true);
    assert.equal((early as any).data.state, 'waiting');
    assert.equal(calls, 1);
    now = new Date('2026-09-21T10:00:31.000Z');
    const resumed = await second.callTool('collect_start', { ref: 'https://t.me/flood', manifest: [4] });
    assert.equal(resumed.success, true);
    assert.equal((resumed as any).data.state, 'completed');
    assert.equal(calls, 2);
  } finally { second.close(); }
});

test('stage 2 review branches stay stable through Coordinator and MCP', async () => {
  const privateDialog = setup({
    resolveSource: () => ({ chatId: '42', title: 'Private dialog', kind: 'user' } as unknown as ResolvedTelegramSource),
  });
  try {
    const response = await privateDialog.coordinator.handleMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'source_add', arguments: { ref: 'https://t.me/private-dialog' } },
    }) as any;
    assert.equal(response.result.structuredContent.success, false);
    assert.equal(response.result.structuredContent.error.code, 'unsupported_source');
  } finally { privateDialog.coordinator.close(); }

  const unavailable = setup({ resolveSource: () => { throw new Error('offline'); } });
  try {
    const response = await unavailable.coordinator.handleMcpRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'source_add', arguments: { ref: 'https://t.me/offline' } },
    }) as any;
    assert.equal(response.result.structuredContent.success, false);
    assert.equal(response.result.structuredContent.error.code, 'source_unavailable');
  } finally { unavailable.coordinator.close(); }

  const active = setup({
    resolveSource: () => ({ chatId: '-1006', title: 'Channel', kind: 'channel' }),
    collect: () => { throw new FloodWaitError(30); },
  });
  try {
    const started = await active.coordinator.callTool('collect_start', { ref: 'https://t.me/active', manifest: [6] });
    assert.equal(started.success, true);
    const jobId = (started as any).data.job_id;
    const repeated = await active.coordinator.callTool('collect_start', { ref: 'https://t.me/active', manifest: [6] });
    assert.equal(repeated.success, true);
    assert.equal((repeated as any).data.job_id, jobId);
    const incompatible = await active.coordinator.callTool('collect_start', { ref: 'https://t.me/active', manifest: [7] });
    assert.equal(incompatible.success, false);
    assert.equal((incompatible as any).error.code, 'operation_in_progress');
    assert.equal((incompatible as any).error.job_id, jobId);
  } finally { active.coordinator.close(); }
});

test('MCP handler returns JSON with contract version and stable errors', async () => {
  const { coordinator } = setup({ resolveSource: () => ({ chatId: '-1005', title: 'Channel', kind: 'channel' }) });
  try {
    const response = await coordinator.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'source_add', arguments: { ref: 'https://example.org/nope' } } }) as any;
    const value = response.result.structuredContent;
    assert.equal(value.contract_version, 1);
    assert.equal(value.success, false);
    assert.equal(value.error.code, 'unsupported_source');
  } finally { coordinator.close(); }
});

test('coordinator MCP preserves name_exhausted instead of reporting archive_corrupt', async () => {
  const { archive, coordinator } = setup({ resolveSource: () => ({ chatId: '-1005', title: 'Channel', kind: 'channel' }) });
  try {
    for (let index = 0; index < 100; index += 1) {
      archive.savePersonalTelegram({ text: 'occupied', operationId: `occupied-${index}` });
    }

    const handle = createCoordinatorMcpHandler(coordinator, 'coordinator-secret');
    const response = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      headers: { authorization: 'Bearer coordinator-secret' },
      params: { name: 'personal_save', arguments: { text: 'one too many', operation_id: 'overflow' } },
    }) as any;
    const result = response.result.structuredContent;
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'name_exhausted');
    assert.notEqual(result.error.code, 'archive_corrupt');
  } finally {
    coordinator.close();
    archive.close();
  }
});

test('coordinator MCP saves personal text and web pages below notes/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-personal-mcp-'));
  const now = () => new Date('2026-09-21T10:00:00.000Z');
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now });
  const openViking = { async search() { return []; }, async importText() {}, async importFile() {} };
  const integrations = new Stage3Service({
    archive,
    openViking,
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => ({
      status: 200,
      finalUrl: 'https://example.test/article',
      remoteAddress: '93.184.216.34',
      headers: { 'content-type': 'text/html' },
      body: '<article>web page</article>',
    }),
    clipper: async () => ({ content: 'web page', title: 'Example' }),
    tokenSecret: 'read-token-secret',
    now,
  });
  const coordinator = new Coordinator({
    archive,
    ownerId: 'owner',
    telegram: { resolveSource: () => ({ chatId: '-1001', kind: 'channel' }) },
    integrations,
    now,
  });
  const handle = createCoordinatorMcpHandler(coordinator, 'coordinator-secret');
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handle({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      headers: { authorization: 'Bearer coordinator-secret' },
      params: { name, arguments: args },
    }) as any;
    return response.result.structuredContent;
  };

  try {
    const note = await call('personal_save', { text: 'owner note', operation_id: 'note-1' });
    const web = await call('web_save', { url: 'https://example.test/article' });

    assert.equal(note.success, true);
    assert.equal(note.data.path, join(root, 'personal', 'owner', 'notes', '2026-09-21_130000_tg.md'));
    assert.equal(web.success, true);
    assert.equal(web.data.path, join(root, 'personal', 'owner', 'notes', '2026-09-21_130000_web.md'));
    assert.equal(archive.read(note.data.archiveId).metadata.schema_version, 1);
    assert.equal(archive.read(web.data.archiveId).metadata.schema_version, 1);
  } finally {
    coordinator.close();
    archive.close();
  }
});

test('coordinator MCP saves forwards in personal/forwards with explicit, missing, or empty sender metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-forwards-mcp-'));
  const now = () => new Date('2026-09-21T10:00:00.000Z');
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now });
  let sourceResolutions = 0;
  const coordinator = new Coordinator({
    archive,
    ownerId: 'owner',
    now,
    telegram: { resolveSource: () => { sourceResolutions++; return { chatId: '-1001', kind: 'channel' }; } },
  });
  const handle = createCoordinatorMcpHandler(coordinator, 'coordinator-secret');
  let id = 0;
  const call = async (args: Record<string, unknown>) => {
    const response = await handle({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      headers: { authorization: 'Bearer coordinator-secret' },
      params: { name: 'personal_save', arguments: args },
    }) as any;
    return response.result.structuredContent;
  };

  try {
    const open = await call({
      text: 'forward with visible author',
      operation_id: 'forward-open',
      forward: { from_user_id: 'user-42' },
      extra: { custom_note: 'keep this optional field' },
    });
    const hidden = await call({
      text: 'forward with hidden author',
      operation_id: 'forward-hidden',
      forward: { sender_name: 'Hidden Author' },
    });
    const missing = await call({ text: 'forward without author metadata', operation_id: 'forward-missing', forward: {} });
    const empty = await call({
      text: 'forward with empty author fields',
      operation_id: 'forward-empty',
      forward: { from_user_id: '', sender_name: '' },
    });

    const documents = [open, hidden, missing, empty].map((result) => ({
      path: result.data.path,
      metadata: archive.read(result.data.archiveId).metadata,
    }));
    assert.deepEqual(documents.map(({ path, metadata }) => ({
      path,
      schema_version: metadata.schema_version,
      from_user_id: metadata.from_user_id,
      sender_name: metadata.sender_name,
      custom_note: metadata.custom_note,
    })), [
      {
        path: join(root, 'personal', 'owner', 'forwards', '2026-09-21_130000_fwd.md'),
        schema_version: 1,
        from_user_id: 'user-42',
        sender_name: null,
        custom_note: 'keep this optional field',
      },
      {
        path: join(root, 'personal', 'owner', 'forwards', '2026-09-21_130000_fwd_01.md'),
        schema_version: 1,
        from_user_id: null,
        sender_name: 'Hidden Author',
        custom_note: undefined,
      },
      {
        path: join(root, 'personal', 'owner', 'forwards', '2026-09-21_130000_fwd_02.md'),
        schema_version: 1,
        from_user_id: null,
        sender_name: null,
        custom_note: undefined,
      },
      {
        path: join(root, 'personal', 'owner', 'forwards', '2026-09-21_130000_fwd_03.md'),
        schema_version: 1,
        from_user_id: null,
        sender_name: null,
        custom_note: undefined,
      },
    ]);
    assert.equal(sourceResolutions, 0);
  } finally {
    coordinator.close();
    archive.close();
  }
});
