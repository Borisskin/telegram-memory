import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { handleReceiverUpdate } from './receiver.ts';
import { handleDigestUpdate } from './digest.ts';
import { deliverGroupAlerts } from './receiver-groups.ts';
import { handleSharedTalkerUpdate, isSharedJoinUpdate } from './shared.ts';
import { sendScheduledDigest } from './scheduled-digest.ts';
import { createModelClient, handleOwnerTalkerUpdate, type ModelClient } from './talker.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Update = { update_id: number; [key: string]: unknown };
type BotApi = {
  getUpdates(args: { offset: number; timeoutSeconds: number; signal?: AbortSignal }): Promise<Update[]>;
  sendMessage?(chatId: string, text: string, options: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery?(id: string, options?: Record<string, unknown>): Promise<unknown>;
  getMe?(): Promise<{ id: number; username: string }>;
  downloadFile?(fileId: string): Promise<Uint8Array>;
};
type CoordinatorClient = { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> };
type Bot = { name: string; token: string; coordToken: string; model?: string; ownerOnly?: boolean; digest?: boolean };

class BotApiRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) { super('Bot API rate limit'); this.retryAfterMs = retryAfterMs; }
}

export type BotsConfig = {
  ownerId: string;
  coordinatorUrl: string;
  model: { baseUrl: string; apiKey: string };
  receiver: Bot;
  talkers: Bot[];
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} config is required`);
  return value as Record<string, unknown>;
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} config is required`);
  return value.trim();
}

function secret(path: unknown, name: string): string {
  const file = required(path, `${name} secret file`);
  let value: string;
  try { value = readFileSync(file, 'utf8').trim(); }
  catch { throw new Error(`${name} secret file is missing or unreadable`); }
  if (!value) throw new Error(`${name} secret is empty`);
  return value;
}

function endpoint(value: unknown, name: string): string {
  const url = required(value, name);
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('unsupported protocol');
  } catch { throw new Error(`${name} must be an HTTP URL`); }
  return url;
}

export function loadBotsConfigFile(path: string): BotsConfig {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`BOTS_CONFIG_FILE is missing: ${path}`); }
  if (!raw.trim()) throw new Error(`BOTS_CONFIG_FILE is empty: ${path}`);
  return loadBotsConfig(raw);
}

export function loadBotsConfig(raw: string): BotsConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('bots config must be valid JSON'); }
  const config = object(parsed, 'bots config');
  const model = object(config.model, 'model');
  const receiver = object(config.receiver, 'receiver');
  if (!Array.isArray(config.talkers)) throw new Error('talkers config must be an array');
  const talkers = config.talkers.map((entry, index) => {
    const bot = object(entry, `talkers[${index}]`);
    if (typeof bot.owner_only !== 'boolean' || typeof bot.digest !== 'boolean') throw new Error(`talkers[${index}] flags are required`);
    return {
      name: required(bot.name, `talkers[${index}].name`),
      token: secret(bot.bot_token_file, `talkers[${index}] bot token`),
      coordToken: secret(bot.coord_token_file, `talkers[${index}] coordinator token`),
      model: required(bot.model, `talkers[${index}].model`),
      ownerOnly: bot.owner_only,
      digest: bot.digest,
    };
  });
  if (new Set(['receiver', ...talkers.map((bot) => bot.name)]).size !== talkers.length + 1) throw new Error('bot names must be unique');
  return {
    ownerId: secret(config.owner_user_id_file, 'owner user ID'),
    coordinatorUrl: endpoint(config.coordinator_url, 'coordinator_url'),
    model: { baseUrl: endpoint(model.base_url, 'model.base_url'), apiKey: secret(model.api_key_file, 'model API key') },
    receiver: { name: 'receiver', token: secret(receiver.bot_token_file, 'receiver bot token'), coordToken: secret(receiver.coord_token_file, 'receiver coordinator token') },
    talkers,
  };
}

