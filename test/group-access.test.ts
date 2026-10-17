import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { createAccess } from '../src/access.ts';
import { Archive } from '../src/archive.ts';
import { Coordinator, createCoordinatorMcpHandler } from '../src/coordinator.ts';
import { Stage3Service } from '../src/integrations.ts';

const tokens = { receiver: 'group-receiver-token', talker: 'group-talker-token', system: 'group-system-token' };
const refs = { channel: 'https://t.me/group_access_channel', group: 'https://t.me/group_access_group' };
const principals = [
  { name: 'receiver', role: 'receiver', areas: ['shared', 'personal'], ownerOnly: false, digest: false, token_sha256: createHash('sha256').update(tokens.receiver).digest('hex') },
  { name: 'talker', role: 'talker', areas: ['shared'], ownerOnly: false, digest: false, token_sha256: createHash('sha256').update(tokens.talker).digest('hex') },
];
const now = () => new Date('2026-09-25T12:00:00.000Z');

function fixture(root = mkdtempSync(join(tmpdir(), 'telegram-memory-group-access-'))) {
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now });
  const uri = (path: string) => `viking://resources/${relative(root, path).split(sep).join('/')}`;
  const channel = archive.saveTelegram({ kind: 'channel', chatId: '-10011', messageId: '1', text: 'channel evidence' });
  const group = archive.saveTelegram({ kind: 'group', chatId: '-10022', messageId: '1', text: 'group evidence' });
  const personal = archive.savePersonalTelegram({ text: 'private evidence', operationId: 'group-access-personal' });
  const resources = [uri(channel.path), uri(group.path), uri(personal.path)];
  const searches: string[] = [];
  const openViking = {
    async search(input: { target_uri: string }) {
      searches.push(input.target_uri);
      return resources.filter((target_uri) => target_uri.startsWith(input.target_uri)).map((target_uri) => ({ target_uri }));
    },
  };
  let coordinator: Coordinator;
  const access = createAccess({
    principals, legacyToken: tokens.system, ownerId: 'owner', archive,
    sourceTargetUri: (ref: string) => coordinator.sourceTargetUri(ref),
  });
  const integrations = new Stage3Service({
    archive, openViking, ownerId: 'owner', tokenSecret: 'group-read-secret', now,
    resolveHost: async () => ['93.184.216.34'],
    fetchPage: async () => { throw new Error('web fetch is outside this test'); },
    sourceExists: (ref: string) => coordinator.sourceExists(ref),
    sourceTargetUri: (ref: string) => coordinator.sourceTargetUri(ref),
  } as any);
  coordinator = new Coordinator({
    archive, ownerId: 'owner', now, access, integrations,
    telegram: { resolveSource: (ref: string) => {
      if (ref === refs.channel) return { chatId: '-10011', title: 'Channel', kind: 'channel' as const };
      if (ref === refs.group) return { chatId: '-10022', title: 'Group', kind: 'group' as const };
      throw new Error('unknown Telegram source');
    } },
  });
  const handler = createCoordinatorMcpHandler(coordinator, access);
  let requestId = 0;
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({
      jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
      headers: { authorization: `Bearer ${token}` }, params: { name, arguments: args },
    }) as any;
    return response.result.structuredContent;
  };
  return {
    root, archive, coordinator, handler, call, searches,
    uris: { channel: resources[0], group: resources[1], personal: resources[2] },
    close() { coordinator.close(); archive.close(); },
  };
}

test('Б-05: receiver group grants persist and talker cannot read or change them', async () => {
  const first = fixture();
  const chat = '-100talker';
  try {
    assert.deepEqual((await first.call(tokens.receiver, 'chat_access_list')).data, []);
    const added = await first.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' });
    assert.equal(added.success, true);
    const set = await first.call(tokens.receiver, 'chat_access_set', { chat_id: chat, access: ['-10011'] });
    assert.equal(set.success, true);
    assert.deepEqual((await first.call(tokens.receiver, 'chat_access_list', { chat_id: chat })).data, [{ chat_id: chat, access: ['-10011'] }]);

    for (const name of ['chat_access_set', 'chat_access_list']) {
      const denied = await first.call(tokens.talker, name, { chat_id: chat, access: 'all_shared' });
      assert.equal(denied.error?.code, 'forbidden');
    }
    assert.deepEqual((await first.call(tokens.receiver, 'chat_access_list', { chat_id: chat })).data, [{ chat_id: chat, access: ['-10011'] }]);
  } finally {
    first.close();
  }

  const reopened = fixture(first.root);
  try {
    assert.deepEqual((await reopened.call(tokens.receiver, 'chat_access_list', { chat_id: chat })).data, [{ chat_id: chat, access: ['-10011'] }]);
    assert.equal((await reopened.call(tokens.receiver, 'chat_access_set', { chat_id: chat, access: 'none' })).success, true);
    assert.deepEqual((await reopened.call(tokens.receiver, 'chat_access_list', { chat_id: chat })).data, [{ chat_id: chat, access: 'none' }]);
  } finally {
    reopened.close();
  }
});

