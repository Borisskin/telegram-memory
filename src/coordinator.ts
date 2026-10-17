import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { Archive, ArchiveError, type TelegramKind, type TelegramInput } from './archive.ts';
import { AccessError, type Access, type Principal } from './access.ts';
import { inboxSave } from './inbox.ts';
import { digest, DigestError, recentDigestGroups } from './digest.ts';
import { NotebookError } from './notebook.ts';
import { openVikingFileType } from './formats.ts';

function ownerClock(date: Date): { day: string; time: string } {
  // ponytail: часовой пояс владельца закреплён как Europe/Moscow; при появлении настройки пояса читать её из конфигурации.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export const CONTRACT_VERSION = 1 as const;

export type CoordinatorErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_argument'
  | 'unsupported_source'
  | 'source_unavailable'
  | 'operation_in_progress'
  | 'pilot_not_configured'
  | 'name_exhausted'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_incompatible'
  | 'archive_corrupt'
  | 'unsupported_attachment'
  | 'forbidden_area'
  | 'range_too_long'
  | 'notebook_auth'
  | 'notebook_quota';

export interface ResolvedTelegramSource {
  chatId: string | number | bigint;
  title?: string | null;
  kind: TelegramKind | 'user';
  username?: string | null;
}

export interface TelegramMessage {
  id: string | number | bigint;
  text: string;
  publishedAt?: string | null;
  editedAt?: string | null;
  sourceName?: string | null;
  sourceUsername?: string | null;
  sourceUrl?: string | null;
  attachments?: TelegramInput['attachments'];
  extra?: Record<string, unknown>;
}

export interface TelegramPage {
  messages: TelegramMessage[];
  nextCursor?: string | null;
  done?: boolean;
}

export interface TelegramGateway {
  resolveSource?(ref: string): Promise<ResolvedTelegramSource> | ResolvedTelegramSource;
  resolve?(ref: string): Promise<ResolvedTelegramSource> | ResolvedTelegramSource;
  digestSource?(ref: string): Promise<{ chatId: string | number; title?: string | null; kind: string }> | { chatId: string | number; title?: string | null; kind: string };
  history?(args: { chat_id: string; limit: number; from_date: string; to_date: string }): Promise<unknown> | unknown;
  recentGroups?(args: { chat_type: 'group'; limit: 10 }): Promise<unknown> | unknown;
  callTool?(name: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  collect?(args: {
    source: ResolvedTelegramSource & { ref: string };
    cursor: string | null;
    limit: number;
    manifest: readonly string[];
    mode: 'pilot' | 'history' | 'updates';
  }): Promise<TelegramPage> | TelegramPage;
  listMessages?(args: {
    source: ResolvedTelegramSource & { ref: string };
    cursor: string | null;
    limit: number;
    manifest: readonly string[];
    mode: 'pilot' | 'history' | 'updates';
  }): Promise<TelegramPage> | TelegramPage;
  getMessages?(args: {
    source: ResolvedTelegramSource & { ref: string };
    cursor: string | null;
    limit: number;
    manifest: readonly string[];
    mode: 'pilot' | 'history' | 'updates';
  }): Promise<TelegramPage> | TelegramPage;
}

export interface CoordinatorOptions {
  archive?: Archive;
  rootDir?: string;
  ownerId?: string;
  telegram?: TelegramGateway;
  telegramMcp?: TelegramGateway;
  now?: () => Date;
  integrations?: { callTool(name: string, args?: unknown, accessContext?: unknown): Promise<unknown> };
  access?: Access;
  notebookGateway?: { summarize(markdown: string, prompt: string): Promise<string> };
}

export interface CoordinatorSuccess<T> {
  contract_version: typeof CONTRACT_VERSION;
  success: true;
  data: T;
}

export interface CoordinatorFailure {
  contract_version: typeof CONTRACT_VERSION;
  success: false;
  error: {
    code: CoordinatorErrorCode;
    message: string;
    retryable: boolean;
    retry_after_seconds?: number;
    job_id?: string;
    reset_at?: string;
  };
}

export type CoordinatorResponse<T = unknown> = CoordinatorSuccess<T> | CoordinatorFailure;

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly jobId?: string;
  readonly resetAt?: string;

  constructor(code: CoordinatorErrorCode, message: string, options: { retryable?: boolean; retryAfterSeconds?: number; jobId?: string; resetAt?: string } = {}) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.jobId = options.jobId;
    this.resetAt = options.resetAt;
  }
}

export class FloodWaitError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`FLOOD_WAIT ${seconds}`);
    this.name = 'FloodWaitError';
    this.seconds = Math.max(1, Math.ceil(seconds));
  }
}

type SourceRow = {
  source_id: number;
  owner_id: string;
  ref: string;
  chat_id: string;
  title: string | null;
  username: string | null;
  kind: TelegramKind;
  mode: 'full' | 'summary' | 'personal_chat';
  status: 'paused' | 'enabled';
  download_images: number;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  job_id: string;
  source_id: number;
  owner_id: string;
  mode: 'pilot' | 'history' | 'updates';
  status: 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'needs_attention' | 'cancelling' | 'cancelled';
  limit_count: number;
  manifest_json: string;
  manifest_hash: string;
  cursor: string | null;
  saved_count: number;
  unchanged_count: number;
  skipped_count: number;
  error_count: number;
  next_attempt_at: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
};

function canonicalRef(ref: unknown): string {
  if (typeof ref !== 'string' || !ref.trim()) throw new CoordinatorError('invalid_argument', 'ref is required');
  if (/^\d+$/.test(ref.trim())) return BigInt(ref.trim()).toString();
  let parsed: URL;
  try { parsed = new URL(ref.trim()); } catch { throw new CoordinatorError('invalid_argument', 'ref must be a URL'); }
  if (parsed.protocol !== 'https:') throw new CoordinatorError('unsupported_source', 'Telegram source must use HTTPS');
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 't.me' && host !== 'telegram.me') throw new CoordinatorError('unsupported_source', 'ref must point to t.me or telegram.me');
  const path = parsed.pathname.replace(/\/+$/, '');
  if (!path || path === '/' || /^\/(?:\+|joinchat\/)/i.test(path)) throw new CoordinatorError('unsupported_source', 'invite links are not supported');
  parsed.hostname = 't.me';
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function idString(value: string | number | bigint): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new CoordinatorError('invalid_argument', 'Telegram identifiers must be exact integers');
  const result = String(value);
  if (!/^-?\d+$/.test(result)) throw new CoordinatorError('upstream_incompatible', 'Telegram returned a non-numeric identifier');
  return BigInt(result).toString();
}

function hashManifest(manifest: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function parseManifest(value: unknown, limitValue: unknown): { manifest: string[]; limit: number; hash: string } {
  if (!Array.isArray(value) || value.length === 0) throw new CoordinatorError('pilot_not_configured', 'pilot manifest is required');
  const manifest = value.map((entry) => {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'bigint') throw new CoordinatorError('invalid_argument', 'manifest identifiers must be integers');
    return idString(entry);
  });
  if (new Set(manifest).size !== manifest.length) throw new CoordinatorError('invalid_argument', 'manifest identifiers must be unique');
  const limit = limitValue === undefined ? manifest.length : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || manifest.length > limit) throw new CoordinatorError('invalid_argument', 'pilot limit must be between 1 and 100 and cover the manifest');
  return { manifest, limit, hash: hashManifest(manifest) };
}

