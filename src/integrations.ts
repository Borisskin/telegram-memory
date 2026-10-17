import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve as resolvePath, relative, sep, isAbsolute } from 'node:path';
import { URL } from 'node:url';
import { ArchiveError, type Archive, type AttachmentInput, type TelegramKind } from './archive.ts';
import type { Principal } from './access.ts';
import { clipHtml, type ClipResult } from './clipper.ts';
import { openVikingFileType } from './formats.ts';

type AccessContext = { principal: Principal; chatId: string; personId?: string; targets?: string[]; canRead: (targetUri: string) => boolean };
type Deps = { archive: Archive; openViking: any; resolveHost: (host: string) => Promise<string[]>; fetchPage: (url: string, opts?: any) => Promise<any>; tokenSecret: string|Uint8Array; now?: () => Date; ownerId?: string; sourceExists?: (ref: string) => boolean|Promise<boolean>; sourceTargetUri?: (ref: string) => string|Promise<string>; clipper?: (html: string, url: string) => Promise<ClipResult> | ClipResult };
const ok = (data: any) => ({ contract_version: 1, success: true, data });
const bad = (error: string, message?: string) => ({ contract_version: 1, success: false, error, ...(message ? { message } : {}) });
function projectedTarget(rootDir: unknown, archivePath: unknown) {
  if (typeof archivePath !== 'string' || !archivePath) throw new Error('archive path is required');
  const root = resolvePath(String(rootDir ?? '.'));
  const path = resolvePath(root, archivePath.replaceAll('\\', '/'));
  const relativePath = relative(root, path);
  if (path === root || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('projection path escapes archive root');
  return { path, uri: `viking://resources/${relativePath.split(sep).join('/')}` };
}
function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const v = isIP(s);
  if (v === 4) {
    const parts = s.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
    return s;
  }
  return v === 6 ? s : null;
}
function unsafe(ip: unknown) {
  const s = normalizeAddress(ip);
  if (!s) return true;
  const v = isIP(s);
  if (v === 4) {
    const a = s.split('.').map(Number);
    return a[0] === 10 || a[0] === 127 || a[0] === 0 || (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168);
  }
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped && unsafe(mapped)) return true;
  return s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd');
}
function checkUrl(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return null;
    u.hash = '';
    return u;
  } catch { return null; }
}
export class Stage3Service {
  private d: Deps;
  constructor(d: Deps) {
    if (!d || !d.archive || !d.openViking || typeof d.resolveHost !== 'function' || typeof d.fetchPage !== 'function') throw new Error('integration dependencies are required');
    if (!d.tokenSecret || (typeof d.tokenSecret === 'string' && d.tokenSecret.length === 0) || (d.tokenSecret instanceof Uint8Array && d.tokenSecret.byteLength === 0)) throw new Error('MCP token secret is required');
    this.d = d;
  }
  async callTool(name: string, args: any = {}, accessContext?: AccessContext) { try { if (name === 'web_save') return await this.webSave(args); if (name === 'knowledge_search') return await this.knowledgeSearch(args, false, accessContext); if (name === 'search') return await this.knowledgeSearch({ query: '', limit: 20, scope: 'all', ...args }, true, accessContext); if (name === 'knowledge_read') return await this.knowledgeRead(args, accessContext); if (name === 'read') return await this.knowledgeRead(args, accessContext); if (name === 'personal_save') return await this.personalSave(args); if (name === 'telegram_observe') return await this.telegramObserve(args); if (name === 'telegram_delete') return await this.telegramDelete(args); if (name === 'telegram_attachment') return await this.telegramAttachment(args); if (name === 'projection_run') return await this.projectionRun(args); return bad('unknown_tool'); } catch (e: any) { return bad(e instanceof ArchiveError && e.message === 'name_exhausted' ? 'name_exhausted' : 'upstream_unavailable', e?.message); } }
  async handleMcpRequest(req: any, accessContext?: AccessContext) { return this.callTool(req?.name ?? req?.method, req?.arguments ?? req?.args ?? {}, accessContext); }
  private async resolveSafe(host: string): Promise<string[]> {
    const direct = normalizeAddress(host);
    if (direct) return unsafe(direct) ? [] : [direct];
    let ips: string[];
    try { ips = await this.d.resolveHost(host); } catch { return []; }
    if (!Array.isArray(ips) || ips.length === 0) return [];
    const valid = ips.map(normalizeAddress).filter((ip): ip is string => ip !== null);
    return valid.length === ips.length && valid.every((ip) => !unsafe(ip)) ? valid : [];
  }

