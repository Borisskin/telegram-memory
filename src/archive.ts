import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { basename, dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TelegramKind = 'channel' | 'group' | 'private';
export type SourceKind = 'telegram_channel' | 'telegram_group' | 'personal_chat' | 'person_profile' | 'personal_telegram' | 'personal_web';
export type AttachmentState = 'pending' | 'ready' | 'unavailable' | 'unsupported' | 'skipped';
export type FaultPoint = 'after_history' | 'before_replace' | 'after_archive' | 'after_sqlite' | 'after_external_import';

export interface AttachmentInput {
  type: string;
  name: string;
  data?: Uint8Array | string;
  size?: number;
  sha256?: string;
  state?: AttachmentState;
  mimeType?: string | null;
}

export interface TelegramInput {
  kind: TelegramKind;
  chatId: string | number | bigint;
  messageId: string | number | bigint;
  text: string;
  sourceName?: string | null;
  sourceUrl?: string | null;
  publishedAt?: string | null;
  editedAt?: string | null;
  receivedAt?: string | Date;
  attachments?: AttachmentInput[];
  status?: 'active' | 'deleted';
  deletionEvidence?: unknown;
  extra?: Record<string, unknown>;
}

export interface PersonalTelegramInput {
  ownerId?: string;
  text: string;
  operationId?: string;
  receivedAt?: string | Date;
  publishedAt?: string | null;
  sourceUrl?: string | null;
  attachments?: AttachmentInput[];
  extra?: Record<string, unknown>;
}

export interface PersonalInput extends PersonalTelegramInput {
  placement: 'notes' | 'forwards';
  fromUserId?: string | null;
  senderName?: string | null;
}

export interface WebInput {
  ownerId?: string;
  requestedUrl: string;
  finalUrl?: string;
  text: string;
  operationId?: string;
  receivedAt?: string | Date;
  retrievedAt?: string | Date;
  extra?: Record<string, unknown>;
}

export interface ArchiveOptions {
  rootDir: string;
  ownerId?: string;
  now?: () => Date;
  faultInjector?: (point: FaultPoint) => void;
  failAt?: FaultPoint;
}

export interface ArchiveResult {
  archiveId: string;
  path: string;
  revision: number;
  contentHash: string;
  created: boolean;
}

interface ParsedDocument {
  metadata: Record<string, unknown>;
  content: string;
}

interface ExistingDocument extends ParsedDocument {
  path: string;
}

interface OperationRow {
  operation_id: string;
  archive_id: string;
  path: string;
  status: string;
  received_at: string;
  payload_json: string;
  result_json: string | null;
}

interface OutboxRow {
  archive_id: string;
  revision: number;
  path: string;
  status: string;
}

export class UnknownSchemaVersionError extends Error {
  constructor(version: unknown) {
    super(`Unsupported archive schema_version: ${String(version)}`);
    this.name = 'UnknownSchemaVersionError';
  }
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function normalizeContent(value: string): string {
  const normalized = normalizeLineEndings(value);
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* keep as a string */ }
  }
  return trimmed;
}

function splitYamlComment(value: string): string {
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote === '"' && ch === '\\') { i += 1; continue; }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) quote = quote ? '' : ch;
    if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}

function yamlKey(line: string): [string, string] | null {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && ch === '\\') { i += 1; continue; }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) quote = quote ? '' : ch;
    if (ch === ':' && !quote && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key.startsWith('"') && key.endsWith('"')) return [String(parseScalar(key)), value];
      return [key, value];
    }
  }
  return null;
}

type YamlLine = { indent: number; text: string };