function jsonValue(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export class Coordinator {
  readonly archive: Archive;
  private readonly db: DatabaseSync;
  private readonly telegram: TelegramGateway;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly integrations?: { callTool(name: string, args?: unknown, accessContext?: unknown): Promise<unknown> };
  private readonly access?: Access;
  private readonly notebookGateway?: CoordinatorOptions['notebookGateway'];
  private ownsArchive: boolean;

  constructor(options: CoordinatorOptions) {
    const telegram = options.telegram ?? options.telegramMcp;
    if (!telegram || (typeof telegram.resolveSource !== 'function' && typeof telegram.resolve !== 'function')) throw new CoordinatorError('invalid_argument', 'telegram boundary is required');
    this.telegram = telegram;
    if (typeof options.ownerId !== 'undefined' && (typeof options.ownerId !== 'string' || !options.ownerId.trim())) throw new CoordinatorError('invalid_argument', 'trusted ownerId is required');
    this.ownerId = options.ownerId ?? 'owner';
    this.now = options.now ?? (() => new Date());
    this.integrations = options.integrations;
    this.access = options.access;
    this.notebookGateway = options.notebookGateway;
    this.archive = options.archive ?? new Archive({ rootDir: options.rootDir ?? '.archive', ownerId: this.ownerId, now: this.now });
    this.ownsArchive = !options.archive;
    this.db = new DatabaseSync(this.archive.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        source_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT,
        username TEXT,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'full',
        status TEXT NOT NULL DEFAULT 'paused',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, ref)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        source_id INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        limit_count INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        cursor TEXT,
        saved_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES sources(source_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_source_idx ON jobs(owner_id, source_id, created_at);
      CREATE TABLE IF NOT EXISTS observations (
        source_id INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        archive_id TEXT,
        content_hash TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(source_id, job_id, message_id),
        FOREIGN KEY(source_id) REFERENCES sources(source_id),
        FOREIGN KEY(job_id) REFERENCES jobs(job_id)
      );
      CREATE TABLE IF NOT EXISTS alerts (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        taken INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS inbox_record_ids (
        short_id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS source_ref_ids (
        short_id TEXT PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS digest_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        digest_time TEXT NOT NULL,
        previous_time TEXT NOT NULL,
        effective_day TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digest_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_to TEXT,
        pending_from TEXT,
        pending_to TEXT,
        batch_id TEXT,
        last_batch_id TEXT,
        checked_day TEXT
      );
      `);
    if (!(this.db.prepare('PRAGMA table_info(digest_cursor)').all() as Array<{ name: string }>).some((column) => column.name === 'last_batch_id')) this.db.exec('ALTER TABLE digest_cursor ADD COLUMN last_batch_id TEXT');
    this.db.prepare("INSERT OR IGNORE INTO digest_settings VALUES (1, '09:00', '09:00', '0000-01-01')").run();
    this.db.prepare('INSERT OR IGNORE INTO digest_cursor (id) VALUES (1)').run();
    if (!(this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).some((column) => column.name === 'mode')) this.db.exec("ALTER TABLE sources ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'");
    if (!(this.db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).some((column) => column.name === 'generation')) this.db.exec('ALTER TABLE alerts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1');
    if (!(this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).some((column) => column.name === 'username')) this.db.exec('ALTER TABLE sources ADD COLUMN username TEXT');
    if (!(this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).some((column) => column.name === 'download_images')) this.db.exec('ALTER TABLE sources ADD COLUMN download_images INTEGER NOT NULL DEFAULT 0');
    this.archive.recover();
  }

  close(): void {
    this.db.close();
    (this.access as (Access & { close?: () => void }) | undefined)?.close?.();
    if (this.ownsArchive) this.archive.close();
  }

  private async scheduledDigest(): Promise<{ kind: 'raw' | 'empty' | 'not_due'; markdown?: string; batch_id?: string }> {
    const now = this.now();
    const { day, time } = ownerClock(now);
    const settings = this.db.prepare('SELECT digest_time, previous_time, effective_day FROM digest_settings WHERE id = 1').get() as { digest_time: string; previous_time: string; effective_day: string };
    const dueTime = day < settings.effective_day ? settings.previous_time : settings.digest_time;
    const cursor = this.db.prepare('SELECT last_to, pending_from, checked_day FROM digest_cursor WHERE id = 1').get() as { last_to: string | null; pending_from: string | null; checked_day: string | null };
    if (time < dueTime || cursor.checked_day === day) return { kind: 'not_due' };
    const from = new Date(cursor.last_to ? new Date(cursor.last_to).getTime() + 1 : cursor.pending_from ?? new Date(now.getTime() - 86_400_000).toISOString());
    const sources = this.db.prepare("SELECT chat_id FROM sources WHERE owner_id = ? AND mode = 'summary' AND kind IN ('group', 'channel') GROUP BY chat_id").all(this.ownerId) as Array<{ chat_id: string }>;
    if (!sources.length) {
      this.db.prepare('UPDATE digest_cursor SET checked_day = ? WHERE id = 1').run(day);
      return { kind: 'empty' };
    }
    const result = await digest({ groups: sources.map((source) => source.chat_id), from, to: now, scheduled: true }, {
      archive: this.archive, telegram: this.telegram,
      source: (ref) => {
        const row = this.db.prepare("SELECT * FROM sources WHERE owner_id = ? AND chat_id = ? AND mode = 'summary'").get(this.ownerId, ref) as SourceRow | undefined;
        return row && { chatId: row.chat_id, title: row.title, kind: row.kind, mode: row.mode };
      },
    });
    if (result.kind !== 'raw') throw new CoordinatorError('upstream_incompatible', 'Scheduled digest must return raw messages');
    this.db.prepare('UPDATE digest_cursor SET pending_from = COALESCE(pending_from, ?), checked_day = ? WHERE id = 1').run(from.toISOString(), result.markdown ? null : day);
    if (!result.markdown) return { kind: 'empty' };
    const batchId = randomUUID();
    this.db.prepare('UPDATE digest_cursor SET pending_to = ?, batch_id = ? WHERE id = 1').run(now.toISOString(), batchId);
    return { ...result, batch_id: batchId };
  }

  private digestCommit(batchId: unknown): { committed: boolean; last_to: string } {
    if (typeof batchId !== 'string' || !batchId) throw new CoordinatorError('invalid_argument', 'batch_id is required');
    const cursor = this.db.prepare('SELECT pending_to, batch_id, last_batch_id, last_to FROM digest_cursor WHERE id = 1').get() as { pending_to: string | null; batch_id: string | null; last_batch_id: string | null; last_to: string | null };
    if (cursor.last_batch_id === batchId && cursor.last_to) return { committed: true, last_to: cursor.last_to };
    if (cursor.batch_id !== batchId || !cursor.pending_to) throw new CoordinatorError('invalid_argument', 'Unknown digest batch_id');
    const day = ownerClock(new Date(cursor.pending_to)).day;
    this.db.prepare('UPDATE digest_cursor SET last_to = pending_to, pending_from = NULL, pending_to = NULL, batch_id = NULL, last_batch_id = ?, checked_day = ? WHERE id = 1 AND batch_id = ?').run(batchId, day, batchId);
    return { committed: true, last_to: cursor.pending_to };
  }

  resolveInboxRecord(shortId: string): string | undefined {
    const row = this.db.prepare('SELECT archive_id FROM inbox_record_ids WHERE short_id = ?').get(shortId) as { archive_id: string } | undefined;
    return row?.archive_id;
  }

  private sourceRefId(ref: string): string {
    const shortId = createHash('sha256').update(ref).digest('hex').slice(0, 32);
    this.db.prepare('INSERT OR IGNORE INTO source_ref_ids (short_id, ref) VALUES (?, ?)').run(shortId, ref);
    const stored = this.db.prepare('SELECT ref FROM source_ref_ids WHERE short_id = ?').get(shortId) as { ref: string } | undefined;
    if (stored?.ref !== ref) throw new CoordinatorError('archive_corrupt', 'Short source reference collision');
    return shortId;
  }

  private sourceRef(refId: unknown): string | undefined {
    if (typeof refId !== 'string') return undefined;
    return (this.db.prepare('SELECT ref FROM source_ref_ids WHERE short_id = ?').get(refId) as { ref: string } | undefined)?.ref;
  }

  async callTool(name: string, args: unknown = {}, principal?: Principal): Promise<CoordinatorResponse> {
    try {
      const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      if (this.access) {
        if (!principal) throw new CoordinatorError('unauthorized', 'Bearer token is required');
        try { this.access.authorize(principal, name); }
        catch (error) { if (error instanceof AccessError) throw new CoordinatorError(error.code, error.message); throw error; }
      }
      switch (name) {
        case 'digest': {
          if (input.chat_id !== undefined && input.chat_id !== this.ownerId) throw new CoordinatorError('forbidden', 'Owner chat is required');
          if (input.scheduled === true) return this.success(await this.scheduledDigest());
          if (input.groups === undefined && input.from === undefined && input.to === undefined) return this.success({ groups: await recentDigestGroups(this.telegram) });
          if (!Array.isArray(input.groups) || input.groups.some((ref) => typeof ref !== 'string' || !ref.trim()) || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.scheduled !== 'boolean') throw new CoordinatorError('invalid_argument', 'groups, from, to, and scheduled are required');
          const from = new Date(input.from);
          const to = new Date(input.to);
          try {
            return this.success(await digest({ groups: input.groups as string[], from, to, scheduled: input.scheduled }, {
              archive: this.archive, telegram: this.telegram, notebookGateway: this.notebookGateway,
              source: (ref) => {
                const row = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND (ref = ? OR chat_id = ?)').get(this.ownerId, ref, ref) as SourceRow | undefined;
                return row && { chatId: row.chat_id, title: row.title, kind: row.kind, mode: row.mode };
              },
            }));
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'notebook_auth') {
              this.db.prepare('INSERT OR IGNORE INTO alerts (chat_id, title) VALUES (?, ?)').run(`notebook_auth:${ownerClock(this.now()).day}`, 'Куки NotebookLM протухли, обновите');
            }
            throw error;
          }
        }
        case 'digest_commit': return this.success(this.digestCommit(input.batch_id));
        case 'settings_set': {
          const digestTime = input.digest_time;
          if (typeof digestTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(digestTime)) throw new CoordinatorError('invalid_argument', 'Укажите время в формате HH:MM');
          const day = ownerClock(this.now()).day;
          const effectiveDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
          const current = this.db.prepare('SELECT digest_time, previous_time, effective_day FROM digest_settings WHERE id = 1').get() as { digest_time: string; previous_time: string; effective_day: string };
          const previous = current.effective_day > day ? current.previous_time : current.digest_time;
          this.db.prepare('UPDATE digest_settings SET digest_time = ?, previous_time = ?, effective_day = ? WHERE id = 1').run(digestTime, previous, effectiveDay);
          return this.success({ digest_time: digestTime, effective_day: effectiveDay });
        }
        case 'inbox_save': {
          const chatId = input.chat_id;
          const messageId = input.message_id;
          const date = input.date;
          const message = input.text;
          const file = input.attachment as { name?: unknown; mime_type?: unknown; base64?: unknown } | undefined;
          if (file !== undefined && (!file || typeof file.name !== 'string' || !file.name || typeof file.base64 !== 'string')) throw new CoordinatorError('invalid_argument', 'attachment needs name and base64');
          const fileType = file ? openVikingFileType(file.name as string) : null;
          if (file && !fileType) throw new CoordinatorError('unsupported_attachment', 'OpenViking does not support this file format');
          const attachment = file && fileType ? { type: fileType, name: file.name as string, data: Buffer.from(file.base64 as string, 'base64'), mimeType: typeof file.mime_type === 'string' ? file.mime_type : null } : undefined;
          if (typeof chatId !== 'string' || chatId !== this.ownerId || typeof messageId !== 'string' || !/^\d+$/.test(messageId) || typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || typeof message !== 'string' || (!message.trim() && !attachment)) throw new CoordinatorError('invalid_argument', 'Valid owner chat, message_id, date, and text are required');
          const resolve = this.telegram.resolveSource ?? this.telegram.resolve;
          if (!resolve) throw new CoordinatorError('upstream_incompatible', 'telegram boundary does not provide source resolution');
          const saved = await inboxSave(this.archive, this.ownerId, {
            chatId, messageId, date, text: message, attachment,
            entities: Array.isArray(input.entities) ? input.entities.filter((entity): entity is { type: string; value: string } => !!entity && typeof entity.type === 'string' && typeof entity.value === 'string') : [],
            forwardOrigin: input.forward_origin,
            forwarded: Object.hasOwn(input, 'forward_origin'),
          }, {
            webSave: this.integrations ? (url) => this.integrations!.callTool('web_save', { url }) : undefined,
            resolveSource: (ref) => resolve.call(this.telegram, ref),
            sourceExists: (sourceChatId) => this.sourceExists(sourceChatId),
          });
          const archiveId = saved.records[0].archive_id;
          const shortId = createHash('sha256').update(archiveId).digest('hex').slice(0, 32);
          this.db.prepare('INSERT OR IGNORE INTO inbox_record_ids (short_id, archive_id) VALUES (?, ?)').run(shortId, archiveId);
          if (this.resolveInboxRecord(shortId) !== archiveId) throw new CoordinatorError('archive_corrupt', 'Short record ID collision');
          return this.success({ ...saved, records: [{ archive_id: archiveId, short_id: shortId }, ...saved.records.slice(1)], offers: saved.offers.map((offer) => ({ ...offer, ref_id: this.sourceRefId(offer.ref) })) });
        }
        case 'record_delete': {
          const archiveId = typeof input.short_id === 'string' ? this.resolveInboxRecord(input.short_id) : input.archive_id;
          if (typeof archiveId !== 'string' || !archiveId) throw new CoordinatorError('invalid_argument', 'A known archive_id or short_id is required');
          let record: ReturnType<Archive['read']>;
          try { record = this.archive.read(archiveId); }
          catch (error) { if (error instanceof ArchiveError) throw new CoordinatorError('invalid_argument', 'Archive record is unknown'); throw error; }
          if (!['personal_telegram', 'personal_web'].includes(String(record.metadata.source_kind)) || record.metadata.owner_id !== this.ownerId) throw new CoordinatorError('forbidden', 'Only owner personal records can be deleted');
          return this.success(this.archive.markPersonalDeleted(archiveId));
        }
        case 'source_add': {
          if (principal?.role === 'system' && input.mode === 'personal_chat') throw new CoordinatorError('forbidden', 'Only Receiver can connect personal chats');
          if (input.download_images !== undefined) throw new CoordinatorError('invalid_argument', 'Sources are connected with download_images off; use source_settings_set');
          return this.success(await this.sourceAdd(input));
        }
        case 'collect_start': return this.success(await this.collectStart(input));
        case 'collect_pause': return this.success(this.collectPause(input));
        case 'collect_cancel': return this.success(this.collectCancel(input));
        case 'collect_status': return this.success(this.collectStatus(input));
        case 'source_settings_set': return this.success(this.sourceSettingsSet(input));
        case 'personal_save': return this.success(this.personalSave(input));
        case 'chat_access_set': {
          if (!this.access) throw new CoordinatorError('upstream_incompatible', 'Access control is not configured');
          const chatId = String(input.chat_id ?? input.chatId ?? '');
          const access = input.access;
          if (access !== 'none' && access !== 'all_shared' && !Array.isArray(access)) throw new CoordinatorError('invalid_argument', 'access must be none, all_shared, or a list of source references');
          if (Array.isArray(access) && access.some((ref) => typeof ref !== 'string' || !this.sourceExists(ref))) throw new CoordinatorError('invalid_argument', 'access contains an unknown source');
          this.access.setChatAccess(chatId, access as 'none' | 'all_shared' | string[]);
          return this.success({ chat_id: chatId, access });
        }
        case 'chat_access_list': {
          if (!this.access) throw new CoordinatorError('upstream_incompatible', 'Access control is not configured');
          if (input.joined === true) return this.success(this.db.prepare('SELECT chat_id, title FROM alerts ORDER BY title, chat_id').all());
          const chatId = typeof input.chat_id === 'string' ? input.chat_id : undefined;
          const query = chatId ? this.db.prepare('SELECT chat_id, access_json FROM chat_access WHERE chat_id = ? ORDER BY chat_id') : this.db.prepare('SELECT chat_id, access_json FROM chat_access ORDER BY chat_id');
          const rows = (chatId ? query.all(chatId) : query.all()) as Array<{ chat_id: string; access_json: string }>;
          return this.success(rows.map((row) => ({ chat_id: row.chat_id, access: jsonValue(row.access_json) })));
        }
        case 'chat_joined': {
          const chatId = input.chat_id;
          const title = input.title;
          if (typeof chatId !== 'string' || !chatId.trim() || typeof title !== 'string' || !title.trim()) throw new CoordinatorError('invalid_argument', 'chat_id and title are required');
          this.db.prepare('INSERT INTO alerts (chat_id, title) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, taken = 0, generation = generation + 1 WHERE taken = 1').run(chatId, title);
          return this.success({ chat_id: chatId, title });
        }
        case 'alerts_take':
          // ponytail: один Приёмщик; при нескольких процессах понадобится аренда, чтобы исключить одновременную отправку.
          return this.success(this.db.prepare('SELECT chat_id, title, generation AS delivery_id FROM alerts WHERE taken = 0 ORDER BY chat_id').all());
        case 'alerts_ack': {
          const chatId = input.chat_id;
          const deliveryId = input.delivery_id;
          if (typeof chatId !== 'string' || !chatId.trim() || typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new CoordinatorError('invalid_argument', 'chat_id and delivery_id are required');
          const result = this.db.prepare('UPDATE alerts SET taken = 1 WHERE chat_id = ? AND generation = ? AND taken = 0').run(chatId, deliveryId);
          return this.success({ chat_id: chatId, delivery_id: deliveryId, acknowledged: result.changes === 1 });
        }
        case 'search':
        case 'knowledge_search':
        case 'knowledge_read':
        case 'web_save':
          if (!this.integrations) throw new CoordinatorError('upstream_incompatible', `${name} is not configured`);
          const chatId = String(input.chat_id ?? input.chatId ?? '');
          const accessContext = this.access && principal ? {
            principal,
            chatId,
            personId: typeof (input.person_id ?? input.personId) === 'string' ? String(input.person_id ?? input.personId) : undefined,
            targets: principal.role === 'talker' && name !== 'knowledge_read' ? this.access.searchTargets(principal, { chatId, ...(typeof (input.person_id ?? input.personId) === 'string' ? { personId: String(input.person_id ?? input.personId) } : {}) }) : undefined,
            canRead: (targetUri: string) => this.access!.canRead(principal, targetUri, { chatId }),
          } : undefined;
          return await this.integrations.callTool(name, input, accessContext) as CoordinatorResponse;
        default: throw new CoordinatorError('invalid_argument', `Unknown coordinator tool: ${name}`);
      }
    } catch (error) {
      return this.failure(error);
    }
  }

  async handleMcpRequest(request: unknown, principal?: Principal): Promise<unknown> {
    const input = (request && typeof request === 'object' ? request : {}) as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const id = input.id ?? null;
    if (input.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'telegram-memory-coordinator', version: '1' } } };
    if (input.method === 'notifications/initialized') return undefined;
    if (input.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: this.toolDefinitions(principal) } };
    if (input.method === 'tools/call') {
      const params = input.params ?? {};
      const result = await this.callTool(String(params.name ?? ''), params.arguments ?? {}, principal);
      return { jsonrpc: '2.0', id, result: { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success } };
    }
    if (input.method && (MCP_TOOL_NAMES as readonly string[]).includes(input.method)) return this.callTool(input.method, input.params ?? {}, principal);
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  private toolDefinitions(principal?: Principal): unknown[] {
    const tools = [
      ['inbox_save', 'Save owner message and return records and source offers', ['chat_id', 'message_id', 'date', 'text']],
      ['record_delete', 'Soft-delete an owner personal archive record', []],
      ['source_add', 'Register a Telegram channel, group, or personal chat', []],
      ['collect_start', 'Start a bounded source collection', ['ref']],
      ['collect_pause', 'Pause collection for a source', []],
      ['collect_cancel', 'Cancel the current source job', []],
      ['collect_status', 'Read source and collection status', []],
      ['source_settings_set', 'Turn image download on or off for a source', ['download_images']],
      ['search', 'Search indexed archive content', ['query']],
      ['knowledge_search', 'Search indexed archive content available to this principal', ['query', 'limit']],
      ['knowledge_read', 'Read the current document for a short-lived search token', ['read_token']],
      ['web_save', 'Save a web page in the personal archive', ['url']],
      ['personal_save', 'Save owner text in the personal archive', ['text']],
      ['chat_access_list', 'List group memory access rules', []],
      ['chat_access_set', 'Set group memory access rules', ['chat_id', 'access']],
      ['chat_joined', 'Notify the owner about a joined group', ['chat_id', 'title']],
      ['alerts_take', 'Take pending owner alerts', []],
      ['alerts_ack', 'Confirm an owner alert after delivery', ['chat_id', 'delivery_id']],
      ['digest', 'Prepare a short group digest or list recent groups', []],
      ['digest_commit', 'Confirm a sent scheduled digest', ['batch_id']],
      ['settings_set', 'Set the owner digest time', ['digest_time']],
    ].map(([name, description, required]) => ({
      name,
      description,
      inputSchema: {
        type: 'object',
        required,
        properties: {
          ref: { type: 'string' }, ref_id: { type: 'string' }, query: { type: 'string' }, scope: { type: 'string', enum: ['all', 'all_telegram', 'source', 'personal'] }, limit: { type: 'integer', minimum: 1, maximum: 20 }, read_token: { type: 'string' }, mode: { type: 'string' }, manifest: { type: 'array' }, url: { type: 'string' }, text: { type: 'string' }, entities: { type: 'array' }, forward_origin: {}, archive_id: { type: 'string' }, short_id: { type: 'string' }, operation_id: { type: 'string' }, source_url: { type: 'string' }, extra: { type: 'object' }, forward: { type: 'object', properties: { from_user_id: { type: 'string' }, sender_name: { type: 'string' } } }, chat_id: { type: 'string' }, message_id: { type: 'string' }, date: { type: 'string' }, title: { type: 'string' }, delivery_id: { type: 'integer', minimum: 1 }, person_id: { type: 'string' }, access: { type: ['string', 'array'] },
          groups: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, scheduled: { type: 'boolean' }, batch_id: { type: 'string' }, digest_time: { type: 'string' },
        },
      },
    }));
    const access = this.access;
    if (!access) return tools;
    if (!principal) return [];
    return tools.filter((tool) => {
      try { access.authorize(principal, String(tool.name)); return true; }
      catch { return false; }
    });
  }

  private success<T>(data: T): CoordinatorSuccess<T> { return { contract_version: CONTRACT_VERSION, success: true, data }; }

  private failure(error: unknown): CoordinatorFailure {
    if (error instanceof DigestError) return this.failure(new CoordinatorError(error.code, error.message));
    if (error instanceof NotebookError || (error instanceof Error && !(error instanceof CoordinatorError) && 'code' in error && (error.code === 'notebook_auth' || error.code === 'notebook_quota'))) {
      const notebook = error as Error & { code: 'notebook_auth' | 'notebook_quota'; resetAt?: string; reset_at?: string };
      return this.failure(new CoordinatorError(notebook.code, notebook.code === 'notebook_auth' ? 'Куки NotebookLM протухли, обновите' : 'Лимит NotebookLM исчерпан', { resetAt: notebook.resetAt ?? notebook.reset_at }));
    }
    if (error instanceof AccessError) return this.failure(new CoordinatorError(error.code, error.message));
    if (error instanceof CoordinatorError) {
      return { contract_version: CONTRACT_VERSION, success: false, error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }), ...(error.jobId ? { job_id: error.jobId } : {}), ...(error.resetAt ? { reset_at: error.resetAt } : {}) } };
    }
    if (error instanceof FloodWaitError) return { contract_version: CONTRACT_VERSION, success: false, error: { code: 'rate_limited', message: error.message, retryable: true, retry_after_seconds: error.seconds } };
    if (error instanceof ArchiveError) return { contract_version: CONTRACT_VERSION, success: false, error: { code: error.message === 'name_exhausted' ? 'name_exhausted' : 'archive_corrupt', message: error.message, retryable: false } };
    return { contract_version: CONTRACT_VERSION, success: false, error: { code: 'upstream_unavailable', message: error instanceof Error ? error.message : 'Upstream failure', retryable: true } };
  }

  private personalSave(input: Record<string, unknown>): unknown {
    if (typeof input.text !== 'string' || input.text.length === 0) throw new CoordinatorError('invalid_argument', 'text is required');
    if (input.attachments !== undefined) throw new CoordinatorError('unsupported_attachment', 'Personal binary attachments are not supported');
    const forward = input.forward;
    if (forward !== undefined && (!forward || typeof forward !== 'object' || Array.isArray(forward))) throw new CoordinatorError('invalid_argument', 'forward must be an object');
    const forwardDetails = forward as Record<string, unknown> | undefined;
    if (forwardDetails?.from_user_id !== undefined && typeof forwardDetails.from_user_id !== 'string') throw new CoordinatorError('invalid_argument', 'forward.from_user_id must be a string');
    if (forwardDetails?.sender_name !== undefined && typeof forwardDetails.sender_name !== 'string') throw new CoordinatorError('invalid_argument', 'forward.sender_name must be a string');
    const operationId = typeof input.operation_id === 'string' && input.operation_id ? input.operation_id : randomUUID();
    const result = this.archive.savePersonal({
      ownerId: this.ownerId,
      text: input.text,
      operationId,
      placement: forwardDetails ? 'forwards' : 'notes',
      ...(forwardDetails ? {
        fromUserId: typeof forwardDetails.from_user_id === 'string' ? forwardDetails.from_user_id || null : null,
        senderName: typeof forwardDetails.sender_name === 'string' ? forwardDetails.sender_name || null : null,
      } : {}),
      sourceUrl: typeof input.source_url === 'string' ? input.source_url : undefined,
      extra: input.extra && typeof input.extra === 'object' ? input.extra as Record<string, unknown> : undefined,
    });
    return { ...result, operation_id: operationId };
  }

  private async sourceAdd(input: Record<string, unknown>): Promise<unknown> {
    const ref = canonicalRef(input.ref ?? this.sourceRef(input.ref_id));
    const mode = input.mode ?? 'full';
    if (mode !== 'full' && mode !== 'summary' && mode !== 'personal_chat') throw new CoordinatorError('invalid_argument', 'mode must be full, summary, or personal_chat');
    const existing = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND ref = ?').get(this.ownerId, ref) as SourceRow | undefined;
    if (existing) return this.addedSourceView(existing);
    let resolved: ResolvedTelegramSource;
    try {
      const resolve = this.telegram.resolveSource ?? this.telegram.resolve;
      if (!resolve) throw new CoordinatorError('upstream_incompatible', 'telegram boundary does not provide source resolution');
      resolved = await resolve(ref);
    } catch (error) { throw new CoordinatorError('source_unavailable', error instanceof Error ? error.message : 'Telegram source is unavailable', { retryable: true }); }
    if (!resolved || (mode === 'personal_chat' ? resolved.kind !== 'user' && resolved.kind !== 'private' : resolved.kind !== 'channel' && resolved.kind !== 'group')) throw new CoordinatorError('unsupported_source', 'Telegram source kind does not match the requested mode');
    const kind: TelegramKind = mode === 'personal_chat' ? 'private' : resolved.kind as TelegramKind;
    const chatId = idString(resolved.chatId);
    const sameChat = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND chat_id = ?').get(this.ownerId, chatId) as SourceRow | undefined;
    if (sameChat) return this.addedSourceView(sameChat);
    const now = this.now().toISOString();
    this.db.prepare('INSERT INTO sources (owner_id, ref, chat_id, title, username, kind, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.ownerId, ref, chatId, resolved.title ?? null, resolved.username ?? null, kind, mode, 'paused', now, now);
    const source = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND ref = ?').get(this.ownerId, ref) as SourceRow;
    if (mode === 'personal_chat') await this.runAutoPersonalJob(source, 'history');
    return this.addedSourceView(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id) as SourceRow);
  }

  async pollPersonalChats(): Promise<void> {
    const sources = this.db.prepare("SELECT * FROM sources WHERE owner_id = ? AND mode = 'personal_chat' AND status = 'enabled'").all(this.ownerId) as SourceRow[];
    for (const source of sources) await this.runAutoPersonalJob(source, 'updates');
  }

  private async runAutoPersonalJob(source: SourceRow, mode: 'history' | 'updates'): Promise<void> {
    const previous = this.latestJob(source.source_id);
    if (previous?.status === 'running') return;
    if (previous && ['queued', 'waiting'].includes(previous.status)) {
      if (previous.manifest_hash === 'personal_auto') await this.runJob(previous, source);
      return;
    }
    if (previous && ['paused', 'cancelled', 'needs_attention'].includes(previous.status)) return;
    const now = this.now().toISOString();
    const jobId = randomUUID();
    this.db.prepare(`INSERT INTO jobs (job_id, source_id, owner_id, mode, status, limit_count, manifest_json, manifest_hash, cursor, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 1000, '[]', 'personal_auto', ?, ?, ?)`).run(jobId, source.source_id, this.ownerId, mode, previous?.cursor ?? null, now, now);
    this.db.prepare('UPDATE sources SET status = ?, updated_at = ? WHERE source_id = ?').run('enabled', now, source.source_id);
    await this.runJob(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow, { ...source, status: 'enabled' });
  }

  sourceExists(ref: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sources WHERE owner_id = ? AND (ref = ? OR chat_id = ?)').get(this.ownerId, ref, ref);
  }

  sourceTargetUri(ref: string): string | undefined {
    const source = this.db.prepare('SELECT chat_id, kind FROM sources WHERE owner_id = ? AND (ref = ? OR chat_id = ?)').get(this.ownerId, ref, ref) as { chat_id: string; kind: TelegramKind } | undefined;
    if (!source) return undefined;
    if (source.kind === 'private') return `viking://resources/personal/${encodeURIComponent(this.ownerId)}/people/${encodeURIComponent(source.chat_id)}/chat/`;
    const area = source.kind === 'channel' ? 'channels' : 'groups';
    return `viking://resources/telegram/${area}/${encodeURIComponent(source.chat_id)}/`;
  }

  private async collectStart(input: Record<string, unknown>): Promise<unknown> {
    const ref = canonicalRef(input.ref);
    const mode = input.mode === undefined ? 'pilot' : input.mode;
    if (mode !== 'pilot' && mode !== 'history' && mode !== 'updates') throw new CoordinatorError('pilot_not_configured', 'Collection mode is not configured');
    const parsed = parseManifest(input.manifest, input.limit);
    let source = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND ref = ?').get(this.ownerId, ref) as SourceRow | undefined;
    if (!source) {
      if (mode !== 'pilot') throw new CoordinatorError('source_unavailable', 'Connect the personal chat through Receiver first');
      const added = await this.sourceAdd({ ref, mode: mode === 'pilot' ? 'full' : 'personal_chat' }) as { source_id?: number };
      source = added.source_id === undefined ? undefined : this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND source_id = ?').get(this.ownerId, added.source_id) as SourceRow | undefined;
      if (!source) throw new CoordinatorError('source_unavailable', 'Source registration did not return a source');
    }
    if (source.mode === 'summary') throw new CoordinatorError('invalid_argument', 'Summary-only sources cannot be collected into the archive');
    if (source.kind === 'private' ? mode === 'pilot' : mode !== 'pilot') throw new CoordinatorError('invalid_argument', 'Collection mode does not match the source');
    let job = this.latestJob(source.source_id);
    if (job && ['queued', 'running', 'waiting'].includes(job.status)) {
      if (job.manifest_hash !== parsed.hash || job.limit_count !== parsed.limit || job.mode !== mode) throw new CoordinatorError('operation_in_progress', 'A different collection is already active', { retryable: true, jobId: job.job_id });
      if (job.status === 'waiting' && job.next_attempt_at && new Date(job.next_attempt_at).getTime() > this.now().getTime()) return this.jobView(job, source);
      return this.runJob(job, source);
    }
    if (job && job.status === 'paused' && (job.manifest_hash !== parsed.hash || job.limit_count !== parsed.limit || job.mode !== mode)) throw new CoordinatorError('operation_in_progress', 'A paused collection must be resumed with the same manifest', { jobId: job.job_id });
    const now = this.now().toISOString();
    const jobId = randomUUID();
    this.db.prepare(`INSERT INTO jobs (job_id, source_id, owner_id, mode, status, limit_count, manifest_json, manifest_hash, cursor, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?)`).run(jobId, source.source_id, this.ownerId, mode, parsed.limit, JSON.stringify(parsed.manifest), parsed.hash, now, now);
    this.db.prepare('UPDATE sources SET status = ?, updated_at = ? WHERE source_id = ?').run('enabled', now, source.source_id);
    job = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow;
    return this.runJob(job, { ...source, status: 'enabled', updated_at: now });
  }

  private async runJob(job: JobRow, source: SourceRow): Promise<unknown> {
    const now = this.now();
    if (job.status === 'waiting' && job.next_attempt_at && new Date(job.next_attempt_at).getTime() > now.getTime()) return this.jobView(job, source);
    const beforeRun = this.db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(job.job_id) as { status: JobRow['status'] } | undefined;
    if (beforeRun?.status === 'paused' || beforeRun?.status === 'cancelled') return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    if (beforeRun?.status === 'cancelling') {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'cancelling'").run(now.toISOString(), job.job_id);
      return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    }
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?').run('running', now.toISOString(), job.job_id);
    job = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow;
    const manifest = JSON.parse(job.manifest_json) as string[];
    let page: TelegramPage;
    try {
      const sourceArg = { ref: source.ref, chatId: source.chat_id, title: source.title, username: source.username, kind: source.kind, downloadImages: source.download_images === 1 } as ResolvedTelegramSource & { ref: string; downloadImages: boolean };
      if (this.telegram.collect) page = await this.telegram.collect({ source: sourceArg, cursor: job.cursor, limit: job.limit_count, manifest, mode: job.mode });
      else if (this.telegram.listMessages) page = await this.telegram.listMessages({ source: sourceArg, cursor: job.cursor, limit: job.limit_count, manifest, mode: job.mode });
      else if (this.telegram.getMessages) page = await this.telegram.getMessages({ source: sourceArg, cursor: job.cursor, limit: job.limit_count, manifest, mode: job.mode });
      else throw new CoordinatorError('upstream_incompatible', 'telegram boundary does not provide collection');
      if (!page || !Array.isArray(page.messages)) throw new CoordinatorError('upstream_incompatible', 'telegram boundary returned an invalid page');
    } catch (error) {
      const flood = error instanceof FloodWaitError ? error.seconds : this.floodWaitSeconds(error);
      if (flood !== undefined) {
        const next = new Date(this.now().getTime() + flood * 1000).toISOString();
        const details = { code: 'rate_limited', message: `Telegram requested a wait of ${flood} seconds`, retryable: true, retry_after_seconds: flood };
        this.db.prepare('UPDATE jobs SET status = ?, next_attempt_at = ?, last_error_json = ?, updated_at = ? WHERE job_id = ?').run('waiting', next, JSON.stringify(details), this.now().toISOString(), job.job_id);
        return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
      }
      const message = error instanceof Error ? error.message : 'Telegram request failed';
      const limitExceeded = message === 'Telegram history exceeds one-day collection limit' || message === 'Telegram updates exceed collection limit';
      const code: CoordinatorErrorCode = limitExceeded ? 'upstream_incompatible' : error instanceof CoordinatorError ? error.code : 'upstream_unavailable';
      const details = { code, message, retryable: code === 'upstream_unavailable' };
      this.db.prepare('UPDATE jobs SET status = ?, error_count = error_count + 1, last_error_json = ?, updated_at = ? WHERE job_id = ?').run(code === 'upstream_incompatible' ? 'needs_attention' : 'waiting', JSON.stringify(details), this.now().toISOString(), job.job_id);
      return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    }
    const afterPage = this.db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(job.job_id) as { status: JobRow['status'] } | undefined;
    if (afterPage?.status === 'paused' || afterPage?.status === 'cancelled') return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    if (afterPage?.status === 'cancelling') {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'cancelling'").run(this.now().toISOString(), job.job_id);
      return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    }
    const approved = new Set(manifest);
    const seen = new Set<string>();
    let saved = 0;
    let unchanged = 0;
    let skipped = 0;
    let errors = 0;
    let archiveFailure: unknown;
    for (const message of page.messages) {
      if (saved + unchanged >= job.limit_count) break;
      const gate = this.db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(job.job_id) as { status: JobRow['status'] } | undefined;
      if (gate?.status === 'paused' || gate?.status === 'cancelled') return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
      if (gate?.status === 'cancelling') {
        this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'cancelling'").run(this.now().toISOString(), job.job_id);
        return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
      }
      let messageId: string;
      try { messageId = idString(message.id); } catch { skipped += 1; continue; }
      if (seen.has(messageId)) { skipped += 1; continue; }
      seen.add(messageId);
      if (job.manifest_hash !== 'personal_auto' && !approved.has(messageId)) { skipped += 1; continue; }
      try {
        const result = this.archive.saveTelegram({ kind: source.kind, chatId: source.chat_id, messageId, text: message.text, sourceName: message.sourceName ?? source.title, sourceUrl: message.sourceUrl ?? source.ref, publishedAt: message.publishedAt, editedAt: message.editedAt, attachments: message.attachments, extra: message.extra });
        if (source.kind === 'private') {
          const name = message.sourceName ?? source.title ?? source.chat_id;
          const username = message.sourceUsername ?? source.username ?? /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(source.ref)?.[1] ?? null;
          this.archive.upsertPerson({ userId: source.chat_id, name, username });
          if (source.title !== name || source.username !== username) {
            this.db.prepare('UPDATE sources SET title = ?, username = ?, updated_at = ? WHERE source_id = ?').run(name, username, this.now().toISOString(), source.source_id);
            source.title = name;
            source.username = username;
          }
        }
        if (result.created) saved += 1; else unchanged += 1;
        this.db.prepare(`INSERT OR REPLACE INTO observations (source_id, job_id, message_id, status, archive_id, content_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(source.source_id, job.job_id, messageId, result.created ? 'saved' : 'unchanged', result.archiveId, result.contentHash, this.now().toISOString());
      } catch (error) {
        this.db.prepare(`INSERT OR REPLACE INTO observations (source_id, job_id, message_id, status, archive_id, content_hash, observed_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`).run(source.source_id, job.job_id, messageId, 'error', this.now().toISOString());
        errors += 1;
        archiveFailure = error;
        break;
      }
    }
    if (archiveFailure) {
      const details = { code: 'archive_corrupt', message: archiveFailure instanceof Error ? archiveFailure.message : 'Archive write failed', retryable: false };
      this.db.prepare(`UPDATE jobs SET status = 'needs_attention', saved_count = saved_count + ?, unchanged_count = unchanged_count + ?, skipped_count = skipped_count + ?, error_count = error_count + ?, last_error_json = ?, updated_at = ? WHERE job_id = ? AND status = 'running'`).run(saved, unchanged, skipped, errors, JSON.stringify(details), this.now().toISOString(), job.job_id);
      return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    }
    const done = page.done !== false || job.mode === 'pilot';
    const cursor = page.nextCursor === undefined ? job.cursor : page.nextCursor;
    const status = done ? 'completed' : 'queued';
    const committed = this.db.prepare(`UPDATE jobs SET status = ?, cursor = ?, saved_count = saved_count + ?, unchanged_count = unchanged_count + ?, skipped_count = skipped_count + ?, error_count = error_count + ?, next_attempt_at = NULL, last_error_json = NULL, updated_at = ? WHERE job_id = ? AND status = 'running'`).run(status, cursor ?? null, saved, unchanged, skipped, errors, this.now().toISOString(), job.job_id);
    if (!committed.changes) {
      const current = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow;
      if (current.status === 'cancelling') this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'cancelling'").run(this.now().toISOString(), job.job_id);
      return this.jobView(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow, source);
    }
    const updated = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow;
    return this.jobView(updated, source);
  }

  private floodWaitSeconds(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const value = error as { seconds?: unknown; retryAfterSeconds?: unknown; retry_after_seconds?: unknown; code?: unknown; message?: unknown };
    const candidate = value.seconds ?? value.retryAfterSeconds ?? value.retry_after_seconds;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 && (value.code === 'FLOOD_WAIT' || /flood[ _-]?wait/i.test(String(value.message ?? '')))) return Math.ceil(candidate);
    return undefined;
  }

  private collectPause(input: Record<string, unknown>): unknown {
    const source = this.requireSource(input.ref ?? this.sourceRef(input.ref_id));
    const now = this.now().toISOString();
    this.db.prepare('UPDATE sources SET status = ?, updated_at = ? WHERE source_id = ?').run('paused', now, source.source_id);
    const job = this.latestJob(source.source_id);
    if (job && ['queued', 'running', 'waiting'].includes(job.status)) this.db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running', 'waiting')").run(now, job.job_id);
    return this.sourceJobView(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id) as SourceRow, job ? this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow : undefined);
  }

  private collectCancel(input: Record<string, unknown>): unknown {
    const source = this.requireSource(input.ref ?? this.sourceRef(input.ref_id));
    const job = this.latestJob(source.source_id);
    if (job && ['queued', 'waiting', 'paused'].includes(job.status)) this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'waiting', 'paused')").run(this.now().toISOString(), job.job_id);
    else if (job?.status === 'running') this.db.prepare("UPDATE jobs SET status = 'cancelling', updated_at = ? WHERE job_id = ? AND status = 'running'").run(this.now().toISOString(), job.job_id);
    else if (job?.status === 'cancelling') this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'cancelling'").run(this.now().toISOString(), job.job_id);
    if (source.mode === 'personal_chat') this.db.prepare("UPDATE sources SET status = 'paused', updated_at = ? WHERE source_id = ?").run(this.now().toISOString(), source.source_id);
    return this.sourceJobView(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id) as SourceRow, job ? this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) as JobRow : undefined);
  }

  private sourceSettingsSet(input: Record<string, unknown>): unknown {
    if (typeof input.download_images !== 'boolean') throw new CoordinatorError('invalid_argument', 'download_images must be true or false');
    const source = this.requireSource(input.ref ?? this.sourceRef(input.ref_id));
    if (source.mode === 'summary') throw new CoordinatorError('invalid_argument', 'Summary-only sources are not archived');
    this.db.prepare('UPDATE sources SET download_images = ?, updated_at = ? WHERE source_id = ?').run(input.download_images ? 1 : 0, this.now().toISOString(), source.source_id);
    return this.sourceView(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id) as SourceRow);
  }

  private collectStatus(input: Record<string, unknown>): unknown {
    if (input.ref !== undefined || input.ref_id !== undefined) {
      const source = this.requireSource(input.ref ?? this.sourceRef(input.ref_id));
      return this.sourceJobView(source, this.latestJob(source.source_id));
    }
    const sources = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? ORDER BY source_id').all(this.ownerId) as SourceRow[];
    const jobs = this.db.prepare('SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at').all(this.ownerId) as JobRow[];
    const operations = this.archive.getState().operations.filter((operation) => operation.archive_id.startsWith('personal_'));
    return { sources: sources.map((source) => this.sourceJobView(source, this.latestJob(source.source_id))), jobs: jobs.map((job) => this.jobView(job, sources.find((source) => source.source_id === job.source_id))), personal_operations: operations };
  }

  private requireSource(refValue: unknown): SourceRow {
    const ref = canonicalRef(refValue);
    const source = this.db.prepare('SELECT * FROM sources WHERE owner_id = ? AND ref = ?').get(this.ownerId, ref) as SourceRow | undefined;
    if (!source) throw new CoordinatorError('source_unavailable', 'Source has not been registered', { retryable: false });
    return source;
  }

  private latestJob(sourceId: number): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_id = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1').get(this.ownerId, sourceId) as JobRow | undefined;
  }

  private sourceView(source: SourceRow): unknown {
    return { source_id: source.source_id, ref: source.ref, ref_id: this.sourceRefId(source.ref), chat_id: source.chat_id, title: source.title, name: source.title, kind: source.kind, mode: source.mode, status: source.status, download_images: source.download_images === 1 };
  }

  private addedSourceView(source: SourceRow): unknown {
    const job = source.mode === 'personal_chat' ? this.latestJob(source.source_id) : undefined;
    return { ...(this.sourceView(source) as Record<string, unknown>), ...(job ? { job: this.jobView(job, source) } : {}) };
  }

  private sourceJobView(source: SourceRow, job: JobRow | undefined): unknown {
    return { source: this.sourceView(source), ...(job ? { job: this.jobView(job, source) } : {}) };
  }

  private jobView(job: JobRow, source?: SourceRow): unknown {
    const outbox = this.archive.getState().outbox;
    return { job_id: job.job_id, ref: source?.ref, state: job.status, status: job.status, mode: job.mode, limit: job.limit_count, manifest: JSON.parse(job.manifest_json), cursor: job.cursor, counts: { saved: job.saved_count, unchanged: job.unchanged_count, skipped: job.skipped_count, errors: job.error_count }, next_attempt_at: job.next_attempt_at, last_error: jsonValue(job.last_error_json), freshness: job.updated_at, projection: { pending: outbox.filter((item) => item.status === 'pending').length, in_progress: outbox.filter((item) => item.status === 'in_progress').length, completed: outbox.filter((item) => item.status === 'completed').length }, ...(source ? { source: this.sourceView(source) } : {}) };
  }
}

const MCP_TOOL_NAMES = ['inbox_save', 'record_delete', 'source_add', 'collect_start', 'collect_pause', 'collect_cancel', 'collect_status', 'source_settings_set', 'knowledge_search', 'knowledge_read', 'web_save', 'personal_save', 'chat_access_list', 'chat_access_set', 'chat_joined', 'alerts_take', 'alerts_ack', 'digest', 'digest_commit', 'settings_set'] as const;

export function createCoordinator(options: CoordinatorOptions): Coordinator { return new Coordinator(options); }

export function createCoordinatorMcpHandler(coordinator: Coordinator, credentials?: string | Access): (request: unknown) => Promise<unknown> {
  if (typeof credentials === 'string' && credentials.trim().length === 0) throw new Error('Coordinator MCP secret is required');
  if (!credentials) throw new Error('Coordinator MCP secret is required');
  if (typeof credentials !== 'string' && typeof credentials.authenticate !== 'function') throw new Error('Coordinator MCP credentials are invalid');
  return (request) => {
    const input = request && typeof request === 'object' ? request as { id?: string | number | null; headers?: Record<string, unknown>; authorization?: unknown } : {};
    const header = input.authorization ?? input.headers?.authorization ?? input.headers?.Authorization;
    const supplied = (typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined);
    if (supplied === undefined) return Promise.resolve({ jsonrpc: '2.0', id: input.id ?? null, error: { code: -32001, message: 'Unauthorized' } });
    if (typeof credentials === 'string') {
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(credentials);
      const valid = suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
      if (!valid) return Promise.resolve({ jsonrpc: '2.0', id: input.id ?? null, error: { code: -32001, message: 'Unauthorized' } });
      return coordinator.handleMcpRequest(request);
    }
    try { return coordinator.handleMcpRequest(request, credentials.authenticate(supplied)); }
    catch { return Promise.resolve({ jsonrpc: '2.0', id: input.id ?? null, error: { code: -32001, message: 'Unauthorized' } }); }
  };
}
