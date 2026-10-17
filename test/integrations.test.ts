import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Archive, Stage3Service, makeReadToken } from '../src/index.ts';

const now = new Date('2026-09-21T12:00:00.000Z');

function makeService(overrides: Record<string, unknown> = {}) {
  const saved: any[] = [];
  const searches: any[] = [];
  const reads: string[] = [];
  const archive = {
    saveWeb(input: any) {
      saved.push(input);
      return { archiveId: 'personal_web:owner:example', path: 'example.md', revision: 1, contentHash: 'hash', created: saved.length === 1 };
    },
    getState() { return { outbox: [{ status: 'pending' }] }; },
  };
  const openViking = {
    async search(input: any) { searches.push(input); return [{ id: 'hit' }]; },
    async read(id: string) { reads.push(id); return { id }; },
  };
  const service: any = new Stage3Service({
    archive,
    openViking,
    resolveHost: async (host: string) => /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') ? [host] : ['93.184.216.34'],
    fetchPage: async () => ({
      status: 200,
      finalUrl: 'https://example.test/final',
      remoteAddress: '93.184.216.34',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<title>Example</title><article><h1>Heading</h1><p>Hello <a href="/docs">docs</a></p><script>bad()</script></article>',
    }),
    clipper: async (html: string) => html.includes('only()')
      ? { content: '' }
      : { content: '# Example\n\n[docs](https://example.test/docs)', title: 'Example' },
    tokenSecret: 'secret',
    now: () => now,
    sourceExists: async (ref: string) => ref === 'known',
    ...overrides,
  } as any);
  return { service, saved, searches, reads };
}

test('web_save sanitizes HTML, absolutizes links, records fetched_at, and is idempotent', async () => {
  const { service, saved } = makeService();
  const first = await service.handleMcpRequest({ method: 'web_save', arguments: { url: 'https://example.test/start' } });
  const second = await service.callTool('web_save', { url: 'https://example.test/start' });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.created, true);
  assert.equal(second.data.created, false);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].requestedUrl, 'https://example.test/start');
  assert.equal(saved[0].finalUrl, 'https://example.test/final');
  assert.match(saved[0].text, /# Example/);
  assert.match(saved[0].text, /\[docs\]\(https:\/\/example\.test\/docs\)/);
  assert.equal(saved[0].extra.fetched_at, now.toISOString());
});

test('web_save rejects private, loopback, and link-local IPv4/IPv6, redirects, and DNS rebinding', async () => {
  for (const url of ['http://10.0.0.1/', 'http://127.0.0.1/', 'http://169.254.1.1/', 'http://[::1]/', 'http://[fe80::1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/']) {
    const { service } = makeService();
    const result = await service.callTool('web_save', { url });
    assert.equal(result.error, 'unsafe_url', url);
  }

  for (const address of ['2130706433', '0x7f000001', '017700000001', '127.1', '::ffff:127.0.0.1']) {
    const { service } = makeService({ resolveHost: async () => [address] });
    assert.equal((await service.callTool('web_save', { url: 'https://example.test' })).error, 'unsafe_url', address);
  }

  const redirect = makeService({ fetchPage: async () => ({ status: 200, finalUrl: 'https://safe.test/landing', remoteAddress: '93.184.216.34', headers: { 'content-type': 'text/html' }, body: '<article>ok</article>' }) });
  const redirectResult = await redirect.service.callTool('web_save', { url: 'https://safe.test/start' });
  assert.equal(redirectResult.success, true);
  assert.equal(redirect.saved[0].finalUrl, 'https://safe.test/landing');

  const rebinding = makeService({ fetchPage: async () => ({ status: 200, finalUrl: 'https://safe.test/landing', remoteAddress: '192.168.1.5', headers: { 'content-type': 'text/html' }, body: '<article>ok</article>' }) });
  const rebindingResult = await rebinding.service.callTool('web_save', { url: 'https://safe.test/start' });
  assert.equal(rebindingResult.error, 'unsafe_url');
});

test('web_save reports timeout, size, content type, empty article, and JavaScript requirements', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['timeout', { fetchPage: async () => { throw new Error('timed out'); } }],
    ['content_too_large', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'text/html' }, body: 'x'.repeat(5 * 1024 * 1024 + 1) }) }],
    ['content_too_large', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'text/html' }, body: '😀'.repeat(Math.floor((5 * 1024 * 1024) / Buffer.byteLength('😀')) + 1) }) }],
    ['unsupported_content', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'application/pdf' }, body: '<article>pdf</article>' }) }],
    ['unsupported_content', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'text/htmlish' }, body: '<article>htmlish</article>' }) }],
    ['unsupported_content', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'application/foo;text/html' }, body: '<article>wrong</article>' }) }],
    ['empty_article', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'text/html' }, body: '<script>only()</script>' }) }],
    ['javascript_required', { fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test', headers: { 'content-type': 'text/html' }, body: '<article>javascript_required</article>' }) }],
  ];
  for (const [error, overrides] of cases) {
    const { service } = makeService(overrides);
    const result = await service.callTool('web_save', { url: 'https://example.test' });
    assert.equal(result.error, error);
  }
});