function parseYaml(yaml: string): Record<string, unknown> {
  const lines: YamlLine[] = normalizeLineEndings(yaml).split('\n')
    .map((line) => ({ indent: line.match(/^\s*/)?.[0].length ?? 0, text: line.trim() }))
    .filter((line) => line.text && !line.text.startsWith('#'));
  let index = 0;

  const parseBlock = (indent: number): unknown => {
    if (index >= lines.length || lines[index].indent < indent) return null;
    const sequence = lines[index].indent === indent && lines[index].text.startsWith('-');
    if (sequence) {
      const result: unknown[] = [];
      while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
        const rest = lines[index].text.slice(1).trim();
        index += 1;
        if (!rest) {
          result.push(index < lines.length && lines[index].indent > indent ? parseBlock(lines[index].indent) : null);
          continue;
        }
        const first = yamlKey(rest);
        if (!first) {
          result.push(parseScalar(splitYamlComment(rest)));
          continue;
        }
        const item: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(item, first[0], { value: first[1] ? parseScalar(splitYamlComment(first[1])) : (index < lines.length && lines[index].indent > indent ? parseBlock(lines[index].indent) : null), enumerable: true, writable: true, configurable: true });
        const childIndent = index < lines.length && lines[index].indent > indent ? lines[index].indent : indent + 2;
        while (index < lines.length && lines[index].indent === childIndent && !lines[index].text.startsWith('-')) {
          const pair = yamlKey(lines[index].text);
          if (!pair) throw new ArchiveError(`Invalid YAML mapping: ${lines[index].text}`);
          index += 1;
          Object.defineProperty(item, pair[0], { value: pair[1] ? parseScalar(splitYamlComment(pair[1])) : (index < lines.length && lines[index].indent > childIndent ? parseBlock(lines[index].indent) : null), enumerable: true, writable: true, configurable: true });
        }
        result.push(item);
      }
      return result;
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
      const pair = yamlKey(lines[index].text);
      if (!pair) throw new ArchiveError(`Invalid YAML mapping: ${lines[index].text}`);
      index += 1;
      Object.defineProperty(result, pair[0], { value: pair[1] ? parseScalar(splitYamlComment(pair[1])) : (index < lines.length && lines[index].indent > indent ? parseBlock(lines[index].indent) : null), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };

  if (!lines.length) return {};
  const result = parseBlock(lines[0].indent);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new ArchiveError('YAML front matter must be a mapping');
  return result as Record<string, unknown>;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function stringifyYaml(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (!entries.length) { lines.push(`${pad}- {}`); continue; }
        const [firstKey, firstValue] = entries[0];
        if (firstValue && typeof firstValue === 'object') {
          lines.push(`${pad}- ${firstKey}:`);
          lines.push(...stringifyYaml(firstValue, indent + 4));
        } else {
          lines.push(`${pad}- ${firstKey}: ${scalarYaml(firstValue)}`);
        }
        for (const [key, child] of entries.slice(1)) {
          if (child && typeof child === 'object') {
            lines.push(`${' '.repeat(indent + 2)}${key}:`);
            lines.push(...stringifyYaml(child, indent + 4));
          } else {
            lines.push(`${' '.repeat(indent + 2)}${key}: ${scalarYaml(child)}`);
          }
        }
      } else {
        lines.push(`${pad}- ${scalarYaml(item)}`);
      }
    }
    return lines;
  }
  if (value && typeof value === 'object') {
    const lines: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        lines.push(`${pad}${key}:`);
        lines.push(...stringifyYaml(child, indent + 2));
      } else {
        lines.push(`${pad}${key}: ${scalarYaml(child)}`);
      }
    }
    return lines;
  }
  return [`${pad}${scalarYaml(value)}`];
}

function scalarYaml(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return yamlString(String(value));
}

function parseMarkdown(raw: string): ParsedDocument {
  const normalized = normalizeLineEndings(raw).replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') throw new ArchiveError('Archive document has no YAML front matter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new ArchiveError('Archive document has an unterminated YAML front matter');
  const metadata = parseYaml(lines.slice(1, end).join('\n'));
  if (metadata.schema_version !== 1) throw new UnknownSchemaVersionError(metadata.schema_version);
  const content = normalizeContent(lines.slice(end + 1).join('\n').replace(/^\n/, ''));
  return { metadata, content };
}

function serializeMarkdown(metadata: Record<string, unknown>, content: string): string {
  return `---\n${stringifyYaml(metadata).join('\n')}\n---\n\n${normalizeContent(content)}`;
}

function asId(value: string | number | bigint, name: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ArchiveError(`${name} must not lose integer precision`);
    value = String(value);
  } else if (typeof value === 'bigint') value = value.toString();
  if (!/^-?\d+$/.test(value) || (name === 'message_id' && value.startsWith('-'))) throw new ArchiveError(`Invalid ${name}`);
  return BigInt(value).toString();
}

function safeSegment(value: string, name: string): string {
  if (!value || value === '.' || value === '..' || !/^[\p{L}\p{N}._-]+$/u.test(value)) throw new ArchiveError(`Invalid ${name}`);
  return value;
}

function iso(value: string | Date | undefined, fallback: Date): string {
  const date = value === undefined ? fallback : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ArchiveError('Invalid date');
  return date.toISOString();
}

function localStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function normalizeUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ArchiveError('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new ArchiveError('Only HTTP(S) URLs are supported');
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
  parsed.hash = '';
  return parsed.toString();
}

