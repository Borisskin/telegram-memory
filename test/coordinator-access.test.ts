import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { Archive } from '../src/archive.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

// @ts-expect-error the adapter is JavaScript and is exercised through a local MCP server.
import { createOpenVikingClient } from '../src/server/openviking-adapter.mjs';

const now = () => new Date('2026-09-25T12:00:00.000Z');
const secret = 'test-read-token-secret';
const systemToken = 'legacy-system-token';
const userTokens = {
  receiver: 'receiver-access-token',
  mine: 'mine-access-token',
  shared: 'shared-access-token',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: hash(userTokens.receiver) },
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: hash(userTokens.mine) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: hash(userTokens.shared) },
];

async function readRequest(request: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function formatSearch(uris: string[]) {
  if (!uris.length) return 'No matching context found.';
  return `Found ${uris.length} item(s):\n\n${uris.map((uri) => `- [resource 92%] ${uri}\n    indexed summary`).join('\n')}\n\nUse the read tool to expand a URI.`;
}

async function startOpenViking(resources: string[]) {
  const searches: Array<{ target_uri?: string; query?: string }> = [];
  const server = createServer(async (request, response) => {
    try {
      const rpc = JSON.parse(await readRequest(request));
      const name = String(rpc.params?.name ?? '');
      const args = rpc.params?.arguments ?? {};
      let result: unknown;
      if (name === 'search') {
        searches.push(args);
        const matching = resources.filter((uri) => uri.startsWith(String(args.target_uri ?? '')) || String(args.query ?? '').includes('attachment'));
        result = { content: [{ type: 'text', text: formatSearch(matching) }] };
      } else if (name === 'read') {
        result = { content: [{ type: 'text', text: 'read' }] };
      } else {
        result = { isError: true, content: [{ type: 'text', text: `unexpected ${name}` }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'fake OpenViking error');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  return {
    endpoint,
    searches,
    async close() {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function makeFixture(withPrincipals = false) {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-mcp-access-')), ownerId: 'owner', now });
  const channel = archive.saveTelegram({
    kind: 'channel', chatId: '-1001001', messageId: '1', text: 'shared channel content',
    attachments: [{ type: 'document', name: 'brief.pdf', data: new TextEncoder().encode('brief') }],
  });
  const personal = archive.savePersonalTelegram({ text: 'owner-only personal content', operationId: 'personal-1' });
  const channelUri = `viking://resources/${relative(archive.rootDir, channel.path).split(sep).join('/')}`;
  const personalUri = `viking://resources/${relative(archive.rootDir, personal.path).split(sep).join('/')}`;
  const attachment = (archive.read(channel.archiveId).metadata.attachments as Array<{ path: string }>)[0];
  const attachmentUri = `viking://resources/${attachment.path}`;
  const fake = await startOpenViking([channelUri, personalUri, attachmentUri]);
  const openViking = createOpenVikingClient({ endpoint: fake.endpoint, token: 'openviking-test-key', fetch: globalThis.fetch.bind(globalThis) });
  const integrations = new Stage3Service({
    archive,
    openViking,
    ownerId: 'owner',
    tokenSecret: secret,
    now,
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => ({ status: 200, finalUrl: 'https://example.test/', remoteAddress: '93.184.216.34', headers: { 'content-type': 'text/html' }, body: '<article>unused</article>' }),
    sourceExists: async (ref: string) => ref === '-1001001',
    sourceTargetUri: async (ref: string) => `viking://resources/telegram/channels/${ref}/`,
  } as any);
  const telegramCalls: string[] = [];
  const options: any = {
    archive,
    ownerId: 'owner',
    now,
    telegram: { resolveSource: (ref: string) => { telegramCalls.push(ref); return { chatId: '-1002002', title: 'Allowed', kind: 'channel' as const }; } },
    integrations,
  };
  let access: any;
  let coordinator: Coordinator | undefined;
  try {
    if (withPrincipals) {
      const moduleUrl = new URL('../src/access.ts', import.meta.url).href;
      const module = await import(moduleUrl) as { createAccess?: (options: Record<string, unknown>) => any };
      assert.equal(typeof module.createAccess, 'function');
      access = module.createAccess!({ principals, legacyToken: systemToken, ownerId: 'owner', archive });
      options.access = access;
    }
    coordinator = new Coordinator(options);
    const handler = createCoordinatorMcpHandler(coordinator, (withPrincipals ? access : systemToken) as any);
    let requestId = 0;
    const call = async (token: string | undefined, name: string, args: Record<string, unknown>) => handler({
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'tools/call',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      params: { name, arguments: args },
    }) as Promise<any>;

    return {
      archive, channel, personal, channelUri, personalUri, attachmentUri, fake, access, coordinator, handler, call, telegramCalls,
      close() { coordinator!.close(); archive.close(); return fake.close(); },
    };
  } catch (error) {
    coordinator?.close();
    archive.close();
    await fake.close();
    throw error;
  }
}

test('MCP system source search rejects unknown references and maps known references to their URI', async () => {
  const fixture = await makeFixture();
  try {
    const unknownBefore = fixture.fake.searches.length;
    const unknown = await fixture.call(systemToken, 'search', { query: 'content', scope: 'source', source: 'missing', limit: 10 });
    assert.equal(unknown.result.structuredContent.error, 'unknown_source');
    assert.equal(fixture.fake.searches.length, unknownBefore);

    const found = await fixture.call(systemToken, 'search', { query: 'shared', scope: 'source', source: '-1001001', limit: 10 });
    assert.equal(fixture.fake.searches.at(-1)?.target_uri, 'viking://resources/telegram/channels/-1001001/');
    assert.equal(found.result.structuredContent.success, true);
  } finally {
    await fixture.close();
  }
});

test('MCP system search parses OpenViking v0.4.21 formatted text into URI results', async () => {
  const fixture = await makeFixture();
  try {
    const found = await fixture.call(systemToken, 'search', { query: 'shared', scope: 'source', source: '-1001001', limit: 10 });
    assert.equal(fixture.fake.searches.at(-1)?.target_uri, 'viking://resources/telegram/channels/-1001001/');
    assert.deepEqual(found.result.structuredContent.data.results.map((item: any) => item.target_uri), [fixture.channelUri]);
  } finally {
    await fixture.close();
  }
});

test('MCP forbids person search when the principal has no personal area', async () => {
  const fixture = await makeFixture(true);
  try {
    const searchesBefore = fixture.fake.searches.length;
    const archiveBefore = fixture.archive.getState();
    const response = await fixture.call(userTokens.shared, 'knowledge_search', {
      query: 'owner-only personal content', chat_id: 'owner-chat', person_id: 'person-7', limit: 10,
    });
    assert.equal(response.result.structuredContent.success, false);
    assert.equal(response.result.structuredContent.error.code, 'forbidden');
    assert.equal(fixture.fake.searches.length, searchesBefore, 'person_id without personal access must not reach OpenViking');
    assert.deepEqual(fixture.archive.getState(), archiveBefore);
  } finally {
    await fixture.close();
  }
});

test('MCP tools/list exposes only tools allowed to the authenticated principal', async () => {
  const fixture = await makeFixture(true);
  try {
    const list = async (token: string) => fixture.handler({
      jsonrpc: '2.0',
      id: token,
      method: 'tools/list',
      headers: { authorization: `Bearer ${token}` },
    }) as Promise<any>;
    const talker = await list(userTokens.shared);
    assert.deepEqual(talker.result.tools.map((tool: any) => tool.name).sort(), ['chat_joined', 'knowledge_read', 'knowledge_search']);
    assert.deepEqual(talker.result.tools.find((tool: any) => tool.name === 'chat_joined').inputSchema.required, ['chat_id', 'title']);
    const receiver = await list(userTokens.receiver);
    assert.ok(receiver.result.tools.some((tool: any) => tool.name === 'source_add'));
    assert.ok(!receiver.result.tools.some((tool: any) => tool.name === 'knowledge_search'));
    const system = await list(systemToken);
    assert.deepEqual(system.result.tools.map((tool: any) => tool.name).sort(), [
      'collect_cancel', 'collect_pause', 'collect_start', 'collect_status',
      'knowledge_read', 'knowledge_search', 'personal_save', 'search', 'source_add', 'source_settings_set', 'web_save',
    ]);
  } finally {
    await fixture.close();
  }
});

test('MCP authenticates principals, rejects forbidden writes without mutation, and binds read tokens to chat and principal', async () => {
  const fixture = await makeFixture(true);
  try {
    const unauthenticatedBefore = fixture.archive.getState();
    const unauthenticated = await fixture.call(undefined, 'personal_save', { text: 'must not be stored' });
    assert.equal(unauthenticated.error?.message, 'Unauthorized');
    assert.deepEqual(fixture.archive.getState(), unauthenticatedBefore);

    const matrix = [
      { token: userTokens.receiver, allowed: ['inbox_save', 'source_add', 'source_settings_set', 'collect_status', 'collect_pause', 'collect_cancel', 'record_delete', 'chat_access_list', 'chat_access_set', 'settings_set', 'alerts_take'], denied: ['knowledge_search', 'knowledge_read', 'digest', 'digest_commit', 'chat_joined', 'personal_save', 'search'] },
      { token: userTokens.mine, allowed: ['knowledge_search', 'knowledge_read', 'digest', 'digest_commit', 'chat_joined'], denied: ['inbox_save', 'source_add', 'record_delete', 'chat_access_set', 'personal_save', 'search'] },
      { token: userTokens.shared, allowed: ['knowledge_search', 'knowledge_read', 'chat_joined'], denied: ['inbox_save', 'source_add', 'record_delete', 'chat_access_set', 'digest', 'digest_commit', 'personal_save', 'search'] },
    ];
    for (const row of matrix) {
      for (const tool of row.denied) {
        const before = fixture.archive.getState();
        const response = await fixture.call(row.token, tool, {});
        assert.equal(response.result.structuredContent.error.code, 'forbidden', `${tool} must be forbidden`);
        assert.deepEqual(fixture.archive.getState(), before, `${tool} denial must not change state`);
      }
      for (const tool of row.allowed) {
        const response = await fixture.call(row.token, tool, {});
        assert.notEqual(response.result?.structuredContent?.error?.code, 'forbidden', `${tool} must be allowed`);
      }
    }

    const forbiddenBefore = fixture.archive.getState();
    const forbidden = await fixture.call(userTokens.shared, 'personal_save', { text: 'must not be stored' });
    assert.equal(forbidden.result.structuredContent.error.code, 'forbidden');
    assert.deepEqual(fixture.archive.getState(), forbiddenBefore);

    const talker = await fixture.call(userTokens.shared, 'knowledge_search', { query: 'shared', chat_id: '-100group', limit: 10, scope: 'personal' });
    assert.equal(talker.result.structuredContent.success, true);
    assert.equal(fixture.fake.searches.length, 0, 'a group without chat_access must not reach OpenViking');
    assert.deepEqual(talker.result.structuredContent.data.results, []);

    const receiver = await fixture.call(userTokens.receiver, 'chat_access_set', { chat_id: '-100group', access: 'all_shared' });
    assert.equal(receiver.result.structuredContent.success, true);
    const shared = await fixture.call(userTokens.shared, 'knowledge_search', { query: 'shared', chat_id: '-100group', limit: 10, scope: 'personal' });
    const sharedResults = shared.result.structuredContent.data.results;
    assert.ok(sharedResults.some((item: any) => item.target_uri === fixture.channelUri));
    assert.ok(sharedResults.every((item: any) => item.target_uri !== fixture.personalUri));
    assert.ok(fixture.fake.searches.every((item: { target_uri?: string }) => !String(item.target_uri).includes('/personal/')));

    const mineOutsideOwner = await fixture.call(userTokens.mine, 'knowledge_search', { query: 'shared', chat_id: '-100group', limit: 10 });
    assert.deepEqual(mineOutsideOwner.result.structuredContent.data.results, []);

    const token = sharedResults[0].read_token;
    const read = await fixture.call(userTokens.shared, 'knowledge_read', { read_token: token, chat_id: '-100group' });
    assert.equal(read.result.structuredContent.success, true);
    const repeatedRead = await fixture.call(userTokens.shared, 'knowledge_read', { read_token: token, chat_id: '-100group' });
    assert.equal(repeatedRead.result.structuredContent.success, true, 'a short-lived token remains usable in its original principal and chat');
    const stateBeforeDenials = fixture.archive.getState();
    const otherChat = await fixture.call(userTokens.shared, 'knowledge_read', { read_token: token, chat_id: '-100other' });
    assert.equal(otherChat.result.structuredContent.success, false);
    const otherPrincipal = await fixture.call(userTokens.mine, 'knowledge_read', { read_token: token, chat_id: '-100group' });
    assert.equal(otherPrincipal.result.structuredContent.success, false);
    assert.deepEqual(fixture.archive.getState(), stateBeforeDenials);
  } finally {
    await fixture.close();
  }
});

test('MCP denies an attachment after its parent is deleted and does not mutate state on denial', async () => {
  const fixture = await makeFixture(true);
  try {
    await fixture.call(userTokens.receiver, 'chat_access_set', { chat_id: '-100group', access: 'all_shared' });
    const found = await fixture.call(userTokens.shared, 'knowledge_search', { query: 'attachment', chat_id: '-100group', limit: 10 });
    const result = found.result.structuredContent.data.results.find((item: any) => item.target_uri === fixture.attachmentUri);
    assert.ok(result?.read_token);

    fixture.archive.markTelegramDeleted({ kind: 'channel', chatId: '-1001001', messageId: '1', evidence: 'confirmed' });
    const before = fixture.archive.getState();
    const denied = await fixture.call(userTokens.shared, 'knowledge_read', { read_token: result.read_token, chat_id: '-100group' });
    assert.equal(denied.result.structuredContent.success, false);
    assert.deepEqual(fixture.archive.getState(), before);
  } finally {
    await fixture.close();
  }
});

test('MCP binds an attachment read token to the same live parent record', async () => {
  const fixture = await makeFixture(true);
  try {
    const liveParent = fixture.archive.saveTelegram({
      kind: 'channel', chatId: '-1001001', messageId: '2', text: 'live duplicate parent',
      attachments: [{ type: 'document', name: 'brief-copy.pdf', data: new TextEncoder().encode('brief') }],
    });
    fixture.archive.markTelegramDeleted({ kind: 'channel', chatId: '-1001001', messageId: '1', evidence: 'confirmed' });
    await fixture.call(userTokens.receiver, 'chat_access_set', { chat_id: '-100group', access: 'all_shared' });
    const found = await fixture.call(userTokens.shared, 'knowledge_search', { query: 'attachment', chat_id: '-100group', limit: 10 });
    const result = found.result.structuredContent.data.results.find((item: any) => item.target_uri === fixture.attachmentUri);
    assert.ok(result?.read_token);

    const read = await fixture.call(userTokens.shared, 'knowledge_read', { read_token: result.read_token, chat_id: '-100group' });
    assert.equal(read.result.structuredContent.success, true);
    assert.equal(read.result.structuredContent.data.archive_id, liveParent.archiveId);
    assert.match(read.result.structuredContent.data.content, /live duplicate parent/);
  } finally {
    await fixture.close();
  }
});
