import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { relative, sep } from 'node:path';
import type { Archive } from './archive.ts';

export type PrincipalRole = 'receiver' | 'talker' | 'system';
export type PrincipalArea = 'shared' | 'personal';

export interface Principal {
  readonly name: string;
  readonly role: PrincipalRole;
  readonly areas: readonly PrincipalArea[];
  readonly ownerOnly: boolean;
  readonly digest: boolean;
}

export interface Access {
  authenticate(bearer: string): Principal;
  authorize(principal: Principal, tool: string): void;
  searchTargets(principal: Principal, context: { chatId: string; personId?: string }): string[];
  canRead(principal: Principal, targetUri: string, context: { chatId: string }): boolean;
  setChatAccess(chatId: string, access: ChatAccess): void;
}

export class AccessError extends Error {
  readonly code: 'unauthorized' | 'forbidden' | 'invalid_argument';

  constructor(code: 'unauthorized' | 'forbidden' | 'invalid_argument', message: string) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
  }
}

export type ChatAccess = 'none' | 'all_shared' | string[];
type AccessOptions = {
  principals?: unknown;
  legacyToken?: string;
  ownerId?: string;
  archive?: Archive;
  sourceTargetUri?: (ref: string) => string | undefined;
};

const allSharedTargets = [
  'viking://resources/telegram/channels/',
  'viking://resources/telegram/groups/',
];

const allowedTools: Record<PrincipalRole, ReadonlySet<string>> = {
  receiver: new Set(['inbox_save', 'source_add', 'source_settings_set', 'collect_status', 'collect_pause', 'collect_cancel', 'record_delete', 'chat_access_list', 'chat_access_set', 'settings_set', 'alerts_take', 'alerts_ack']),
  talker: new Set(['knowledge_search', 'knowledge_read', 'digest', 'digest_commit', 'chat_joined']),
  system: new Set(['web_save', 'personal_save', 'search', 'knowledge_search', 'knowledge_read', 'source_add', 'source_settings_set', 'collect_start', 'collect_status', 'collect_pause', 'collect_cancel']),
};

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const isGroupChat = (chatId: string) => chatId.startsWith('-');