  private async fetchWithRedirects(start: URL): Promise<{ page: any; final: URL }> {
    let current = start;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const ips = await this.resolveSafe(current.hostname);
      if (!ips.length) throw new Error('unsafe_url');
      const selected = ips[0];
      let page: any;
      try {
        page = await Promise.race([
          this.d.fetchPage(current.href, { redirect: 'manual', maxRedirects: 0, address: selected, resolvedAddresses: ips }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
        ]);
      } catch (error) {
        if (error instanceof Error && error.message === 'timeout') throw error;
        throw new Error('timeout');
      }
      if (page?.remoteAddress !== undefined && (unsafe(page.remoteAddress) || normalizeAddress(page.remoteAddress) !== selected)) throw new Error('unsafe_url');
      if (Number(page?.status) >= 300 && Number(page?.status) < 400) {
        const location = page.headers?.location ?? page.headers?.Location ?? page.location;
        const next = location ? checkUrl(new URL(String(location), current.href).href) : null;
        if (!next || redirects >= 5) throw new Error('unsafe_url');
        current = next;
        continue;
      }
      const reported = page?.finalUrl ? checkUrl(String(page.finalUrl)) : current;
      if (!reported) throw new Error('unsafe_url');
      if (reported.href !== current.href) {
        const nextIps = await this.resolveSafe(reported.hostname);
        if (!nextIps.length) throw new Error('unsafe_url');
        // Treat a finalUrl supplied by a fetcher as a redirect: the next
        // connection gets its own DNS/IP check instead of trusting the first.
        current = reported;
        continue;
      }
      return { page, final: current };
    }
    throw new Error('unsafe_url');
  }

