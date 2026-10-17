import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Archive } from '../src/archive.ts';

const tokens = {
  receiver: 'receiver-principal-secret',
  mine: 'mine-principal-secret',
  shared: 'shared-principal-secret',
  personal: 'personal-principal-secret',
  system: 'legacy-system-secret',
};

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: tokenHash(tokens.receiver) },
  { name: 'mine', role: 'talker', areas: ['shared', 'personal'], ownerOnly: true, digest: true, token_sha256: tokenHash(tokens.mine) },
  { name: 'shared', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: tokenHash(tokens.shared) },
  { name: 'personal', role: 'talker', areas: ['personal'], ownerOnly: true, digest: false, token_sha256: tokenHash(tokens.personal) },
];

async function createAccess(options: Record<string, unknown> = {}) {
  const moduleUrl = new URL('../src/access.ts', import.meta.url).href;
  const module = await import(moduleUrl) as { createAccess?: (options: Record<string, unknown>) => any };
  assert.equal(typeof module.createAccess, 'function', 'src/access.ts exports createAccess');
  return module.createAccess!({ principals, legacyToken: tokens.system, ownerId: 'owner', ...options });
}

function assertAccessError(callback: () => unknown, code: string) {
  assert.throws(callback, (error: any) => error?.code === code);
}

test('access validates principals and authenticates only their SHA-256 token digests', async () => {
  const access = await createAccess();
  assert.equal(access.authenticate(tokens.receiver).name, 'receiver');
  assert.equal(access.authenticate(tokens.mine).name, 'mine');
  assert.equal(access.authenticate(tokens.system).name, 'system');
  assertAccessError(() => access.authenticate('unknown-token'), 'unauthorized');
  assertAccessError(() => access.authenticate(''), 'unauthorized');

  const moduleUrl = new URL('../src/access.ts', import.meta.url).href;
  const module = await import(moduleUrl) as { createAccess?: (options: Record<string, unknown>) => unknown };
  assert.throws(() => module.createAccess!({
    principals: [{ name: 'broken', role: 'admin', areas: [], ownerOnly: false, digest: false, token_sha256: 'not-a-digest' }],
    legacyToken: tokens.system,
    ownerId: 'owner',
  }), /principal|role|token|digest/i);
});

test('access rejects an empty principal list and duplicate token digests', async () => {
  const moduleUrl = new URL('../src/access.ts', import.meta.url).href;
  const module = await import(moduleUrl) as { createAccess?: (options: Record<string, unknown>) => unknown };
  assert.throws(() => module.createAccess!({ principals: [], legacyToken: tokens.system, ownerId: 'owner' }), /principal list/i);
  assert.throws(() => module.createAccess!({
    principals: [principals[0], { ...principals[1], token_sha256: principals[0].token_sha256 }],
    legacyToken: tokens.system,
    ownerId: 'owner',
  }), /digest is duplicated/i);
});

test('access requires talkers with personal access to be owner-only', async () => {
  const moduleUrl = new URL('../src/access.ts', import.meta.url).href;
  const module = await import(moduleUrl) as { createAccess?: (options: Record<string, unknown>) => unknown };
  assert.throws(() => module.createAccess!({
    principals: [{ name: 'personal', role: 'talker', areas: ['personal'], ownerOnly: false, digest: false, token_sha256: tokenHash('personal-token') }],
    legacyToken: tokens.system,
    ownerId: 'owner',
  }), /personal.*owner-only|owner-only.*personal/i);
});

test('access rejects bearer tokens containing whitespace even when configured by digest', async () => {
  const malformedToken = 'token with spaces';
  const access = await createAccess({
    principals: [{ name: 'spaced', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: tokenHash(malformedToken) }],
  });
  assertAccessError(() => access.authenticate(malformedToken), 'unauthorized');
});