test('Б-05: unknown source in a grant is rejected without changing the previous grant', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).success, true);
    assert.equal((await f.call(tokens.receiver, 'chat_access_set', { chat_id: '-100talker', access: ['-10011'] })).success, true);
    const before = f.archive.getState();
    const unknown = await f.call(tokens.receiver, 'chat_access_set', { chat_id: '-100talker', access: ['-10011', '-100missing'] });
    assert.equal(unknown.success, false, 'an unconnected source must be rejected');
    assert.deepEqual((await f.call(tokens.receiver, 'chat_access_list', { chat_id: '-100talker' })).data, [{ chat_id: '-100talker', access: ['-10011'] }]);
    assert.deepEqual(f.archive.getState(), before);
  } finally {
    f.close();
  }
});

test('Б-05: talker searches only the sources granted to its group, never personal memory', async () => {
  const f = fixture();
  const search = (chat_id: string) => f.call(tokens.talker, 'knowledge_search', { query: 'evidence', chat_id, limit: 20 });
  const targets = async (chat_id: string) => (await search(chat_id)).data.results.map((item: any) => item.target_uri).sort();
  try {
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).success, true);
    assert.equal((await f.call(tokens.receiver, 'source_add', { ref: refs.group, mode: 'full' })).success, true);
    assert.deepEqual(await targets('-100talker'), []);
    assert.deepEqual(f.searches, [], 'a closed group must not call OpenViking');

    assert.equal((await f.call(tokens.receiver, 'chat_access_set', { chat_id: '-100talker', access: ['-10011'] })).success, true);
    assert.deepEqual(await targets('-100talker'), [f.uris.channel]);
    assert.deepEqual(await targets('-100other'), [], 'access belongs to one chat only');

    assert.equal((await f.call(tokens.receiver, 'chat_access_set', { chat_id: '-100talker', access: 'all_shared' })).success, true);
    assert.deepEqual(await targets('-100talker'), [f.uris.channel, f.uris.group].sort());
    assert.ok((f.searches as string[]).every((target: string) => !target.includes('/personal/')));
  } finally {
    f.close();
  }
});

test('Б-05: changing a group to none revokes search and a previously issued read token after restart', async () => {
  const first = fixture();
  const chat_id = '-100revoked';
  const search = (f: ReturnType<typeof fixture>) => f.call(tokens.talker, 'knowledge_search', { query: 'evidence', chat_id, limit: 20 });
  try {
    assert.equal((await first.call(tokens.receiver, 'source_add', { ref: refs.channel, mode: 'full' })).success, true);
    assert.equal((await first.call(tokens.receiver, 'chat_access_set', { chat_id, access: ['-10011'] })).success, true);
    const granted = await search(first);
    const readToken = granted.data.results.find((item: any) => item.target_uri === first.uris.channel)?.read_token;
    assert.ok(readToken);

    assert.equal((await first.call(tokens.receiver, 'chat_access_set', { chat_id, access: 'none' })).success, true);
    const searchCount = first.searches.length;
    assert.deepEqual((await search(first)).data.results, []);
    assert.equal(first.searches.length, searchCount, 'none must stop the search before OpenViking');
    const before = first.archive.getState();
    assert.equal((await first.call(tokens.talker, 'knowledge_read', { read_token: readToken, chat_id })).success, false);
    assert.deepEqual(first.archive.getState(), before);
  } finally {
    first.close();
  }
  const reopened = fixture(first.root);
  try {
    assert.deepEqual((await search(reopened)).data.results, []);
    assert.deepEqual(reopened.searches, []);
    assert.deepEqual((await reopened.call(tokens.receiver, 'chat_access_list', { chat_id })).data, [{ chat_id, access: 'none' }]);
  } finally {
    reopened.close();
  }
});

test('Б-15: chat_joined creates one owner alert with the chat ID and title', async () => {
  const f = fixture();
  try {
    const args = { chat_id: '-100new', title: 'Новая группа' };
    assert.equal((await f.call(tokens.talker, 'chat_joined', args)).success, true);
    assert.equal((await f.call(tokens.talker, 'chat_joined', args)).success, true);
    const taken = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(taken.success, true);
    const alerts = Array.isArray(taken.data) ? taken.data : taken.data?.alerts;
    assert.ok(Array.isArray(alerts));
    assert.equal(alerts.length, 1, 'repeat delivery must not create another alert');
    assert.match(JSON.stringify(alerts[0]), /-100new/);
    assert.match(JSON.stringify(alerts[0]), /Новая группа/);
    assert.deepEqual((await f.call(tokens.receiver, 'chat_access_list', { chat_id: '-100new' })).data, [], 'join must leave group access closed');
  } finally {
    f.close();
  }
});