function validSegment(value: string): boolean {
  return value.length > 0 && !/[\\/\0?#]/.test(value);
}

export function createAccess(options: AccessOptions): Access {
  if (!options || typeof options !== 'object') throw new Error('Principal configuration is required');
  const ownerId = options.ownerId ?? 'owner';
  if (typeof ownerId !== 'string' || !validSegment(ownerId)) throw new Error('Principal ownerId is invalid');
  const entries = Array.isArray(options.principals)
    ? options.principals
    : options.principals && typeof options.principals === 'object' && Array.isArray((options.principals as { principals?: unknown }).principals)
      ? (options.principals as { principals: unknown[] }).principals
      : null;
  if (!entries || entries.length === 0) throw new Error('Principal list is invalid');

  const principalRows: Array<{ principal: Principal; digest: Buffer }> = [];
  const names = new Set<string>();
  const digests = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new Error('Principal entry is invalid');
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || item.name.trim() !== item.name || !validSegment(item.name) || item.name === 'system' || names.has(item.name)) throw new Error('Principal name is invalid or duplicated');
    if (item.role !== 'receiver' && item.role !== 'talker') throw new Error('Principal role is invalid');
    if (!Array.isArray(item.areas) || item.areas.some((area) => area !== 'shared' && area !== 'personal')) throw new Error(`Principal areas are invalid: ${item.name}`);
    if (typeof item.ownerOnly !== 'boolean' || typeof item.digest !== 'boolean') throw new Error(`Principal flags are invalid: ${item.name}`);
    if (item.role === 'talker' && (item.areas as unknown[]).includes('personal') && item.ownerOnly !== true) throw new Error(`Talker personal access must be owner-only: ${item.name}`);
    if (typeof item.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.token_sha256)) throw new Error(`Principal token digest is invalid: ${item.name}`);
    if (digests.has(item.token_sha256)) throw new Error('Principal token digest is duplicated');
    names.add(item.name);
    digests.add(item.token_sha256);
    const principal = Object.freeze({
      name: item.name,
      role: item.role,
      areas: Object.freeze([...new Set(item.areas as PrincipalArea[])]),
      ownerOnly: item.ownerOnly,
      digest: item.digest,
    }) as Principal;
    principalRows.push({ principal, digest: Buffer.from(item.token_sha256, 'hex') });
  }

  const legacyToken = options.legacyToken;
  if (typeof legacyToken !== 'string' || !legacyToken.trim()) throw new Error('Legacy system token is required');
  const systemDigest = hashToken(legacyToken);
  if (principalRows.some((row) => timingSafeEqual(row.digest, systemDigest))) throw new Error('Principal token digest conflicts with the legacy system token');
  const system: Principal = Object.freeze({ name: 'system', role: 'system', areas: Object.freeze(['shared', 'personal'] as PrincipalArea[]), ownerOnly: false, digest: false });
  principalRows.push({ principal: system, digest: systemDigest });
  const trusted = new Set(principalRows.map((row) => row.principal));

  const db = options.archive ? new DatabaseSync(options.archive.dbPath) : null;
  db?.exec('CREATE TABLE IF NOT EXISTS chat_access (chat_id TEXT PRIMARY KEY, access_json TEXT NOT NULL)');
  const memory = new Map<string, ChatAccess>();
  const chatAccess = (chatId: string): ChatAccess | undefined => {
    const raw = db?.prepare('SELECT access_json FROM chat_access WHERE chat_id = ?').get(chatId) as { access_json: string } | undefined;
    if (!raw) return memory.get(chatId);
    try {
      const value = JSON.parse(raw.access_json);
      return value === 'none' || value === 'all_shared' || (Array.isArray(value) && value.every((ref) => typeof ref === 'string')) ? value : undefined;
    } catch { return undefined; }
  };

  const resource = (path: string) => `viking://resources/${path}`;
  const personalRoot = resource(`personal/${encodeURIComponent(ownerId)}/`);
  const personalTargets = (personId?: string) => personId
    ? [resource(`personal/${encodeURIComponent(ownerId)}/people/${encodeURIComponent(personId)}/`), resource(`personal/${encodeURIComponent(ownerId)}/forwards/`)]
    : [personalRoot];
  const sourceUri = options.sourceTargetUri;

  const access: Access & { close(): void } = {
    authenticate(bearer: string): Principal {
      if (typeof bearer !== 'string' || bearer.length === 0 || /\s/.test(bearer)) throw new AccessError('unauthorized', 'Bearer token is invalid');
      const actual = hashToken(bearer);
      let match: Principal | undefined;
      for (const row of principalRows) {
        if (timingSafeEqual(actual, row.digest)) match = row.principal;
      }
      if (!match) throw new AccessError('unauthorized', 'Bearer token is not recognized');
      return match;
    },

    authorize(principal: Principal, tool: string): void {
      if (!trusted.has(principal) || !allowedTools[principal.role]?.has(tool) || ((tool === 'digest' || tool === 'digest_commit') && !principal.digest)) {
        throw new AccessError('forbidden', `${tool} is not allowed for this principal`);
      }
    },

    searchTargets(principal: Principal, context: { chatId: string; personId?: string }): string[] {
      if (!trusted.has(principal)) throw new AccessError('forbidden', 'Unknown principal');
      if (context?.personId !== undefined && !principal.areas.includes('personal')) throw new AccessError('forbidden', 'person_id requires personal access');
      // Код бота подставляет chatId до вызова MCP; модель его не задаёт. Координатор не видит Telegram, поэтому доверяет токену процесса ботов.
      const chatId = String(context?.chatId ?? '');
      if (principal.ownerOnly && chatId !== ownerId) return [];
      if (principal.role === 'system') return [...allSharedTargets, personalRoot];
      if (principal.role !== 'talker') return [];
      if (isGroupChat(chatId)) {
        if (!principal.areas.includes('shared')) return [];
        const access = chatAccess(chatId);
        if (access === 'all_shared') return [...allSharedTargets];
        if (!Array.isArray(access)) return [];
        return [...new Set(access.map((ref) => sourceUri?.(ref)).filter((uri): uri is string => typeof uri === 'string' && uri.startsWith('viking://resources/telegram/')))];
      }
      if (context.personId !== undefined) return validSegment(context.personId) ? personalTargets(context.personId) : [];
      const targets: string[] = [];
      if (principal.areas.includes('shared')) targets.push(...allSharedTargets);
      if (principal.areas.includes('personal') && (context.personId === undefined || validSegment(context.personId))) targets.push(...personalTargets(context.personId));
      return [...new Set(targets)];
    },

    canRead(principal: Principal, targetUri: string, context: { chatId: string }): boolean {
      if (!trusted.has(principal) || typeof targetUri !== 'string' || !targetUri.startsWith('viking://resources/')) return false;
      const path = targetUri.slice('viking://resources/'.length);
      if (principal.role === 'system' && (/^(?:telegram|personal)\//.test(path) || path === 'attachments/')) return true;
      if (path === 'attachments/' || path === 'attachments') return false;
      if (/^telegram\/(?:channels|groups)\//.test(path)) {
        if (!principal.areas.includes('shared')) return false;
        const chatId = String(context?.chatId ?? '');
        if (isGroupChat(chatId)) {
          const access = chatAccess(chatId);
          if (access === 'all_shared') return true;
          if (!Array.isArray(access)) return false;
          return access.some((ref) => {
            const uri = sourceUri?.(ref);
            return typeof uri === 'string' && targetUri.startsWith(uri);
          });
        }
        return true;
      }
      const ownerPrefix = `personal/${encodeURIComponent(ownerId)}/`;
      if (path.startsWith(ownerPrefix)) return principal.areas.includes('personal') && (!principal.ownerOnly || String(context?.chatId ?? '') === ownerId) && !isGroupChat(String(context?.chatId ?? ''));
      if (path.startsWith('attachments/')) {
        const archive = options.archive as any;
        if (!archive) return false;
        for (const row of archive.getState().records as Array<{ archive_id: string; path: string }>) {
          try {
            const document = archive.read(row.archive_id);
            if (document.metadata?.status === 'deleted') continue;
            const attachments = Array.isArray(document.metadata?.attachments) ? document.metadata.attachments : [];
            if (attachments.some((item: any) => item?.state === 'ready' && `viking://resources/${item.path}` === targetUri)) {
              const parentPath = relative(archive.rootDir, row.path).split(sep).join('/');
              if (this.canRead(principal, resource(parentPath), context)) return true;
            }
          } catch { /* damaged or deleted parents are not readable */ }
        }
      }
      return false;
    },

    setChatAccess(chatId: string, access: ChatAccess): void {
      if (typeof chatId !== 'string' || !chatId.trim()) throw new AccessError('invalid_argument', 'chatId is required');
      if (access !== 'none' && access !== 'all_shared' && (!Array.isArray(access) || access.some((ref) => typeof ref !== 'string' || !ref.trim()))) {
        throw new AccessError('invalid_argument', 'chat access is invalid');
      }
      const value: ChatAccess = Array.isArray(access) ? [...new Set(access)] : access;
      if (db) db.prepare('INSERT INTO chat_access (chat_id, access_json) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET access_json = excluded.access_json').run(chatId, JSON.stringify(value));
      else memory.set(chatId, value);
    },

    close(): void { db?.close(); },
  };
  return access;
}