export function createBotApi(options: { token: string; fetch?: Fetcher }): BotApi {
  const token = required(options.token, 'Bot API token');
  const request = options.fetch ?? fetch;
  return {
    async getMe() {
      const response = await request(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Bot API identity request failed');
      const payload = await response.json() as { ok?: boolean; result?: { id?: number; username?: string } };
      if (!payload.ok || !Number.isSafeInteger(payload.result?.id) || typeof payload.result?.username !== 'string') throw new Error('Bot API identity is invalid');
      return payload.result as { id: number; username: string };
    },
    async getUpdates({ offset, timeoutSeconds, signal }) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) throw new Error('Invalid Bot API polling options');
      const response = await request(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset, timeout: timeoutSeconds }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSeconds + 10) * 1000)]) : AbortSignal.timeout((timeoutSeconds + 10) * 1000),
      });
      if (response.status === 429) {
        const body = await response.json().catch(() => null) as { parameters?: { retry_after?: unknown } } | null;
        const retryAfter = body?.parameters?.retry_after;
        const seconds = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(300, Math.ceil(retryAfter)) : 1;
        throw new BotApiRateLimitError(seconds * 1000);
      }
      if (!response.ok) throw new Error(`Bot API returned HTTP ${response.status}`);
      const payload = await response.json() as { ok?: boolean; result?: Update[] };
      if (payload.ok !== true || !Array.isArray(payload.result)) throw new Error('Bot API returned an invalid update batch');
      return payload.result;
    },
    async sendMessage(chatId, text, options) {
      const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...options }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Bot API returned HTTP ${response.status}`);
      const payload = await response.json() as { ok?: boolean; result?: unknown };
      if (payload.ok !== true) throw new Error('Bot API did not send the message');
      return payload.result;
    },
    async downloadFile(fileId) {
      const response = await request(`https://api.telegram.org/bot${token}/getFile`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }), signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; result?: { file_path?: unknown } } | null;
      const path = payload?.result?.file_path;
      if (!response.ok || payload?.ok !== true || typeof path !== 'string') throw new Error('Bot API did not give the file');
      const file = await request(`https://api.telegram.org/file/bot${token}/${path}`, { method: 'GET', signal: AbortSignal.timeout(120_000) });
      if (!file.ok) throw new Error(`Bot API file download returned HTTP ${file.status}`);
      return new Uint8Array(await file.arrayBuffer());
    },
    async answerCallbackQuery(id, options = {}) {
      const response = await request(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: id, ...options }), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('Bot API did not answer the callback');
    },
  };
}

