import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Archive } from '../src/archive.ts';

function temporaryArchive(): { root: string; archive: Archive } {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  return { root, archive: new Archive({ rootDir: root, ownerId: 'owner' }) };
}

const fixedNow = () => new Date('2026-09-21T10:00:00.000Z');

test('П-05: telegram records use stable source and message paths', () => {
  const { root, archive } = temporaryArchive();
  try {
    const first = archive.saveTelegram({
      kind: 'channel',
      chatId: '-1001234567890123',
      messageId: '7',
      sourceName: 'Old title',
      text: 'first',
    });
    assert.equal(first.path, join(root, 'telegram', 'channels', '-1001234567890123', '7.md'));
    assert.equal(readFileSync(first.path, 'utf8').startsWith('---\nschema_version: 1\n'), true);

    const second = archive.saveTelegram({
      kind: 'channel',
      chatId: '-1001234567890123',
      messageId: '8',
      sourceName: 'Renamed title',
      text: 'second',
    });
    assert.equal(second.path, join(root, 'telegram', 'channels', '-1001234567890123', '8.md'));

    const differentSource = archive.saveTelegram({
      kind: 'group',
      chatId: '-1001234567890124',
      messageId: '7',
      text: 'third',
    });
    assert.equal(differentSource.path, join(root, 'telegram', 'groups', '-1001234567890124', '7.md'));
  } finally {
    archive.close();
  }
});

test('П-06: personal names are Moscow-time stable and exhaust at 100', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: fixedNow });
  try {
    const notes = join(root, 'personal', 'owner', 'notes');
    const results = Array.from({ length: 100 }, (_, index) => archive.savePersonalTelegram({ text: 'same', operationId: `op-${index}` }));
    assert.equal(results[0].path, join(notes, '2026-09-21_130000_tg.md'));
    assert.equal(results[99].path, join(notes, '2026-09-21_130000_tg_99.md'));
    assert.throws(() => archive.savePersonalTelegram({ text: 'same', operationId: 'op-100' }), /name_exhausted/);
    assert.equal(readdirSync(notes).filter((name) => name.endsWith('.md')).length, 100);

    const web = archive.saveWeb({ requestedUrl: 'https://www.example.co.uk/one', text: 'article', operationId: 'web-1' });
    assert.equal(web.path, join(notes, '2026-09-21_130000_web.md'));
    const idn = archive.saveWeb({ requestedUrl: 'https://www.пример.рф/one', text: 'idn', operationId: 'web-2' });
    assert.equal(idn.path, join(notes, '2026-09-21_130000_web_01.md'));
  } finally {
    archive.close();
  }
});

test('П-07: personal operation retry is idempotent and independent equal texts get new names', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  const first = new Archive({ rootDir: root, ownerId: 'owner', now: fixedNow });
  const expectedPath = join(root, 'personal', 'owner', 'notes', '2026-09-21_130000_tg.md');
  const accepted = first.savePersonalTelegram({ text: 'hello', operationId: 'accepted' });
  const duplicate = first.savePersonalTelegram({ text: 'hello', operationId: 'accepted' });
  const second = first.savePersonalTelegram({ text: 'hello', operationId: 'independent' });
  assert.equal(accepted.path, expectedPath);
  assert.equal(duplicate.path, accepted.path);
  assert.equal(second.path, join(root, 'personal', 'owner', 'notes', '2026-09-21_130000_tg_01.md'));
  first.close();

  const afterRestart = new Archive({ rootDir: root, ownerId: 'owner', now: () => new Date('2026-09-21T10:01:00.000Z') });
  try {
    const retried = afterRestart.savePersonalTelegram({ text: 'hello', operationId: 'accepted' });
    assert.equal(retried.path, expectedPath);
    assert.equal(retried.revision, 1);
    assert.equal(afterRestart.getState().operations.filter((row) => row.operation_id === 'accepted').length, 1);
  } finally {
    afterRestart.close();
  }
});