  private async webSave(a: any) {
    const u = checkUrl(a.url);
    if (!u) return bad('unsafe_url');
    let fetched: { page: any; final: URL };
    try { fetched = await this.fetchWithRedirects(u); } catch (error) {
      return bad(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unsafe_url');
    }
    const { page, final } = fetched;
    if (Number(page?.status) >= 400) return bad('upstream_unavailable');
    const body = String(page?.body ?? '');
    // Keep the initial bounded profile conservative; it is below the 10 MiB
    // protocol ceiling and avoids buffering a large page in the worker.
    if (Buffer.byteLength(body, 'utf8') > 5 * 1024 * 1024) return bad('content_too_large');
    const ct = String(page?.headers?.['content-type'] ?? page?.headers?.['Content-Type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(ct)) return bad('unsupported_content');
    if (/javascript_required/i.test(body)) return bad('javascript_required');
    let clipped: ClipResult;
    try {
      clipped = this.d.clipper ? await this.d.clipper(body, final.href) : await clipHtml(body, final.href);
    } catch { return bad('extraction_failed'); }
    const text = String(clipped.content ?? clipped.markdown ?? '').trim();
    if (!text) return bad('empty_article');
    const fetchedAt = (this.d.now ?? (() => new Date()))().toISOString();
    const r = await (this.d.archive as any).saveWeb({ ownerId: this.d.ownerId ?? 'owner', requestedUrl: u.href, finalUrl: final.href, text, retrievedAt: fetchedAt, extra: { fetched_at: fetchedAt, ...(clipped.title ? { title: clipped.title } : {}) } });
    return ok(r);
  }

  private async personalSave(a: any) {
    if (typeof a.text !== 'string' || a.text.length === 0) return bad('invalid_argument', 'text is required');
    if (a.attachments !== undefined) return bad('unsupported_attachment');
    const forward = a.forward;
    if (forward !== undefined && (!forward || typeof forward !== 'object' || Array.isArray(forward))) return bad('invalid_argument', 'forward must be an object');
    if (forward?.from_user_id !== undefined && typeof forward.from_user_id !== 'string') return bad('invalid_argument', 'forward.from_user_id must be a string');
    if (forward?.sender_name !== undefined && typeof forward.sender_name !== 'string') return bad('invalid_argument', 'forward.sender_name must be a string');
    const operationId = typeof a.operation_id === 'string' && a.operation_id ? a.operation_id : randomUUID();
    const result = await (this.d.archive as any).savePersonal({
      ownerId: this.d.ownerId ?? 'owner',
      text: a.text,
      operationId,
      placement: forward ? 'forwards' : 'notes',
      ...(forward ? {
        fromUserId: typeof forward.from_user_id === 'string' ? forward.from_user_id || null : null,
        senderName: typeof forward.sender_name === 'string' ? forward.sender_name || null : null,
      } : {}),
      sourceUrl: a.source_url,
      extra: a.extra,
    });
    return ok({ ...result, operation_id: operationId });
  }

  private async scopeUris(scope: string, ref?: string): Promise<string[]> {
    const owner = this.d.ownerId ?? 'owner';
    if (scope === 'personal') return [`viking://resources/personal/${owner}/`];
    if (scope === 'all_telegram') return ['viking://resources/telegram/channels/', 'viking://resources/telegram/groups/'];
    if (scope === 'all') return ['viking://resources/telegram/channels/', 'viking://resources/telegram/groups/', `viking://resources/personal/${owner}/`];
    if (scope === 'source') {
      if (!ref || !this.d.sourceExists) throw new Error('unknown_source');
      return [this.d.sourceTargetUri ? await this.d.sourceTargetUri(ref) : `viking://resources/telegram/source/${encodeURIComponent(ref)}/`];
    }
    throw new Error('invalid_scope');
  }

  private async knowledgeSearch(a: any, legacy = false, accessContext?: AccessContext) {
    const restricted = accessContext?.principal.role === 'talker';
    if (!legacy && (typeof a.query !== 'string' || !a.query.trim())) return bad('invalid_argument', 'query is required');
    if (!restricted && (!Object.hasOwn(a, 'scope') || typeof a.scope !== 'string')) return bad('invalid_scope');
    const limit = Number(a.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) return bad('invalid_argument', 'limit must be between 1 and 20');
    const scope = restricted ? 'all' : a.scope as string;
    const sourceRef = legacy ? a.source : a.ref;
    if (!restricted && scope === 'source' && !this.d.sourceExists) return bad(legacy ? 'configuration_error' : 'unknown_source');
    if (!restricted && scope === 'source' && (typeof sourceRef !== 'string' || !(await this.d.sourceExists!(sourceRef)))) return bad('unknown_source');
    let uris: string[];
    try { uris = restricted ? accessContext?.targets ?? [] : await this.scopeUris(scope, typeof sourceRef === 'string' ? sourceRef : undefined); } catch (error) { return bad(error instanceof Error && error.message === 'unknown_source' ? 'unknown_source' : 'invalid_scope'); }
    let data: any[] = [];
    try {
      const targets = legacy ? [uris.length === 1 ? uris[0] : uris] : uris;
      for (const target_uri of targets) {
        const part = await this.d.openViking.search({ query: a.query, scope, limit, mode: 'list', target_uri });
        if (Array.isArray(part)) data.push(...part.map((item) => ({ ...(item && typeof item === 'object' ? item : { value: item }), scope, target_uri: item?.target_uri ?? item?.uri ?? (typeof target_uri === 'string' && !accessContext ? target_uri : undefined) })));
        else {
          const text = (part?.content ?? []).filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n');
          const found = text.match(/viking:\/\/resources\/[^\s<>"'`\])}]+/g) ?? [];
          for (const uri of found) {
            const target = uri.replace(/[),.;!?]+$/, '');
            if (!data.some((item) => item.target_uri === target)) data.push({ scope, target_uri: target });
          }
        }
      }
    } catch { return bad('upstream_unavailable'); }
    const now = Math.floor((this.d.now ?? (() => new Date()))().getTime() / 1000);
    const results: any[] = [];
    for (const item of data) {
      let targetUri = String(item.target_uri ?? '');
      let resource = targetUri ? this.archiveResource(targetUri, accessContext) : undefined;
      if (accessContext && !resource) {
        const archiveId = String(item.archive_id ?? item.archiveId ?? item.id ?? '');
        const local = archiveId ? this.archiveResourceById(archiveId, accessContext) : undefined;
        if (local) { targetUri = local.uri; resource = local; }
      }
      if (accessContext && (!targetUri || !accessContext.canRead(targetUri))) continue;
      if (accessContext && !resource) continue;
      if (accessContext?.personId && targetUri.includes('/forwards/')) {
        // ponytail: постфильтр может вернуть меньше limit; при необходимости запрашивать больше пересылок или добавить индексный фильтр.
        const metadata = resource ? (this.d.archive as any).read(resource.archiveId).metadata : undefined;
        if (String(metadata?.from_user_id ?? metadata?.fromUserId ?? '') !== accessContext.personId) continue;
      }
      const archiveId = String(resource?.archiveId ?? item.archive_id ?? item.archiveId ?? item.id ?? '');
      if (!archiveId) continue;
      const revision = resource?.revision ?? (Number.isSafeInteger(item.revision) ? item.revision : Number(item.version ?? 1));
      const readToken = makeReadToken(this.d.ownerId ?? 'owner', archiveId, now + 15 * 60, this.d.tokenSecret, targetUri || undefined, revision, scope, accessContext ? { principalName: accessContext.principal.name, chatId: accessContext.chatId } : undefined);
      results.push({ ...item, archive_id: archiveId, revision, scope, target_uri: targetUri || item.target_uri, read_token: readToken });
      if (results.length >= limit) break;
    }
    const outbox = (this.d.archive as any).getState().outbox;
    return ok({ results, freshness: { pending: outbox.filter((x: any) => x.status === 'pending' || x.status === 'in_progress').length } });
  }

  private archiveResource(targetUri: string, accessContext?: AccessContext): { archiveId: string; revision: number } | undefined {
    const archive: any = this.d.archive;
    const state = archive.getState();
    if (!Array.isArray(state.records)) return undefined;
    for (const row of state.records as Array<{ archive_id: string; path: string; revision: number }>) {
      const pathUri = `viking://resources/${relative(archive.rootDir, row.path).split(sep).join('/')}`;
      try {
        const document = archive.read(row.archive_id);
        if (document.metadata?.status === 'deleted') continue;
        if (pathUri === targetUri) {
          if (accessContext && !accessContext.canRead(pathUri)) continue;
          return { archiveId: row.archive_id, revision: Number(row.revision) };
        }
        const attachments = Array.isArray(document.metadata?.attachments) ? document.metadata.attachments : [];
        if (attachments.some((item: any) => item?.state === 'ready' && `viking://resources/${item.path}` === targetUri)) {
          if (accessContext && !accessContext.canRead(pathUri)) continue;
          return { archiveId: row.archive_id, revision: Number(row.revision) };
        }
      } catch { /* unreadable records cannot produce read tokens */ }
    }
    return undefined;
  }

  private archiveResourceById(archiveId: string, accessContext?: AccessContext): { archiveId: string; revision: number; uri: string } | undefined {
    const archive: any = this.d.archive;
    const state = archive.getState();
    if (!Array.isArray(state.records)) return undefined;
    const row = (state.records as Array<{ archive_id: string; path: string; revision: number }>).find((item) => item.archive_id === archiveId);
    if (!row) return undefined;
    try {
      if (archive.read(archiveId).metadata?.status === 'deleted') return undefined;
    } catch { return undefined; }
    const uri = `viking://resources/${relative(archive.rootDir, row.path).split(sep).join('/')}`;
    if (accessContext && !accessContext.canRead(uri)) return undefined;
    return { archiveId, revision: Number(row.revision), uri };
  }

  private async knowledgeRead(a: any, accessContext?: AccessContext) {
    const parts = String(a.read_token ?? '').split('.');
    if (parts.length !== 2) return bad('invalid_token');
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const sig = createHmac('sha256', this.d.tokenSecret).update(parts[0]).digest('base64url');
      if (sig.length !== parts[1].length || !timingSafeEqual(Buffer.from(sig), Buffer.from(parts[1]))) return bad('invalid_token');
    } catch { return bad('invalid_token'); }
    const now = Math.floor((this.d.now ?? (() => new Date()))().getTime() / 1000);
    if (payload.ownerId !== (this.d.ownerId ?? 'owner') || typeof payload.archiveId !== 'string' || !payload.archiveId || /[\\/]/.test(payload.archiveId) || !Number.isSafeInteger(payload.exp) || payload.exp <= now) return bad('invalid_token');
    if (payload.targetUri !== undefined && (typeof payload.targetUri !== 'string' || !/^viking:\/\/resources\/(?:telegram|personal|attachments)\//.test(payload.targetUri))) return bad('invalid_token');
    if (payload.revision !== undefined && !Number.isSafeInteger(payload.revision)) return bad('invalid_token');
    if (accessContext) {
      if (payload.principalName !== accessContext.principal.name || payload.chatId !== accessContext.chatId || !payload.targetUri || !accessContext.canRead(payload.targetUri)) return bad('invalid_token');
      const resource = this.archiveResource(payload.targetUri, accessContext);
      if (!resource || resource.archiveId !== payload.archiveId) return bad('invalid_token');
    }
    if (!accessContext && (payload.principalName !== undefined || payload.chatId !== undefined)) return bad('invalid_token');
    try {
      if (typeof (this.d.archive as any).read === 'function') {
        const document = (this.d.archive as any).read(payload.archiveId);
        const actualRevision = Number(document.metadata?.revision ?? 1);
        return ok({ ...document, archive_id: payload.archiveId, revision: actualRevision, stale: payload.revision !== undefined && payload.revision !== actualRevision });
      }
      return ok(await this.d.openViking.read(payload.archiveId));
    } catch { return bad('upstream_unavailable'); }
  }
  private async telegramObserve(a: any) { const state = String(a.state ?? a.status ?? a.observation ?? a.result ?? 'present'); if (['not_found', 'empty_page', 'access_lost'].includes(state)) return ok({ state, deleted: false, changed: false, archive_id: a.archive_id ?? null }); const kind = this.telegramKind(a); const [chatId, messageId] = this.telegramIds(a); if (!kind || chatId === undefined || messageId === undefined) return bad('invalid_telegram_message'); const result = await (this.d.archive as any).saveTelegram({ ...a, kind, chatId, messageId, text: String(a.text ?? '') }); return ok({ state: 'present', deleted: false, changed: result.created || result.revision > 1, archive_id: result.archiveId, ...result }); }
  private async telegramDelete(a: any) { const state = String(a.state ?? a.status ?? a.observation ?? a.result ?? 'present'); if (['not_found', 'empty_page', 'access_lost'].includes(state) || a.explicit_deleted !== true) return ok({ state: ['not_found', 'empty_page', 'access_lost'].includes(state) ? state : 'not_deleted', deleted: false, changed: false, archive_id: a.archive_id ?? null }); const kind = this.telegramKind(a); const [chatId, messageId] = this.telegramIds(a); if (!kind || chatId === undefined || messageId === undefined) return bad('invalid_telegram_message'); const archive: any = this.d.archive; const result = typeof archive.markTelegramDeleted === 'function' ? await archive.markTelegramDeleted({ kind, chatId, messageId, evidence: a.evidence ?? a.deletion_evidence }) : await this.markDeletedFallback({ ...a, chatId, messageId }, kind); let excerpt = ''; try { excerpt = String((await archive.read(result.archiveId)).content ?? '').trim().slice(0, 280); } catch { /* tombstones without a prior record have no excerpt */ } return ok({ state: 'deleted', deleted: true, excerpt, archive_id: result.archiveId, ...result }); }
  private async markDeletedFallback(a: any, kind: TelegramKind) { const archive: any = this.d.archive; const sourceKind = kind === 'private' ? 'personal_chat' : kind === 'channel' ? 'telegram_channel' : 'telegram_group'; const current = await archive.read(`${sourceKind}:${a.chatId}:${a.messageId}`); return archive.saveTelegram({ ...a, kind, text: String(current.content ?? '').trimEnd(), status: 'deleted', deletionEvidence: a.evidence ?? a.deletion_evidence ?? null }); }
  private async telegramAttachment(a: any) { const type = this.attachmentType(a); if (!type) return bad('unsupported_media'); const state = String(a.state ?? (a.complete === false ? 'pending' : 'ready')); if (state === 'incomplete' || (state === 'pending' && a.complete === false && a.bytes === undefined && a.base64 === undefined && a.data === undefined)) return ok({ state: state === 'pending' ? 'pending' : 'incomplete', ready: false, changed: false, archive_id: a.archive_id ?? null }); const attachment: AttachmentInput = { type, name: String(a.name ?? a.file_name ?? 'attachment.bin'), size: a.size === undefined ? undefined : Number(a.size), sha256: a.sha256, mimeType: a.mime_type ?? a.mimeType ?? null, ...(state === 'pending' ? { state: 'pending' as const } : { data: this.attachmentBytes(a) }) }; if (state !== 'pending' && attachment.data === undefined) return bad('incomplete_attachment'); if (state !== 'pending' && (!Number.isSafeInteger(attachment.size) || !attachment.sha256)) return bad('invalid_attachment_metadata'); const kind = this.telegramKind(a); const [chatId, messageId] = this.telegramIds(a); if (chatId === undefined || messageId === undefined || !kind) return bad('invalid_telegram_message'); const archive: any = this.d.archive; let result; try { if (typeof archive.saveTelegramAttachment === 'function') result = await archive.saveTelegramAttachment({ kind, chatId, messageId, attachment }); else { const id = `${kind === 'channel' ? 'telegram_channel' : 'telegram_group'}:${chatId}:${messageId}`; const current = await archive.read(id); result = await archive.saveTelegram({ kind, chatId, messageId, text: String(current.content ?? '').trimEnd(), attachments: [attachment] }); } } catch (e: any) { return bad(/hash|size/i.test(String(e?.message)) ? 'attachment_mismatch' : 'attachment_unavailable', e?.message); } return ok({ archive_id: result.archiveId, attachment: { name: attachment.name, type, state, ready: state === 'ready', size: attachment.size, sha256: attachment.sha256 }, ...result }); }
  private async projectionRun(a: any) {
    const archive: any = this.d.archive;
    const state = archive.getState();
    const current = new Map((state.records ?? []).map((record: any) => [record.archive_id, Number(record.revision)]));
    if (!current.size) for (const row of state.outbox ?? []) current.set(row.archive_id, Number(row.revision));
    const rows = (state.outbox ?? []).filter((row: any) => (row.status === 'pending' || row.status === 'in_progress') && current.get(row.archive_id) === Number(row.revision));
    const pending = rows.filter((row: any) => row.status === 'pending');
    const claimed = typeof archive.claimOutbox === 'function' && pending.length ? archive.claimOutbox(pending.length, true) : pending;
    const work = [...claimed, ...rows.filter((row: any) => row.status === 'in_progress')]
      .filter((row, i, list) => current.get(row.archive_id) === Number(row.revision) && list.findIndex((x) => x.archive_id === row.archive_id && x.revision === row.revision) === i);
    const results: any[] = [];
    for (const row of work) {
      try {
        const parsed = await archive.read(row.archive_id);
        const metadata = parsed.metadata ?? {};
        const target = projectedTarget(archive.rootDir, row.path);
        // Include revision and content hash: the same archive operation may
        // legitimately produce A-B-A and each latest revision is distinct.
        const key = `${row.archive_id}:${row.revision}:${metadata.content_hash ?? ''}`;
        const operation = { archiveId: row.archive_id, revision: row.revision, idempotencyKey: key, operationId: metadata.operation_id ?? null };
        if (metadata.status === 'deleted') {
          const remove = this.d.openViking.delete ?? this.d.openViking.remove ?? this.d.openViking.deleteResource;
          if (typeof remove === 'function') await remove({ uri: target.uri });
          else if (typeof this.d.openViking.importText === 'function') await this.d.openViking.importText({ ...operation, uri: target.uri, text: parsed.content, status: 'deleted', tombstone: true });
        } else {
          if (parsed.content && typeof this.d.openViking.importText === 'function') await this.d.openViking.importText({ ...operation, uri: target.uri, text: parsed.content });
          const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
          for (const attachment of attachments) {
            if (attachment?.state !== 'ready' || !attachment.path || !openVikingFileType(String(attachment.path)) || typeof this.d.openViking.importFile !== 'function') continue;
            const file = projectedTarget(archive.rootDir, attachment.path);
            await this.d.openViking.importFile({ ...operation, path: file.path, uri: file.uri });
          }
        }
        const completion = typeof archive.acknowledgeProjection === 'function' ? archive.acknowledgeProjection(row.archive_id, row.revision) : null;
        results.push({ archive_id: row.archive_id, revision: row.revision, status: completion ?? 'completed' });
      } catch (e: any) { results.push({ archive_id: row.archive_id, revision: row.revision, status: 'retryable', error: e?.message }); }
    }
    return ok({ processed: results.length, completed: results.filter((r) => r.status === 'completed' || r.status === 'superseded').length, retryable: results.filter((r) => r.status === 'retryable').length, results });
  }
  private operationId(archive: any, archiveId: string) { try { const record = archive.read(archiveId); return String(record.metadata?.operation_id ?? archiveId); } catch { return archiveId; } }
  private telegramKind(a: any): TelegramKind | null { const kind = a.kind ?? a.chat_kind; return kind === 'channel' || kind === 'group' || kind === 'private' ? kind : null; }
  private telegramIds(a: any): [unknown, unknown] { return [a.chatId ?? a.chat_id, a.messageId ?? a.message_id]; }
  private attachmentType(a: any): 'document' | 'image' | null { const type = String(a.type ?? a.kind ?? '').toLowerCase(); const mime = String(a.mime_type ?? a.mimeType ?? '').toLowerCase(); if (type === 'audio' || type === 'video' || mime.startsWith('audio/') || mime.startsWith('video/')) return null; if (type === 'image' || mime.startsWith('image/')) return 'image'; if (type === 'document' || mime.startsWith('application/') || mime.startsWith('text/')) return 'document'; return null; }
  private attachmentBytes(a: any): Uint8Array | undefined { const value = a.bytes ?? a.base64 ?? a.data; if (value === undefined || value === null) return undefined; if (value instanceof Uint8Array) return value; if (Array.isArray(value)) return Uint8Array.from(value); if (typeof value === 'string') return Buffer.from(value, a.base64 !== undefined || a.bytes === undefined ? 'base64' : 'utf8'); return undefined; }
}
export function makeReadToken(ownerId: string, archiveId: string, exp: number, secret: string|Uint8Array, targetUri?: string, revision?: number, scope?: string, principal?: { principalName: string; chatId: string }) {
  const p = Buffer.from(JSON.stringify({ ownerId, archiveId, exp, ...(targetUri ? { targetUri } : {}), ...(revision === undefined ? {} : { revision }), ...(scope ? { scope } : {}), ...(principal ? { principalName: principal.principalName, chatId: principal.chatId } : {}) })).toString('base64url');
  return `${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`;
}