test('Б-15: alerts_take returns an empty batch when nothing is pending', async () => {
  const f = fixture();
  try {
    const taken = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(taken.success, true);
    assert.deepEqual(Array.isArray(taken.data) ? taken.data : taken.data?.alerts, []);
  } finally {
    f.close();
  }
});

test('Б-15: forbidden and unauthenticated alert calls leave the pending alert untouched', async () => {
  const f = fixture();
  try {
    const args = { chat_id: '-100private-alert', title: 'Закрытая группа' };
    const second = { chat_id: '-100second-alert', title: 'Вторая группа' };
    assert.equal((await f.call(tokens.receiver, 'chat_joined', args)).error?.code, 'forbidden');
    assert.equal((await f.call(tokens.talker, 'chat_joined', { chat_id: args.chat_id, title: ' ' })).error?.code, 'invalid_argument');
    assert.equal((await f.call(tokens.talker, 'chat_joined', args)).success, true);
    assert.equal((await f.call(tokens.talker, 'chat_joined', second)).success, true);
    assert.equal((await f.call(tokens.talker, 'alerts_take')).error?.code, 'forbidden');
    const unknown = await f.handler({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      headers: { authorization: 'Bearer unknown-token' },
      params: { name: 'alerts_take', arguments: {} },
    }) as any;
    assert.equal(unknown.error?.message, 'Unauthorized');
    const taken = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(taken.success, true);
    assert.equal(taken.data.length, 2);
    assert.deepEqual(taken.data.map((alert: any) => [alert.chat_id, alert.title]).sort(), [
      [args.chat_id, args.title], [second.chat_id, second.title],
    ].sort());
    assert.equal((await f.call(tokens.talker, 'alerts_ack', { chat_id: args.chat_id, delivery_id: taken.data[0].delivery_id })).error?.code, 'forbidden');
    for (const alert of taken.data) assert.equal((await f.call(tokens.receiver, 'alerts_ack', { chat_id: alert.chat_id, delivery_id: alert.delivery_id })).data.acknowledged, true);
    assert.deepEqual((await f.call(tokens.receiver, 'alerts_take')).data, []);
  } finally {
    f.close();
  }
});

test('Б-15: joining again after an alert is acknowledged creates a new alert', async () => {
  const f = fixture();
  try {
    const args = { chat_id: '-100again', title: 'Группа снова' };
    assert.equal((await f.call(tokens.talker, 'chat_joined', args)).success, true);
    const first = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(first.data.length, 1);
    assert.equal((await f.call(tokens.receiver, 'alerts_ack', { chat_id: args.chat_id, delivery_id: first.data[0].delivery_id })).data.acknowledged, true);
    assert.equal((await f.call(tokens.talker, 'chat_joined', args)).success, true);
    const second = await f.call(tokens.receiver, 'alerts_take');
    assert.equal(second.data.length, 1);
    assert.equal(second.data[0].chat_id, args.chat_id);
    assert.equal(second.data[0].title, args.title);
    assert.notEqual(second.data[0].delivery_id, first.data[0].delivery_id);
    assert.equal((await f.call(tokens.receiver, 'alerts_ack', { chat_id: args.chat_id, delivery_id: first.data[0].delivery_id })).data.acknowledged, false);
    assert.equal((await f.call(tokens.receiver, 'alerts_ack', { chat_id: args.chat_id, delivery_id: second.data[0].delivery_id })).data.acknowledged, true);
    assert.deepEqual((await f.call(tokens.receiver, 'alerts_take')).data, []);
  } finally {
    f.close();
  }
});

test('Б-15: pending alerts survive restart and remain pending until acknowledged', async () => {
  const first = fixture();
  try {
    assert.equal((await first.call(tokens.talker, 'chat_joined', { chat_id: '-100restart', title: 'После запуска' })).success, true);
  } finally {
    first.close();
  }
  const reopened = fixture(first.root);
  try {
    assert.equal((await reopened.call(tokens.talker, 'chat_joined', { chat_id: '-100restart', title: 'После запуска' })).success, true);
    const firstTake = await reopened.call(tokens.receiver, 'alerts_take');
    assert.equal(firstTake.success, true);
    const alerts = Array.isArray(firstTake.data) ? firstTake.data : firstTake.data?.alerts;
    assert.ok(Array.isArray(alerts));
    assert.equal(alerts.length, 1);
    assert.match(JSON.stringify(alerts[0]), /-100restart/);
    const secondTake = await reopened.call(tokens.receiver, 'alerts_take');
    assert.equal(secondTake.success, true);
    assert.deepEqual(secondTake.data, firstTake.data);
    assert.equal((await reopened.call(tokens.receiver, 'alerts_ack', { chat_id: alerts[0].chat_id, delivery_id: alerts[0].delivery_id })).data.acknowledged, true);
    const confirmed = await reopened.call(tokens.receiver, 'alerts_take');
    assert.equal(confirmed.success, true);
    assert.deepEqual(Array.isArray(confirmed.data) ? confirmed.data : confirmed.data?.alerts, []);
  } finally {
    reopened.close();
  }
});