test('П-08: unchanged observations do not revise, while A-B-A does', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  let now = new Date('2026-09-21T10:00:00.000Z');
  const archive = new Archive({ rootDir: root, ownerId: 'owner', now: () => now });
  try {
    const a1 = archive.saveTelegram({ kind: 'channel', chatId: '-1001', messageId: '5', text: 'A' });
    now = new Date('2026-09-21T10:00:05.000Z');
    const unchanged = archive.saveTelegram({ kind: 'channel', chatId: '-1001', messageId: '5', text: 'A' });
    const b = archive.saveTelegram({ kind: 'channel', chatId: '-1001', messageId: '5', text: 'B' });
    const a2 = archive.saveTelegram({ kind: 'channel', chatId: '-1001', messageId: '5', text: 'A' });
    assert.equal(unchanged.revision, 1);
    assert.equal(b.revision, 2);
    assert.equal(a2.revision, 3);
    assert.equal(a2.contentHash, a1.contentHash);
    assert.equal(readdirSync(join(root, 'telegram', 'channels', '-1001', '.history')).length, 2);

    const first = archive.claimOutbox(1)[0];
    const newer = archive.claimOutbox(10).find((row) => row.revision === 2 || row.revision === 3);
    assert.ok(first);
    assert.ok(newer);
    assert.equal(archive.acknowledgeProjection(first.archive_id, first.revision), 'superseded');
  } finally {
    archive.close();
  }
});

test('вложения получают проверенный SHA-256, размер и относительный путь', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner' });
  try {
    const result = archive.saveTelegram({
      kind: 'channel', chatId: '-1004', messageId: '10', text: 'with file',
      attachments: [{ type: 'document', name: '../report.PDF', data: new TextEncoder().encode('bytes') }],
    });
    const content = readFileSync(result.path, 'utf8');
    assert.match(content, /state: "ready"/);
    assert.match(content, /size: 5/);
    assert.match(content, /sha256: "[a-f0-9]{64}"/);
    assert.match(content, /path: "attachments\/[a-f0-9]{64}\.pdf"/);
  } finally {
    archive.close();
  }
});

test('П-09: recovery reconciles file, SQLite and an interrupted projection', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  const first = new Archive({ rootDir: root, ownerId: 'owner', failAt: 'after_archive' });
  assert.throws(() => first.saveTelegram({ kind: 'channel', chatId: '-1002', messageId: '8', text: 'recover me' }), /after_archive/);
  first.close();

  const recovered = new Archive({ rootDir: root, ownerId: 'owner' });
  let recoveredClosed = false;
  try {
    const report = recovered.recover();
    assert.equal(report.archives, 1);
    assert.equal(recovered.getState().outbox.length, 1);
    const claimed = recovered.claimOutbox(1)[0];
    assert.equal(claimed.status, 'in_progress');
    recovered.close();
    recoveredClosed = true;

    const afterImportUnconfirmed = new Archive({ rootDir: root, ownerId: 'owner', failAt: 'after_external_import' });
    try {
      assert.throws(() => afterImportUnconfirmed.acknowledgeProjection(claimed.archive_id, claimed.revision), /after_external_import/);
      afterImportUnconfirmed.recover();
      assert.equal(afterImportUnconfirmed.getState().outbox[0].status, 'pending');
    } finally {
      afterImportUnconfirmed.close();
    }
    const acknowledged = new Archive({ rootDir: root, ownerId: 'owner' });
    try {
      const retry = acknowledged.claimOutbox(1)[0];
      assert.equal(acknowledged.acknowledgeProjection(retry.archive_id, retry.revision), 'completed');
      assert.equal(acknowledged.getState().outbox.filter((row) => row.archive_id === claimed.archive_id).length, 1);
    } finally {
      acknowledged.close();
    }
  } finally {
    if (!recoveredClosed) recovered.close();
  }
});

test('П-23: CRLF is readable, unknown optional metadata survives, unknown versions block writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-memory-'));
  const archive = new Archive({ rootDir: root, ownerId: 'owner' });
  try {
    const first = archive.saveTelegram({ kind: 'channel', chatId: '-1003', messageId: '9', text: 'A', extra: { custom_note: 'keep me' } });
    const crlf = readFileSync(first.path, 'utf8').replace(/\n/g, '\r\n');
    writeFileSync(first.path, crlf, 'utf8');
    const revised = archive.saveTelegram({ kind: 'channel', chatId: '-1003', messageId: '9', text: 'B' });
    const output = readFileSync(revised.path, 'utf8');
    assert.equal(output.includes('\r\n'), false);
    assert.match(output, /custom_note: "keep me"/);

    const unknownVersion = output.replace('schema_version: 1', 'schema_version: 999');
    writeFileSync(revised.path, unknownVersion, 'utf8');
    assert.throws(() => archive.saveTelegram({ kind: 'channel', chatId: '-1003', messageId: '9', text: 'C' }), /Unsupported archive schema_version/);
    assert.equal(readFileSync(revised.path, 'utf8'), unknownVersion);
  } finally {
    archive.close();
  }
});