test('access hard-codes the receiver, talker, digest, and legacy system tool matrix', async () => {
  const access = await createAccess();
  const allTools = [
    'inbox_save', 'source_add', 'collect_start', 'collect_status', 'collect_pause', 'collect_cancel', 'record_delete',
    'chat_access_list', 'chat_access_set', 'settings_set', 'alerts_take',
    'knowledge_search', 'knowledge_read', 'digest', 'digest_commit', 'chat_joined',
    'web_save', 'personal_save', 'search',
  ];
  const allowed: Record<string, string[]> = {
    receiver: ['inbox_save', 'source_add', 'collect_status', 'collect_pause', 'collect_cancel', 'record_delete', 'chat_access_list', 'chat_access_set', 'settings_set', 'alerts_take'],
    mine: ['knowledge_search', 'knowledge_read', 'digest', 'digest_commit', 'chat_joined'],
    shared: ['knowledge_search', 'knowledge_read', 'chat_joined'],
    personal: ['knowledge_search', 'knowledge_read', 'chat_joined'],
  };

  for (const [name, token] of Object.entries(tokens)) {
    const principal = access.authenticate(token);
    for (const tool of allTools) {
      const expected = name === 'system'
        ? ['web_save', 'personal_save', 'search', 'knowledge_search', 'knowledge_read', 'source_add', 'collect_start', 'collect_status', 'collect_pause', 'collect_cancel'].includes(tool)
        : allowed[name].includes(tool);
      if (expected) assert.doesNotThrow(() => access.authorize(principal, tool), `${name} may call ${tool}`);
      else assertAccessError(() => access.authorize(principal, tool), 'forbidden');
    }
  }
});

test('search targets follow principal areas, owner-only chat, person scope, and default-closed group access', async () => {
  const access = await createAccess({
    sourceTargetUri: (ref: string) => `viking://resources/telegram/channels/${ref}/`,
  });
  const mine = access.authenticate(tokens.mine);
  const shared = access.authenticate(tokens.shared);
  const personal = access.authenticate(tokens.personal);

  assert.deepEqual(access.searchTargets(mine, { chatId: '-100group' }), []);
  assert.ok(access.searchTargets(mine, { chatId: 'owner' }).includes('viking://resources/personal/owner/'));
  assert.deepEqual(access.searchTargets(shared, { chatId: '-100group' }), []);
  assertAccessError(() => access.searchTargets(shared, { chatId: '-100group', personId: 'person-7' }), 'forbidden');
  assert.deepEqual(access.searchTargets(personal, { chatId: 'owner', personId: 'person-7' }), [
    'viking://resources/personal/owner/people/person-7/',
    'viking://resources/personal/owner/forwards/',
  ]);

  access.setChatAccess('-100group', 'all_shared');
  assert.deepEqual(access.searchTargets(shared, { chatId: '-100group' }), [
    'viking://resources/telegram/channels/',
    'viking://resources/telegram/groups/',
  ]);
  access.setChatAccess('-100group', ['-100123']);
  assert.deepEqual(access.searchTargets(shared, { chatId: '-100group' }), [
    'viking://resources/telegram/channels/-100123/',
  ]);
  access.setChatAccess('-100group', 'none');
  assert.deepEqual(access.searchTargets(shared, { chatId: '-100group' }), []);
});

test('person_id is denied when the principal has no personal area', async () => {
  const access = await createAccess();
  const shared = access.authenticate(tokens.shared);
  assertAccessError(() => access.searchTargets(shared, { chatId: 'owner-chat', personId: 'person-7' }), 'forbidden');
});

test('attachments are readable only through a live accessible parent; bare attachment URIs are system-only', async () => {
  const archive = new Archive({ rootDir: mkdtempSync(join(tmpdir(), 'telegram-memory-access-')), ownerId: 'owner' });
  try {
    const saved = archive.saveTelegram({
      kind: 'channel', chatId: '-100123', messageId: '9', text: 'parent record',
      attachments: [{ type: 'document', name: 'report.pdf', data: new TextEncoder().encode('pdf bytes') }],
    });
    const attachment = (archive.read(saved.archiveId).metadata.attachments as Array<{ path: string }>)[0];
    const attachmentUri = `viking://resources/${attachment.path}`;
    const access = await createAccess({ archive });
    const shared = access.authenticate(tokens.shared);
    const system = access.authenticate(tokens.system);
    access.setChatAccess('-100talker', 'all_shared');

    assert.equal(access.canRead(shared, attachmentUri, { chatId: '-100talker' }), true);
    assert.equal(access.canRead(shared, attachmentUri, { chatId: '-100closed' }), false);
    assert.equal(access.canRead(shared, 'viking://resources/attachments/', { chatId: '-100talker' }), false);
    assert.equal(access.canRead(system, 'viking://resources/attachments/', { chatId: '-100talker' }), true);

    archive.markTelegramDeleted({ kind: 'channel', chatId: '-100123', messageId: '9', evidence: 'confirmed' });
    assert.equal(access.canRead(shared, attachmentUri, { chatId: '-100talker' }), false);
  } finally {
    archive.close();
  }
});
