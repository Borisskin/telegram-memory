import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Archive,
  Coordinator,
  Stage3Service,
  createCoordinatorMcpHandler,
  makeReadToken,
} from '../src/index.ts';
import { clipHtml } from '../src/clipper.ts';

const fixedNow = () => new Date('2026-09-21T12:00:00.000Z');
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test('Clipper fails closed when its official runtime is unavailable', async () => {
  await assert.rejects(() => clipHtml('<article>fixture</article>', 'https://example.test/'));
});

function stage3(overrides: Record<string, unknown> = {}) {
  const archive = {
    saveWeb: (input: unknown) => ({ archiveId: 'personal_web:owner:fixture', path: 'fixture.md', revision: 1, contentHash: 'hash', created: true, input }),
    getState: () => ({ outbox: [] }),
  };
  const calls: Array<{ url: string; options: any }> = [];
  const service = new Stage3Service({
    archive,
    openViking: { search: async () => [] },
    tokenSecret: 'secret',
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async (url: string, options: any) => {
      calls.push({ url, options });
      return { status: 200, finalUrl: url, remoteAddress: options.address, headers: { 'content-type': 'text/html' }, body: '<article>ok</article>' };
    },
    now: fixedNow,
    ...overrides,
  } as any);
  return { service, calls };
}

test('MCP handler requires a secret and rejects a forged bearer token', async () => {
  const archive = new Archive({ rootDir: temp('telegram-memory-secret-'), ownerId: 'owner', now: fixedNow });
  const coordinator = new Coordinator({ archive, telegram: { resolveSource: () => ({ chatId: '-100', kind: 'channel' }) } });
  try {
    assert.throws(() => createCoordinatorMcpHandler(coordinator), /secret is required/);
    assert.throws(() => createCoordinatorMcpHandler(coordinator, ''), /secret is required/);
    const handler = createCoordinatorMcpHandler(coordinator, 'secret');
    const denied = await handler({ id: 1, method: 'initialize', headers: { authorization: 'Bearer forged' } }) as any;
    assert.equal(denied.error.code, -32001);
    const accepted = await handler({ id: 2, method: 'initialize', headers: { authorization: 'Bearer secret' } }) as any;
    assert.equal(accepted.result.serverInfo.name, 'telegram-memory-coordinator');
  } finally {
    coordinator.close();
  }
});

test('web redirects reject private/link-local targets before a second request and enforce the redirect limit', async () => {
  const privateRedirect = stage3({
    fetchPage: async (url: string, options: any) => ({ status: 302, headers: { location: 'http://127.0.0.1/private' }, remoteAddress: options.address, finalUrl: url, body: '' }),
  });
  assert.equal((await privateRedirect.service.callTool('web_save', { url: 'https://public.test/start' }) as any).error, 'unsafe_url');
  assert.equal(privateRedirect.calls.length, 0);

  const dnsRedirect = stage3({
    resolveHost: async (host: string) => host === 'private.test' ? ['169.254.1.1'] : ['93.184.216.34'],
    fetchPage: async (url: string, options: any) => ({ status: 302, headers: { location: 'https://private.test/inside' }, remoteAddress: options.address, finalUrl: url, body: '' }),
  });
  assert.equal((await dnsRedirect.service.callTool('web_save', { url: 'https://public.test/start' }) as any).error, 'unsafe_url');
  assert.equal(dnsRedirect.calls.length, 0);

  let requests = 0;
  const limited = stage3({
    fetchPage: async (url: string, options: any) => {
      requests += 1;
      const n = Number(new URL(url).pathname.slice(1));
      return n < 6
        ? { status: 302, headers: { location: `https://public.test/${n + 1}` }, remoteAddress: options.address, finalUrl: url, body: '' }
        : { status: 200, headers: { 'content-type': 'text/html' }, remoteAddress: options.address, finalUrl: url, body: '<article>done</article>' };
    },
  });
  assert.equal((await limited.service.callTool('web_save', { url: 'https://public.test/0' }) as any).error, 'unsafe_url');
  assert.equal(requests, 6);
});

test('knowledge search carries scope/target_uri/read_token and read reports a stale revision', async () => {
  const root = temp('telegram-memory-knowledge-');
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: fixedNow });
  const saved = archive.saveTelegram({ kind: 'channel', chatId: '-100', messageId: '1', text: 'A' });
  const searches: any[] = [];
  const service = new Stage3Service({
    archive,
    openViking: {
      async search(input: any) { searches.push(input); return [{ archive_id: saved.archiveId, revision: 1 }]; },
    },
    tokenSecret: 'secret',
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => ({}),
    now: fixedNow,
  } as any);
  try {
    const result = await service.callTool('knowledge_search', { query: 'A', scope: 'all', limit: 5 }) as any;
    assert.equal(result.success, true);
    assert.equal(result.data.results.length, 3);
    assert.deepEqual(searches.map((item) => item.target_uri), [
      'viking://resources/telegram/channels/',
      'viking://resources/telegram/groups/',
      'viking://resources/personal/owner/',
    ]);
    const hit = result.data.results[0];
    assert.equal(hit.scope, 'all');
    assert.equal(typeof hit.read_token, 'string');
    const payload = JSON.parse(Buffer.from(hit.read_token.split('.')[0], 'base64url').toString());
    assert.equal(payload.targetUri, hit.target_uri);
    assert.equal(payload.scope, 'all');
    assert.equal(payload.revision, 1);

    archive.saveTelegram({ kind: 'channel', chatId: '-100', messageId: '1', text: 'B' });
    const read = await service.callTool('knowledge_read', { read_token: hit.read_token }) as any;
    assert.equal(read.success, true);
    assert.equal(read.data.revision, 2);
    assert.equal(read.data.stale, true);
  } finally {
    archive.close();
  }
});

test('A-B-A projection does not publish stale outbox revisions', async () => {
  const archive = new Archive({ rootDir: temp('telegram-memory-projection-'), ownerId: 'owner', now: fixedNow });
  const imported: any[] = [];
  const service = new Stage3Service({
    archive,
    openViking: { importText: async (input: any) => { imported.push(input); } },
    tokenSecret: 'secret',
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => ({}),
  } as any);
  try {
    archive.saveTelegram({ kind: 'channel', chatId: '-100', messageId: '2', text: 'A' });
    archive.saveTelegram({ kind: 'channel', chatId: '-100', messageId: '2', text: 'B' });
    archive.saveTelegram({ kind: 'channel', chatId: '-100', messageId: '2', text: 'A' });
    const projection = await service.callTool('projection_run') as any;
    assert.equal(projection.success, true);
    assert.deepEqual(imported.map((input) => input.revision), [3]);
    assert.deepEqual(archive.getState().outbox.map((row) => [row.revision, row.status]), [
      [1, 'superseded'], [2, 'superseded'], [3, 'completed'],
    ]);
  } finally {
    archive.close();
  }
});