export function createCoordinatorClient(options: { endpoint: string; token: string; fetch?: Fetcher }): CoordinatorClient {
  const endpointUrl = endpoint(options.endpoint, 'coordinator endpoint');
  const token = required(options.token, 'coordinator token');
  const request = options.fetch ?? fetch;
  return {
    async callTool(name, args = {}) {
      const response = await request(endpointUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}`);
      const payload = await response.json() as { error?: { message?: string }; result?: { structuredContent?: unknown } };
      if (payload.error) throw new Error(payload.error.message ?? 'Coordinator call failed');
      if (!payload.result || !Object.hasOwn(payload.result, 'structuredContent')) throw new Error('Coordinator returned an invalid MCP response');
      return payload.result.structuredContent;
    },
  };
}

export async function runBots(options: {
  config: BotsConfig;
  signal: AbortSignal;
  botApiFactory?: (name: string, token: string) => BotApi;
  coordinatorClientFactory?: (name: string, token: string) => CoordinatorClient;
  modelClientFactory?: (name: string) => ModelClient;
  log?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const { config, signal } = options;
  const log = options.log ?? console.log;
  const pause = async (milliseconds = 1000) => {
    try { await (options.sleep ? options.sleep(milliseconds) : delay(milliseconds, undefined, { signal })); }
    catch { if (!signal.aborted) throw new Error('Bot API retry delay failed'); }
  };
  await Promise.all([config.receiver, ...config.talkers].map(async (bot) => {
    const api = options.botApiFactory?.(bot.name, bot.token) ?? createBotApi({ token: bot.token });
    const coordinator = options.coordinatorClientFactory?.(bot.name, bot.coordToken) ?? createCoordinatorClient({ endpoint: config.coordinatorUrl, token: bot.coordToken });
    const model = bot.name !== 'receiver' ? options.modelClientFactory?.(bot.name) ?? createModelClient(config.model) : undefined;
    let identity: { id: number; username: string } | undefined;
    let offset = 0;
    let nextAlerts = Date.now() + 300_000;
    let alertsChecked = false;
    let lastDigestCheck = Date.now();
    let nextDigestCheck = Date.now();
    let digestFailures = 0;
    const digestState: { pendingBatchId?: string } = {};
    while (!signal.aborted) {
      try {
        if (bot.name !== 'receiver' && !bot.ownerOnly && !identity) identity = await api.getMe?.();
        const updates = await api.getUpdates({ offset, timeoutSeconds: 30, signal });
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id)) continue;
          if (bot.name === 'receiver' && coordinator) {
            try { await handleReceiverUpdate(update, config.ownerId, coordinator, api); }
            catch {
              log(`Ошибка обработки обновления: ${bot.name} #${update.update_id}`);
              const callback = update.callback_query as { id?: unknown; from?: { id?: unknown }; message?: { chat?: { id?: unknown; type?: unknown } } } | undefined;
              const message = update.message as { from?: { id?: unknown }; chat?: { id?: unknown; type?: unknown } } | undefined;
              const owned = (item: { from?: { id?: unknown }; chat?: { id?: unknown; type?: unknown } } | undefined) =>
                item?.chat?.type === 'private' && String(item.chat.id) === config.ownerId && String(item.from?.id) === config.ownerId;
              try {
                if (callback && owned({ from: callback.from, chat: callback.message?.chat }) && typeof callback.id === 'string') {
                  await api.answerCallbackQuery?.(callback.id, { text: 'Не удалось выполнить действие. Попробуйте ещё раз', show_alert: true });
                } else if (owned(message)) {
                  await api.sendMessage?.(config.ownerId, 'Не удалось обработать сообщение, пришлите ещё раз', {});
                }
              } catch { log(`Ошибка ответа владельцу: ${bot.name} #${update.update_id}`); }
            }
          }
          if (model && bot.ownerOnly) {
            try {
              if (!(bot.digest && await handleDigestUpdate(update, config.ownerId, bot.model ?? '', model, coordinator, api)))
                await handleOwnerTalkerUpdate(update, config.ownerId, bot.model ?? '', model, coordinator, api);
            }
            catch { log(`Ошибка обработки обновления: ${bot.name} #${update.update_id}`); }
          }
          if (model && !bot.ownerOnly && identity) {
            const attempts = isSharedJoinUpdate(update) ? 3 : 1;
            for (let attempt = 0; attempt < attempts; attempt += 1) {
              try { await handleSharedTalkerUpdate(update, identity, bot.model ?? '', model, coordinator, api); break; }
              catch {
                if (attempt === attempts - 1 || signal.aborted) log(`Ошибка обработки обновления: ${bot.name} #${update.update_id}`);
                else {
                  try { await pause(1000 * (attempt + 1)); }
                  catch { log(`Ошибка обработки обновления: ${bot.name} #${update.update_id}`); break; }
                  if (signal.aborted) break;
                }
              }
            }
          }
          offset = Math.max(offset, update.update_id + 1);
          log(`Получено ${update.message ? 'сообщение' : 'событие'} ${bot.name} #${update.update_id}`);
        }
        if (bot.name === 'receiver' && !signal.aborted && ((!alertsChecked && updates.length === 0) || Date.now() >= nextAlerts)) {
          alertsChecked = true;
          nextAlerts = Date.now() + 300_000;
          try { await deliverGroupAlerts(config.ownerId, coordinator, api); }
          catch { log(`Ошибка выдачи оповещений: ${bot.name}`); }
        }
        if (bot.digest && coordinator && model && !signal.aborted && Date.now() >= nextDigestCheck && (updates.length === 0 || Date.now() - lastDigestCheck >= 60_000)) {
          lastDigestCheck = Date.now();
          try {
            await sendScheduledDigest(config.ownerId, bot.model ?? '', model, coordinator, api, digestState);
            digestFailures = 0;
            nextDigestCheck = Date.now() + 60_000;
          } catch {
            digestFailures += 1;
            nextDigestCheck = Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(digestFailures - 1, 3));
            log(`Ошибка сводки по расписанию: ${bot.name}`);
          }
        }
        if (updates.length === 0) await pause();
      } catch (error) {
        if (signal.aborted) break;
        log(`Ошибка опроса Bot API: ${bot.name}`);
        await pause(error instanceof BotApiRateLimitError ? error.retryAfterMs : 1000);
      }
    }
  }));
}