test('search passes all scopes, reports unknown source and OpenViking outages, and returns freshness lag', async () => {
  const { service, searches } = makeService();
  for (const args of [{ scope: 'all' }, { scope: 'personal' }, { scope: 'source', source: 'known' }]) {
    const result = await service.callTool('search', args);
    assert.equal(result.success, true);
    assert.equal(result.data.freshness.pending, 1);
  }
  assert.deepEqual(searches.map((item) => item.scope), ['all', 'personal', 'source']);
  assert.equal((await service.callTool('search', { scope: 'source', source: 'missing' })).error, 'unknown_source');

  const unavailable = makeService({ openViking: { search: async () => { throw new Error('down'); } } });
  assert.equal((await unavailable.service.callTool('search', { scope: 'all' })).error, 'upstream_unavailable');
  const noSourceCheck = makeService({ sourceExists: undefined });
  assert.equal((await noSourceCheck.service.callTool('search', { scope: 'source', source: 'known' })).error, 'configuration_error');
});

test('read accepts valid tokens and rejects altered, wrong-owner, and expired tokens', async () => {
  const { service, reads } = makeService();
  const valid = makeReadToken('owner', 'archive-1', Math.floor(now.getTime() / 1000) + 60, 'secret');
  const validResult = await service.callTool('read', { read_token: valid });
  assert.equal(validResult.success, true);
  assert.deepEqual(validResult.data, { id: 'archive-1' });
  assert.deepEqual(reads, ['archive-1']);

  const altered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await service.callTool('read', { read_token: altered })).error, 'invalid_token');
  const wrongOwner = makeReadToken('other', 'archive-1', Math.floor(now.getTime() / 1000) + 60, 'secret');
  assert.equal((await service.callTool('read', { read_token: wrongOwner })).error, 'invalid_token');
  const expired = makeReadToken('owner', 'archive-1', Math.floor(now.getTime() / 1000) - 1, 'secret');
  assert.equal((await service.callTool('read', { read_token: expired })).error, 'invalid_token');
  for (const payload of [
    { ownerId: 'owner', archiveId: 'archive-1', exp: undefined },
    { ownerId: 'owner', archiveId: 'archive-1', exp: Number.NaN },
    { ownerId: 'owner', archiveId: 'archive-1', exp: 1.5 },
    { ownerId: 'owner', archiveId: 'archive-1', exp: Math.floor(now.getTime() / 1000) },
    { ownerId: 1, archiveId: 'archive-1', exp: Math.floor(now.getTime() / 1000) + 60 },
    { ownerId: 'owner', archiveId: 1, exp: Math.floor(now.getTime() / 1000) + 60 },
  ]) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${encoded}.${createHmac('sha256', 'secret').update(encoded).digest('base64url')}`;
    assert.equal((await service.callTool('read', { read_token: token })).error, 'invalid_token');
  }
});

test('П-10: false deletion observations never change the archive, explicit deletion keeps an excerpt', async () => {
  const calls: any[] = [];
  const archive: any = {
    getState: () => ({ outbox: [] }),
    saveTelegram: (input: any) => { calls.push(['save', input]); return { archiveId: 'telegram_channel:1:2', revision: 1, created: true }; },
    markTelegramDeleted: (input: any) => { calls.push(['delete', input]); return { archiveId: 'telegram_channel:1:2', revision: 2, created: false }; },
    read: () => ({ content: 'старый текст\n', metadata: {} }),
  };
  const { service } = makeService({ archive });
  for (const state of ['not_found', 'empty_page', 'access_lost']) {
    const result = await service.callTool('telegram_delete', { kind: 'channel', chatId: 1, messageId: 2, state, explicit_deleted: true });
    assert.equal(result.data.deleted, false);
  }
  assert.equal(calls.length, 0);
  const deleted = await service.callTool('telegram_delete', { kind: 'channel', chatId: 1, messageId: 2, explicit_deleted: true, evidence: 'telegram-confirmed' });
  assert.equal(deleted.data.deleted, true);
  assert.equal(deleted.data.excerpt, 'старый текст');
  assert.equal(calls.length, 1);
});

test('П-11: attachments verify metadata, incomplete stays unready, media is restricted', async () => {
  const calls: any[] = [];
  const archive: any = {
    getState: () => ({ outbox: [] }),
    saveTelegramAttachment: (input: any) => {
      calls.push(input);
      if (input.attachment.size !== 3 || input.attachment.sha256 !== 'ok') throw new Error('Attachment hash mismatch');
      return { archiveId: 'telegram_channel:1:2', revision: 2, created: false };
    },
  };
  const { service } = makeService({ archive });
  const good = await service.callTool('telegram_attachment', { kind: 'channel', chatId: 1, messageId: 2, type: 'document', name: 'a.pdf', base64: Buffer.from('abc').toString('base64'), size: 3, sha256: 'ok' });
  assert.equal(good.data.attachment.ready, true);
  const bad = await service.callTool('telegram_attachment', { kind: 'channel', chatId: 1, messageId: 2, type: 'document', base64: Buffer.from('abc').toString('base64'), size: 4, sha256: 'bad' });
  assert.equal(bad.error, 'attachment_mismatch');
  const incomplete = await service.callTool('telegram_attachment', { kind: 'channel', chatId: 1, messageId: 2, type: 'document', name: 'later.pdf', complete: false });
  assert.equal(incomplete.data.ready, false);
  assert.equal((await service.callTool('telegram_attachment', { kind: 'channel', chatId: 1, messageId: 2, type: 'audio', complete: true })).error, 'unsupported_media');
  assert.equal((await service.callTool('telegram_attachment', { kind: 'channel', chatId: 1, messageId: 2, type: 'image', base64: 'YWJj', size: 3, sha256: 'ok' })).data.attachment.type, 'image');
  assert.equal(calls.length, 3);
});

test('projection_run retries failed imports with stable IDs, imports files, and skips unchanged records', async () => {
  const outbox = [{ archive_id: 'telegram_channel:1:2', revision: 1, path: 'm.md', status: 'pending' }];
  const archive: any = {
    rootDir: 'archive',
    getState: () => ({ outbox }),
    claimOutbox: () => { outbox[0].status = 'in_progress'; return [{ ...outbox[0] }]; },
    read: () => ({ content: 'text\n', metadata: { operation_id: 'op-1', attachments: [{ type: 'document', state: 'ready', path: 'attachments/a.pdf' }] } }),
    acknowledgeProjection: (_id: string, _revision: number) => { outbox[0].status = 'completed'; return 'completed'; },
  };
  const imports: any[] = [];
  let fail = true;
  const { service } = makeService({ archive, openViking: {
    async search() { return []; },
    async importText(input: any) { imports.push(['text', input]); if (fail) { fail = false; throw new Error('down'); } },
    async importFile(input: any) { imports.push(['file', input]); },
  } });
  const first = await service.callTool('projection_run');
  assert.equal(first.data.retryable, 1);
  assert.equal(outbox[0].status, 'in_progress');
  const second = await service.callTool('projection_run');
  assert.equal(second.data.completed, 1);
  assert.equal(outbox[0].status, 'completed');
  assert.equal(imports[1][1].idempotencyKey, imports[2][1].idempotencyKey);
  const importCount = imports.length;
  const unchanged = await service.callTool('projection_run') as any;
  assert.equal(unchanged.data.processed, 0);
  assert.equal(imports.length, importCount);
});

test('Б-07: projection URIs follow archive paths and search scopes stay isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-projection-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  const channelId = '-1001234567890123';
  const channel = archive.saveTelegram({
    kind: 'channel', chatId: channelId, messageId: '1', text: 'channel text',
    attachments: [{ type: 'document', name: 'notes.pdf', data: new TextEncoder().encode('pdf bytes') }],
  });
  const group = archive.saveTelegram({ kind: 'group', chatId: '-1001234567890124', messageId: '2', text: 'group text' });
  const personal = archive.savePersonalTelegram({ text: 'personal text', operationId: 'personal-note-1' });
  const attachment = (archive.read(channel.archiveId).metadata.attachments as any[])[0];
  const attachmentPath = resolve(root, attachment.path);
  const uriFor = (path: string) => `viking://resources/${relative(root, path).split(sep).join('/')}`;
  const channelUri = uriFor(channel.path);
  const groupUri = uriFor(group.path);
  const personalUri = uriFor(personal.path);
  const attachmentUri = uriFor(attachmentPath);
  const imports: any[] = [];
  const projectedResources = new Map<string, { archive_id: string; revision: number }>();
  const openViking = {
    async importText(input: any) {
      imports.push({ kind: 'text', archiveId: input.archiveId, uri: input.uri });
      projectedResources.set(input.uri, { archive_id: input.archiveId, revision: input.revision });
    },
    async importFile(input: any) { imports.push({ kind: 'file', archiveId: input.archiveId, uri: input.uri }); },
    async search(input: any) {
      return [...projectedResources]
        .filter(([uri]) => uri.startsWith(input.target_uri))
        .map(([, record]) => record);
    },
  };
  const { service } = makeService({
    archive,
    openViking,
    sourceExists: async (ref: string) => ref === channelId,
    sourceTargetUri: async (ref: string) => `viking://resources/telegram/channels/${ref}/`,
  });

  try {
    await service.callTool('projection_run');
    const expectedImports = [
      { kind: 'text', archiveId: channel.archiveId, uri: channelUri },
      { kind: 'file', archiveId: channel.archiveId, uri: attachmentUri },
      { kind: 'text', archiveId: group.archiveId, uri: groupUri },
      { kind: 'text', archiveId: personal.archiveId, uri: personalUri },
    ].sort((a, b) => `${a.kind}:${a.archiveId}:${a.uri}`.localeCompare(`${b.kind}:${b.archiveId}:${b.uri}`));
    const actualImports = imports.sort((a, b) => `${a.kind}:${a.archiveId}:${a.uri}`.localeCompare(`${b.kind}:${b.archiveId}:${b.uri}`));

    assert.deepEqual(actualImports, expectedImports);

    const searchIds = async (scope: string, ref?: string) => {
      const result = await service.callTool('knowledge_search', { query: 'text', scope, ref, limit: 20 });
      assert.equal(result.success, true);
      return result.data.results.map((item: any) => item.archive_id).sort();
    };
    assert.deepEqual(await searchIds('personal'), [personal.archiveId]);
    assert.deepEqual(await searchIds('all_telegram'), [channel.archiveId, group.archiveId].sort());
    assert.deepEqual(await searchIds('source', channelId), [channel.archiveId]);
  } finally {
    archive.close();
  }
});