function relativePosix(root: string, value: string): string {
  return relative(root, value).split(sep).join('/');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function semanticHash(metadata: Record<string, unknown>, content: string): string {
  return sha256(JSON.stringify({
    content: normalizeContent(content),
    published_at: metadata.published_at ?? null,
    edited_at: metadata.edited_at ?? null,
    source_url: metadata.source_url ?? null,
    requested_url: metadata.requested_url ?? null,
    final_url: metadata.final_url ?? null,
    status: metadata.status ?? null,
    availability: metadata.availability ?? null,
    deletion_evidence: metadata.deletion_evidence ?? null,
    attachments: Array.isArray(metadata.attachments) ? metadata.attachments : [],
  }));
}

export class Archive {
  readonly rootDir: string;
  readonly dbPath: string;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly options: ArchiveOptions;
  private readonly db: any;
  private closed = false;

  constructor(options: ArchiveOptions) {
    if (!options.rootDir) throw new ArchiveError('rootDir is required');
    this.options = options;
    this.rootDir = options.rootDir;
    this.ownerId = safeSegment(options.ownerId ?? 'owner', 'owner_id');
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.rootDir, { recursive: true });
    this.dbPath = join(this.rootDir, 'state.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS archive_records (
        archive_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        archive_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (archive_id, revision)
      );
      CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, archive_id, revision);
    `);
    // Reconcile durable Markdown before serving any operation.  SQLite is only
    // an index; a crash after the atomic rename must not hide a committed file.
    this.recover();
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  saveTelegram(input: TelegramInput): ArchiveResult {
    const chatId = asId(input.chatId, 'chat_id');
    const messageId = asId(input.messageId, 'message_id');
    const sourceKind: SourceKind = input.kind === 'private' ? 'personal_chat' : input.kind === 'channel' ? 'telegram_channel' : 'telegram_group';
    const archiveId = `${sourceKind}:${chatId}:${messageId}`;
    const stored = this.db.prepare('SELECT path FROM archive_records WHERE archive_id = ?').get(archiveId) as { path: string } | undefined;
    const receivedAt = iso(input.receivedAt, this.now());
    const month = iso(input.publishedAt ?? undefined, new Date(receivedAt)).slice(0, 7);
    const path = stored?.path ?? (input.kind === 'private'
      ? join(this.rootDir, 'personal', this.ownerId, 'people', chatId, 'chat', month, `${messageId}.md`)
      : join(this.rootDir, 'telegram', input.kind === 'channel' ? 'channels' : 'groups', chatId, `${messageId}.md`));
    const metadata = {
      ...(input.extra ?? {}),
      schema_version: 1,
      archive_id: archiveId,
      revision: 1,
      source_kind: sourceKind,
      source_id: chatId,
      source_name: input.sourceName ?? null,
      chat_id: chatId,
      message_id: messageId,
      owner_id: input.kind === 'private' ? this.ownerId : null,
      ...(input.kind === 'private' ? { person_id: chatId } : {}),
      operation_id: `${sourceKind}:${chatId}:${messageId}`,
      published_at: input.publishedAt ?? null,
      edited_at: input.editedAt ?? null,
      received_at: receivedAt,
      observed_at: receivedAt,
      retrieved_at: null,
      source_url: input.sourceUrl ?? null,
      requested_url: null,
      final_url: null,
      status: input.status ?? 'active',
      availability: 'available',
      deletion_evidence: input.deletionEvidence ?? null,
      content_hash: '',
      previous_revision: null,
      previous_content_hash: null,
      attachments: [],
    } as Record<string, unknown>;
    return this.saveDocument({ archiveId, path, operationId: String(metadata.operation_id), sourceKind, receivedAt, metadata, text: input.text, attachmentInputs: input.attachments });
  }

  upsertPerson(input: { userId: string | number | bigint; name: string; username?: string | null }): ArchiveResult {
    const userId = asId(input.userId, 'user_id');
    const name = input.name.trim();
    if (!name) throw new ArchiveError('Person name is required');
    const username = input.username?.replace(/^@/, '') ?? null;
    if (username && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new ArchiveError('Invalid username');
    const path = join(this.rootDir, 'personal', this.ownerId, 'people', userId, 'profile.md');
    const current = existsSync(path) ? parseMarkdown(readFileSync(path, 'utf8')) : undefined;
    const previous = Array.isArray(current?.metadata.previous_names) ? current.metadata.previous_names.filter((item): item is string => typeof item === 'string') : [];
    if (typeof current?.metadata.source_name === 'string' && current.metadata.source_name !== name && !previous.includes(current.metadata.source_name)) previous.push(current.metadata.source_name);
    const archiveId = `person_profile:${this.ownerId}:${userId}`;
    const receivedAt = this.now().toISOString();
    return this.saveDocument({
      archiveId, path, operationId: archiveId, sourceKind: 'person_profile', receivedAt,
      metadata: { schema_version: 1, archive_id: archiveId, source_kind: 'person_profile', source_id: userId, owner_id: this.ownerId, person_id: userId, source_name: name, username, previous_names: previous, status: 'active' },
      text: `# ${name}\n${username ? `\n@${username}\n` : ''}`,
    });
  }

  markTelegramDeleted(input: { kind: TelegramKind; chatId: string | number | bigint; messageId: string | number | bigint; evidence?: unknown }): ArchiveResult {
    const chatId = asId(input.chatId, 'chat_id');
    const messageId = asId(input.messageId, 'message_id');
    const sourceKind: SourceKind = input.kind === 'private' ? 'personal_chat' : input.kind === 'channel' ? 'telegram_channel' : 'telegram_group';
    const stored = this.db.prepare('SELECT path FROM archive_records WHERE archive_id = ?').get(`${sourceKind}:${chatId}:${messageId}`) as { path: string } | undefined;
    const path = stored?.path ?? (input.kind === 'private'
      ? join(this.rootDir, 'personal', this.ownerId, 'people', chatId, 'chat', this.now().toISOString().slice(0, 7), `${messageId}.md`)
      : join(this.rootDir, 'telegram', input.kind === 'channel' ? 'channels' : 'groups', chatId, `${messageId}.md`));
    if (!existsSync(path)) return this.saveTelegram({ kind: input.kind, chatId, messageId, text: '', status: 'deleted', deletionEvidence: input.evidence });
    const current = parseMarkdown(readFileSync(path, 'utf8'));
    const metadata = { ...current.metadata, status: 'deleted', deletion_evidence: input.evidence ?? null, observed_at: this.now().toISOString() };
    const attachments = Array.isArray(current.metadata.attachments) ? current.metadata.attachments as Record<string, unknown>[] : [];
    return this.saveDocument({ archiveId: String(current.metadata.archive_id), path, operationId: String(current.metadata.operation_id), sourceKind, receivedAt: String(current.metadata.received_at), metadata, text: current.content.trimEnd(), preparedAttachments: attachments });
  }

  markPersonalDeleted(archiveId: string): ArchiveResult {
    const row = this.db.prepare('SELECT path, source_kind FROM archive_records WHERE archive_id = ?').get(archiveId) as { path: string; source_kind: SourceKind } | undefined;
    if (!row || (row.source_kind !== 'personal_telegram' && row.source_kind !== 'personal_web')) throw new ArchiveError('Personal archive record is required');
    const current = this.read(archiveId);
    if (current.metadata.owner_id !== this.ownerId) throw new ArchiveError('Personal archive owner does not match');
    if (current.metadata.status === 'deleted') return { archiveId, path: row.path, revision: Number(current.metadata.revision), contentHash: String(current.metadata.content_hash), created: false };
    const attachments = Array.isArray(current.metadata.attachments) ? current.metadata.attachments as Record<string, unknown>[] : [];
    const operationId = `record_delete:${archiveId}`;
    return this.saveDocument({
      archiveId, path: row.path, operationId, sourceKind: row.source_kind,
      receivedAt: String(current.metadata.received_at),
      metadata: { ...current.metadata, operation_id: operationId, status: 'deleted' },
      text: current.content.trimEnd(), preparedAttachments: attachments,
    });
  }

  saveTelegramAttachment(input: { kind: TelegramKind; chatId: string | number | bigint; messageId: string | number | bigint; attachment: AttachmentInput }): ArchiveResult {
    const chatId = asId(input.chatId, 'chat_id');
    const messageId = asId(input.messageId, 'message_id');
    const sourceKind: SourceKind = input.kind === 'private' ? 'personal_chat' : input.kind === 'channel' ? 'telegram_channel' : 'telegram_group';
    const stored = this.db.prepare('SELECT path FROM archive_records WHERE archive_id = ?').get(`${sourceKind}:${chatId}:${messageId}`) as { path: string } | undefined;
    const path = stored?.path ?? join(this.rootDir, 'telegram', input.kind === 'channel' ? 'channels' : 'groups', chatId, `${messageId}.md`);
    if (!existsSync(path)) throw new ArchiveError('Unknown telegram message');
    const current = parseMarkdown(readFileSync(path, 'utf8'));
    const prepared = this.prepareAttachments([input.attachment])[0];
    const existing = Array.isArray(current.metadata.attachments) ? current.metadata.attachments as Record<string, unknown>[] : [];
    const duplicate = existing.findIndex((item) => item.name === prepared.name && item.sha256 === prepared.sha256);
    const pending = existing.findIndex((item) => item.name === prepared.name && item.state !== 'ready');
    const attachments = duplicate >= 0 ? existing : pending >= 0 ? existing.map((item, index) => index === pending ? prepared : item) : [...existing, prepared];
    const metadata = { ...current.metadata, attachments };
    return this.saveDocument({ archiveId: String(current.metadata.archive_id), path, operationId: String(current.metadata.operation_id), sourceKind: String(current.metadata.source_kind) as SourceKind, receivedAt: String(current.metadata.received_at), metadata, text: current.content.trimEnd(), preparedAttachments: attachments });
  }

  savePersonalTelegram(input: PersonalTelegramInput & { forward?: { from_user_id?: string; sender_name?: string } }): ArchiveResult {
    const forward = input.forward;
    return this.savePersonal({
      ...input,
      placement: forward === undefined ? 'notes' : 'forwards',
      ...(forward ? { fromUserId: forward.from_user_id, senderName: forward.sender_name } : {}),
    });
  }

  savePersonal(input: PersonalInput): ArchiveResult {
    if (input.placement !== 'notes' && input.placement !== 'forwards') throw new ArchiveError('Invalid personal placement');
    const ownerId = safeSegment(input.ownerId ?? this.ownerId, 'owner_id');
    const operationId = input.operationId ?? randomUUID();
    const existingOperation = this.operation(operationId);
    const receivedAt = existingOperation?.received_at ?? iso(input.receivedAt, this.now());
    const stamp = localStamp(new Date(receivedAt));
    const suffix = input.placement === 'forwards' ? 'fwd' : 'tg';
    const path = existingOperation?.path ?? this.allocatePersonalPath(ownerId, input.placement, stamp, suffix);
    const archiveId = existingOperation?.archive_id ?? `personal_telegram:${ownerId}:${operationId}`;
    const metadata = {
      ...(input.extra ?? {}),
      schema_version: 1,
      archive_id: archiveId,
      revision: 1,
      source_kind: 'personal_telegram',
      source_id: ownerId,
      source_name: null,
      chat_id: null,
      message_id: null,
      owner_id: ownerId,
      operation_id: operationId,
      published_at: input.publishedAt ?? null,
      edited_at: null,
      received_at: receivedAt,
      observed_at: receivedAt,
      retrieved_at: null,
      source_url: input.sourceUrl ?? null,
      requested_url: null,
      final_url: null,
      ...(input.placement === 'forwards' ? { from_user_id: input.fromUserId || null, sender_name: input.senderName || null } : {}),
      status: 'active',
      availability: 'available',
      deletion_evidence: null,
      content_hash: '',
      previous_revision: null,
      previous_content_hash: null,
      attachments: [],
    } as Record<string, unknown>;
    return this.saveDocument({
      archiveId,
      path,
      operationId,
      sourceKind: 'personal_telegram',
      receivedAt,
      metadata,
      text: input.text,
      operationPayload: { text: input.text, placement: input.placement, fromUserId: input.fromUserId ?? null, senderName: input.senderName ?? null },
      attachmentInputs: input.attachments,
    });
  }

  saveWeb(input: WebInput): ArchiveResult {
    const ownerId = safeSegment(input.ownerId ?? this.ownerId, 'owner_id');
    const requestedUrl = normalizeUrl(input.requestedUrl);
    const finalUrl = normalizeUrl(input.finalUrl ?? input.requestedUrl);
    const urlHash = sha256(requestedUrl);
    const archiveId = `personal_web:${ownerId}:${urlHash}`;
    const operationId = input.operationId ?? `web:${ownerId}:${urlHash}`;
    const existingOperation = this.operation(operationId);
    const retrievedAt = iso(input.retrievedAt, this.now());
    const receivedAt = existingOperation?.received_at ?? iso(input.receivedAt, this.now());
    const stamp = localStamp(new Date(receivedAt));
    const path = existingOperation?.path ?? this.allocatePersonalPath(ownerId, 'notes', stamp, 'web');
    const metadata = {
      ...(input.extra ?? {}),
      schema_version: 1,
      archive_id: archiveId,
      revision: 1,
      source_kind: 'personal_web',
      source_id: ownerId,
      source_name: null,
      chat_id: null,
      message_id: null,
      owner_id: ownerId,
      operation_id: operationId,
      published_at: null,
      edited_at: null,
      received_at: receivedAt,
      observed_at: receivedAt,
      retrieved_at: retrievedAt,
      source_url: finalUrl,
      requested_url: requestedUrl,
      final_url: finalUrl,
      status: 'active',
      availability: 'available',
      deletion_evidence: null,
      content_hash: '',
      previous_revision: null,
      previous_content_hash: null,
      attachments: [],
      provenance: { requested_url: requestedUrl },
    } as Record<string, unknown>;
    return this.saveDocument({ archiveId, path, operationId, sourceKind: 'personal_web', receivedAt, metadata, text: input.text, operationPayload: { text: input.text, requestedUrl } });
  }

  read(archiveId: string): ParsedDocument {
    const row = this.db.prepare('SELECT path FROM archive_records WHERE archive_id = ?').get(archiveId) as { path: string } | undefined;
    if (!row) throw new ArchiveError(`Unknown archive_id: ${archiveId}`);
    this.assertInsideRoot(row.path, 'archive path');
    const parsed = parseMarkdown(readFileSync(row.path, 'utf8'));
    this.validateDocument(row.path, parsed);
    return parsed;
  }

  getState(): { operations: OperationRow[]; records: unknown[]; outbox: OutboxRow[] } {
    return {
      operations: this.db.prepare('SELECT operation_id, archive_id, path, status, received_at, payload_json, result_json FROM operations ORDER BY operation_id').all() as OperationRow[],
      records: this.db.prepare('SELECT archive_id, path, revision, content_hash, source_kind, updated_at FROM archive_records ORDER BY archive_id').all() as unknown[],
      outbox: this.db.prepare('SELECT archive_id, revision, path, status FROM outbox ORDER BY archive_id, revision').all() as OutboxRow[],
    };
  }

  recover(): { archives: number; operations: number; outbox: number } {
    this.assertOpen();
    let archives = 0;
    const files = this.markdownFiles(this.rootDir);
    for (const file of files) {
      this.assertInsideRoot(file, 'archive path');
      const parsed = parseMarkdown(readFileSync(file, 'utf8'));
      this.validateDocument(file, parsed);
      const metadata = parsed.metadata;
      const archiveId = String(metadata.archive_id ?? '');
      const revision = Number(metadata.revision);
      const contentHash = String(metadata.content_hash ?? '');
      const sourceKind = String(metadata.source_kind ?? '');
      const operationId = String(metadata.operation_id ?? '');
      if (!archiveId || !Number.isSafeInteger(revision) || revision < 1 || !contentHash || !sourceKind || !operationId) throw new ArchiveError(`Invalid archive metadata: ${file}`);
      const receivedAt = String(metadata.received_at ?? this.now().toISOString());
      this.transaction(() => {
        this.db.prepare(`INSERT INTO archive_records (archive_id, path, revision, content_hash, source_kind, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(archive_id) DO UPDATE SET path=excluded.path, revision=excluded.revision, content_hash=excluded.content_hash, source_kind=excluded.source_kind, updated_at=excluded.updated_at`).run(archiveId, file, revision, contentHash, sourceKind, this.now().toISOString());
        this.db.prepare('INSERT OR IGNORE INTO operations (operation_id, archive_id, path, status, received_at, payload_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(operationId, archiveId, file, 'succeeded', receivedAt, '{}', JSON.stringify({ archiveId, path: file, revision, contentHash, created: false }));
        this.db.prepare('UPDATE operations SET archive_id = ?, path = ?, status = ?, result_json = ? WHERE operation_id = ?').run(archiveId, file, 'succeeded', JSON.stringify({ archiveId, path: file, revision, contentHash, created: false }), operationId);
        this.db.prepare('INSERT OR IGNORE INTO outbox (archive_id, revision, path, status) VALUES (?, ?, ?, ?)').run(archiveId, revision, file, 'pending');
      });
      archives += 1;
    }
    this.db.prepare("UPDATE outbox SET status = 'pending' WHERE status = 'in_progress'").run();
    const operations = Number((this.db.prepare("SELECT count(*) AS count FROM operations WHERE status = 'succeeded'").get() as { count: number }).count);
    const outbox = Number((this.db.prepare("SELECT count(*) AS count FROM outbox WHERE status = 'pending'").get() as { count: number }).count);
    return { archives, operations, outbox };
  }

  claimOutbox(limit = 20, latestOnly = false): OutboxRow[] {
    if (!Number.isInteger(limit) || limit < 1) throw new ArchiveError('Invalid outbox limit');
    return this.transaction(() => {
      if (latestOnly) {
        this.db.prepare(`UPDATE outbox
          SET status = 'superseded'
          WHERE status IN ('pending', 'in_progress')
            AND EXISTS (
              SELECT 1 FROM archive_records r
              WHERE r.archive_id = outbox.archive_id
                AND r.revision > outbox.revision
            )`).run();
      }
      const query = latestOnly
        ? "SELECT o.archive_id, o.revision, o.path, o.status FROM outbox o WHERE o.status = 'pending' AND NOT EXISTS (SELECT 1 FROM archive_records r WHERE r.archive_id = o.archive_id AND r.revision > o.revision) ORDER BY o.archive_id, o.revision LIMIT ?"
        : "SELECT archive_id, revision, path, status FROM outbox WHERE status = 'pending' ORDER BY archive_id, revision LIMIT ?";
      const rows = this.db.prepare(query).all(limit) as OutboxRow[];
      for (const row of rows) this.db.prepare("UPDATE outbox SET status = 'in_progress' WHERE archive_id = ? AND revision = ? AND status = 'pending'").run(row.archive_id, row.revision);
      return rows.map((row) => ({ ...row, status: 'in_progress' }));
    });
  }

  acknowledgeProjection(archiveId: string, revision: number): 'completed' | 'superseded' {
    const row = this.db.prepare('SELECT revision, path FROM outbox WHERE archive_id = ? AND revision = ?').get(archiveId, revision) as OutboxRow | undefined;
    if (!row) throw new ArchiveError('Unknown outbox item');
    const current = this.db.prepare('SELECT revision FROM archive_records WHERE archive_id = ?').get(archiveId) as { revision: number } | undefined;
    if (!current) throw new ArchiveError('Archive record is missing');
    this.fault('after_external_import');
    const status: 'completed' | 'superseded' = current.revision > revision ? 'superseded' : 'completed';
    this.db.prepare('UPDATE outbox SET status = ? WHERE archive_id = ? AND revision = ?').run(status, archiveId, revision);
    return status;
  }

  private saveDocument(args: {
    archiveId: string;
    path: string;
    operationId: string;
    sourceKind: SourceKind;
    receivedAt: string;
    metadata: Record<string, unknown>;
    text: string;
    operationPayload?: Record<string, unknown>;
    attachmentInputs?: AttachmentInput[];
    preparedAttachments?: Record<string, unknown>[];
  }): ArchiveResult {
    this.assertOpen();
    this.assertInsideRoot(args.path, 'archive path');
    mkdirSync(dirname(args.path), { recursive: true });
    const current = existsSync(args.path) ? { ...parseMarkdown(readFileSync(args.path, 'utf8')), path: args.path } as ExistingDocument : undefined;
    if (current) this.validateDocument(args.path, current);
    if (current && String(current.metadata.archive_id) !== args.archiveId) throw new ArchiveError('Path already belongs to another archive record');
    const operation = this.ensureOperation(args, args.operationPayload ?? { text: args.text });
    if (operation && operation.archive_id !== args.archiveId) throw new ArchiveError('operation_id is already bound to another archive record');
    if (operation?.status === 'succeeded' && operation.result_json && args.sourceKind === 'personal_telegram' && args.metadata.status !== 'deleted') return JSON.parse(operation.result_json) as ArchiveResult;
    args.metadata.attachments = args.preparedAttachments ?? this.prepareAttachments(args.attachmentInputs ?? []);
    const attachments = Array.isArray(args.metadata.attachments) ? args.metadata.attachments : [];
    const semantic = {
      content: normalizeContent(args.text),
      published_at: args.metadata.published_at ?? null,
      edited_at: args.metadata.edited_at ?? null,
      source_url: args.metadata.source_url ?? null,
      requested_url: args.metadata.requested_url ?? null,
      final_url: args.metadata.final_url ?? null,
      status: args.metadata.status ?? null,
      availability: args.metadata.availability ?? null,
      deletion_evidence: args.metadata.deletion_evidence ?? null,
      attachments,
    };
    const contentHash = sha256(JSON.stringify(semantic));
    if (current && String(current.metadata.content_hash) === contentHash && current.content === normalizeContent(args.text)) {
      const result: ArchiveResult = { archiveId: args.archiveId, path: args.path, revision: Number(current.metadata.revision), contentHash, created: false };
      this.recordSuccess(args, result, result.revision);
      return result;
    }
    const revision = current ? Number(current.metadata.revision) + 1 : 1;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ArchiveError('Invalid previous revision');
    const metadata: Record<string, unknown> = {
      ...(current?.metadata ?? {}),
      ...args.metadata,
      schema_version: 1,
      archive_id: args.archiveId,
      revision,
      operation_id: args.operationId,
      received_at: current?.metadata.received_at ?? args.receivedAt,
      observed_at: args.receivedAt,
      content_hash: contentHash,
      previous_revision: current ? Number(current.metadata.revision) : null,
      previous_content_hash: current ? String(current.metadata.content_hash) : null,
      attachments,
    };
    const bytes = serializeMarkdown(metadata, args.text);
    const tempPath = `${args.path}.tmp-${randomUUID()}`;
    writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx' });
    const fd = openSync(tempPath, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const verified = parseMarkdown(readFileSync(tempPath, 'utf8'));
    if (verified.metadata.schema_version !== 1 || verified.metadata.content_hash !== contentHash || verified.content !== normalizeContent(args.text) || semanticHash(verified.metadata, verified.content) !== contentHash) throw new ArchiveError('Archive temporary file verification failed');
    if (current) {
      const historyDir = join(dirname(args.path), '.history');
      mkdirSync(historyDir, { recursive: true });
      const priorBytes = readFileSync(args.path);
      const historyPath = join(historyDir, `${basename(args.path, '.md')}.r${current.metadata.revision}-${sha256(priorBytes).slice(0, 12)}.md`);
      if (!existsSync(historyPath)) copyFileSync(args.path, historyPath);
      this.fault('after_history');
    }
    this.fault('before_replace');
      renameSync(tempPath, args.path);
      this.syncDirectory(dirname(args.path));
    this.fault('after_archive');
    const result: ArchiveResult = { archiveId: args.archiveId, path: args.path, revision, contentHash, created: !current };
    this.recordSuccess(args, result, revision);
    this.fault('after_sqlite');
    return result;
  }

  private prepareAttachments(inputs: AttachmentInput[]): Record<string, unknown>[] {
    return inputs.map((input) => {
      const name = input.name || 'attachment.bin';
      if (input.state === 'unsupported' || input.state === 'unavailable' || input.state === 'skipped' || input.data === undefined) {
        return { type: input.type, name: input.state === 'skipped' ? input.name ?? '' : name, size: input.size ?? null, path: null, sha256: input.sha256 ?? null, state: input.state ?? 'unavailable', ...(input.mimeType ? { mime_type: input.mimeType } : {}) };
      }
      const bytes = typeof input.data === 'string' ? Buffer.from(input.data) : Buffer.from(input.data);
      const digest = sha256(bytes);
      if (input.size !== undefined && input.size !== bytes.byteLength) throw new ArchiveError(`Attachment size mismatch: ${name}`);
      if (input.sha256 !== undefined && input.sha256.toLowerCase() !== digest) throw new ArchiveError(`Attachment hash mismatch: ${name}`);
      const extension = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12) || '.bin';
      const attachmentDir = join(this.rootDir, 'attachments');
      mkdirSync(attachmentDir, { recursive: true });
      const existing = readdirSync(attachmentDir).find((entry) => entry.startsWith(`${digest}.`) && !entry.includes('.tmp-'));
      const file = join(attachmentDir, existing ?? `${digest}${extension}`);
      this.assertInsideRoot(file, 'attachment path');
      if (!existsSync(file)) {
        const temp = `${file}.tmp-${randomUUID()}`;
        writeFileSync(temp, bytes, { flag: 'wx' });
        const fd = openSync(temp, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        if (statSync(temp).size !== bytes.byteLength || sha256(readFileSync(temp)) !== digest) throw new ArchiveError('Attachment verification failed');
        renameSync(temp, file);
      } else if (statSync(file).size !== bytes.byteLength || sha256(readFileSync(file)) !== digest) {
        throw new ArchiveError('Attachment hash collision or corrupt file');
      }
      return { type: input.type, name, size: bytes.byteLength, path: relativePosix(this.rootDir, file), sha256: digest, state: 'ready', ...(input.mimeType ? { mime_type: input.mimeType } : {}) };
    });
  }

  private allocatePersonalPath(ownerId: string, placement: 'notes' | 'forwards', stamp: string, suffix: string): string {
    const dir = join(this.rootDir, 'personal', ownerId, placement);
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      const candidate = `${stamp}_${suffix}${index ? `_${String(index).padStart(2, '0')}` : ''}.md`;
      const path = join(dir, candidate);
      if (!existsSync(path) && !this.db.prepare('SELECT 1 FROM operations WHERE path = ?').get(path)) return path;
    }
    throw new ArchiveError('name_exhausted');
  }

  private operation(operationId: string): OperationRow | undefined {
    return this.db.prepare('SELECT operation_id, archive_id, path, status, received_at, payload_json, result_json FROM operations WHERE operation_id = ?').get(operationId) as OperationRow | undefined;
  }

  private ensureOperation(args: { archiveId: string; path: string; operationId: string; receivedAt: string; metadata: Record<string, unknown> }, payload: Record<string, unknown>): OperationRow | undefined {
    const existing = this.operation(args.operationId);
    if (existing) return existing;
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO operations (operation_id, archive_id, path, status, received_at, payload_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(args.operationId, args.archiveId, args.path, 'pending', args.receivedAt, JSON.stringify(cloneJson(payload)), null);
    });
    return this.operation(args.operationId);
  }

  private recordSuccess(args: { archiveId: string; path: string; operationId: string; sourceKind: SourceKind; receivedAt: string }, result: ArchiveResult, revision: number): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO archive_records (archive_id, path, revision, content_hash, source_kind, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(archive_id) DO UPDATE SET path=excluded.path, revision=excluded.revision, content_hash=excluded.content_hash, source_kind=excluded.source_kind, updated_at=excluded.updated_at`).run(args.archiveId, args.path, revision, result.contentHash, args.sourceKind, this.now().toISOString());
      this.db.prepare('INSERT OR IGNORE INTO outbox (archive_id, revision, path, status) VALUES (?, ?, ?, ?)').run(args.archiveId, revision, args.path, 'pending');
      this.db.prepare('UPDATE operations SET status = ?, result_json = ? WHERE operation_id = ?').run('succeeded', JSON.stringify(result), args.operationId);
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private markdownFiles(root: string): string[] {
    const result: string[] = [];
    const stack = [root];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.history' || entry.name === 'attachments' || entry.name === 'recovery') continue;
        const path = join(current, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
      }
    }
    return result;
  }

  private assertInsideRoot(path: string, label: string): void {
    const root = resolvePath(this.rootDir);
    const target = resolvePath(path);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(prefix)) throw new ArchiveError(`${label} escapes archive root`);
  }

  private validateDocument(path: string, parsed: ParsedDocument): void {
    this.assertInsideRoot(path, 'archive path');
    const metadata = parsed.metadata;
    if (metadata.content_hash !== semanticHash(metadata, parsed.content)) throw new ArchiveError(`Archive content verification failed: ${path}`);
    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const item of attachments) {
      if (!item || typeof item !== 'object') throw new ArchiveError(`Invalid attachment metadata: ${path}`);
      const attachment = item as Record<string, unknown>;
      if (attachment.path === null || attachment.path === undefined) continue;
      if (typeof attachment.path !== 'string' || attachment.path.startsWith('/') || attachment.path.includes('\\')) throw new ArchiveError(`Invalid attachment path: ${path}`);
      const fullPath = join(this.rootDir, attachment.path);
      this.assertInsideRoot(fullPath, 'attachment path');
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) throw new ArchiveError(`Missing attachment: ${attachment.path}`);
      if (typeof attachment.sha256 === 'string' && sha256(readFileSync(fullPath)) !== attachment.sha256) throw new ArchiveError(`Corrupt attachment: ${attachment.path}`);
    }
  }

  private syncDirectory(path: string): void {
    try {
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch {
      // Directory fsync is not available on every supported host (notably
      // Windows); the file itself was already fsynced before rename.
    }
  }

  private fault(point: FaultPoint): void {
    if (this.options.failAt === point) throw new ArchiveError(`Injected failure at ${point}`);
    this.options.faultInjector?.(point);
  }

  private assertOpen(): void {
    if (this.closed) throw new ArchiveError('Archive is closed');
  }
}

export function createArchive(options: ArchiveOptions): Archive {
  return new Archive(options);
}