test('personal projection uses notes/ and forwards/ URIs and personal search finds each kind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-personal-projection-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  const note = archive.savePersonalTelegram({ text: 'owner note', operationId: 'note-1', receivedAt: now });
  const web = archive.saveWeb({ requestedUrl: 'https://example.test/article', text: 'web note', operationId: 'web-1', receivedAt: now, retrievedAt: now });
  const forward = archive.savePersonalTelegram({
    text: 'forwarded note',
    operationId: 'forward-1',
    receivedAt: now,
    forward: { from_user_id: 'user-42' },
  } as any);
  const imports: Array<{ archiveId: string; revision: number; uri: string }> = [];
  const resources = new Map<string, { archive_id: string; revision: number }>();
  const openViking = {
    async importText(input: any) {
      imports.push({ archiveId: input.archiveId, revision: input.revision, uri: input.uri });
      resources.set(input.uri, { archive_id: input.archiveId, revision: input.revision });
    },
    async importFile() {},
    async search(input: any) {
      return [...resources]
        .filter(([uri]) => uri.startsWith(input.target_uri))
        .map(([, record]) => record);
    },
  };
  const { service } = makeService({ archive, openViking, ownerId: 'owner', now: () => now });

  try {
    const projection = await service.callTool('projection_run');
    const search = await service.callTool('knowledge_search', { query: 'personal', scope: 'personal', limit: 20 });
    assert.equal(projection.success, true);
    assert.equal(search.success, true);
    assert.deepEqual({
      uris: imports.map(({ uri }) => uri).sort(),
      archiveIds: search.data.results.map((item: any) => item.archive_id).sort(),
    }, {
      uris: [
        'viking://resources/personal/owner/notes/2026-09-21_150000_tg.md',
        'viking://resources/personal/owner/notes/2026-09-21_150000_web.md',
        'viking://resources/personal/owner/forwards/2026-09-21_150000_fwd.md',
      ].sort(),
      archiveIds: [note.archiveId, web.archiveId, forward.archiveId].sort(),
    });
  } finally {
    archive.close();
  }
});

test('М-05: проекция импортирует документы и картинки форматов OpenViking, пометки и прочее — нет', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-projection-media-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  const bytes = (value: string) => new TextEncoder().encode(value);
  const saved = archive.saveTelegram({
    kind: 'channel', chatId: '-1001', messageId: '1', text: 'с вложениями',
    attachments: [
      { type: 'document', name: 'a.pdf', data: bytes('pdf') },
      { type: 'image', name: 'photo.jpg', data: bytes('jpg') },
      { type: 'document', name: 'setup.exe', data: bytes('exe') },
      { type: 'video', name: 'clip.mp4', data: bytes('mp4') },
      { type: 'image', name: '', state: 'skipped' },
      { type: 'image', name: '', state: 'unavailable' },
    ],
  });
  const files: string[] = [];
  const { service } = makeService({ archive, openViking: {
    async search() { return []; }, async importText() {},
    async importFile(input: any) { files.push(input.uri.split('.').at(-1)); },
  } });
  try {
    assert.equal((await service.callTool('projection_run') as any).data.completed, 1);
    assert.deepEqual(files.sort(), ['jpg', 'mp4', 'pdf']);
    assert.ok(saved.archiveId);
  } finally { archive.close(); }
});
