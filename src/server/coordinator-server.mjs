import http from 'node:http';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import { Archive, Coordinator, Stage3Service, createAccess, createCoordinatorMcpHandler, createNotebookGateway } from '../index.ts';
import { fetchPage } from './fetch-page.mjs';
import { createOpenVikingClient } from './openviking-adapter.mjs';
import { collectTelegramPage } from './telegram-collect.mjs';

const port = Number(process.env.COORDINATOR_PORT || 8787);
const secretPath = process.env.COORDINATOR_MCP_TOKEN_FILE || '/run/secrets/coordinator_mcp_token';
const secret = fs.readFileSync(secretPath, 'utf8').trim();
if (!secret) throw new Error('COORDINATOR_MCP_TOKEN_FILE is empty');
const ownerUserIdPath = process.env.OWNER_USER_ID_FILE || '/run/secrets/owner_user_id';
const ownerId = fs.readFileSync(ownerUserIdPath, 'utf8').trim();
if (!ownerId) throw new Error('OWNER_USER_ID_FILE is empty');
const openVikingApiKeyPath = process.env.OPENVIKING_API_KEY_FILE || '/run/secrets/openviking_api_key';
const openVikingApiKey = fs.readFileSync(openVikingApiKeyPath, 'utf8').trim();
if (!openVikingApiKey) throw new Error('OPENVIKING_API_KEY_FILE is empty');
const botPrincipalsPath = process.env.BOT_PRINCIPALS_FILE || '/run/secrets/bot_principals';
const botPrincipalsJson = fs.readFileSync(botPrincipalsPath, 'utf8');
let botPrincipals;
try { botPrincipals = JSON.parse(botPrincipalsJson); }
catch (error) { throw new Error(`BOT_PRINCIPALS_FILE is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }

async function callMcp(endpoint, name, args = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  if (!response.ok) throw new Error(`MCP ${response.status}`);
  const value = await response.json();
  return value?.result?.structuredContent ?? value?.structuredContent ?? value;
}

const telegramEndpoint = process.env.TELEGRAM_MCP_URL || 'http://telegram-mcp:8765/mcp';
const notebookEndpoint = process.env.NOTEBOOKLM_MCP_URL || 'http://telegram-mcp:8766/mcp';
const openVikingEndpoint = process.env.OPENVIKING_MCP_URL || 'http://openviking:1933/mcp';
const telegram = {
  async resolveSource(ref) {
    const numeric = /^\d+$/.test(ref);
    const path = numeric ? ref : new URL(ref).pathname.replace(/^\//, '');
    const result = numeric
      ? await callMcp(telegramEndpoint, 'get_chat', { chat_id: path })
      : await callMcp(telegramEndpoint, 'resolve_username', { username: path });
    const raw = result?.data ?? result;
    const value = typeof raw === 'string' ? JSON.parse(raw) : typeof raw?.result === 'string' ? JSON.parse(raw.result) : raw;
    if (!value?.chat_id && !value?.id) throw new Error('Telegram source is unavailable');
    const type = String(value.kind ?? value.type ?? value.peer_type ?? value.chat_type ?? '').toLowerCase();
    const kind = type.includes('user') || type.includes('person') || type.includes('private') ? 'user' : type.includes('group') ? 'group' : 'channel';
    return { chatId: value.chat_id ?? value.id, title: value.title ?? value.name ?? null, kind, username: value.username ?? null };
  },
  async collect({ source, cursor, limit, mode }) {
    return collectTelegramPage((name, args) => callMcp(telegramEndpoint, name, args), { source, cursor, limit, mode });
  },
  history(args) { return callMcp(telegramEndpoint, 'list_messages', args); },
  recentGroups(args) { return callMcp(telegramEndpoint, 'list_chats', args); },
  async digestSource(ref) {
    const chatId = /^-?\d+$/.test(ref) ? ref : new URL(ref).pathname.slice(1);
    const raw = await callMcp(telegramEndpoint, 'get_chat', { chat_id: chatId });
    const info = typeof raw === 'string' ? JSON.parse(raw) : typeof raw?.result === 'string' ? JSON.parse(raw.result) : raw;
    if (!info || !Number.isSafeInteger(info.id)) throw new Error('Telegram chat could not be resolved');
    const kind = ['Group', 'Group (Basic)', 'Supergroup'].includes(info.type) ? 'group' : info.type === 'Channel' ? 'channel' : 'user';
    return { chatId: info.id, title: info.title ?? info.name ?? null, kind };
  },
};

const archive = new Archive({ rootDir: process.env.ARCHIVE_ROOT || '/data/archive', ownerId });
const openViking = createOpenVikingClient({ endpoint: openVikingEndpoint, token: openVikingApiKey, fetch });
let coordinator;
const access = createAccess({ principals: botPrincipals, legacyToken: secret, ownerId, archive, sourceTargetUri: (ref) => coordinator?.sourceTargetUri(ref) });
const integrations = new Stage3Service({
  archive,
  openViking,
  ownerId,
  tokenSecret: secret,
  sourceExists: (ref) => coordinator?.sourceExists(ref) ?? false,
  sourceTargetUri: (ref) => coordinator?.sourceTargetUri(ref),
  resolveHost: async (host) => (await dns.lookup(host, { all: true })).map((item) => item.address),
  fetchPage,
});
coordinator = new Coordinator({ archive, ownerId, telegram, integrations, access, notebookGateway: createNotebookGateway({ callTool: (name, args) => callMcp(notebookEndpoint, name, args) }) });
const personalPoll = setInterval(() => { void coordinator.pollPersonalChats().catch(() => console.error('Personal collection tick failed')); }, 300_000);
const handle = createCoordinatorMcpHandler(coordinator, access);

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', mcp: true });
  if (req.method !== 'POST' || req.url !== '/mcp') return json(res, 404, { error: 'not_found' });
  // 28 MiB: a 20 MB file from the Receiver in base64 with room for the envelope.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 28 * 1_048_576) return json(res, 413, { error: 'request_too_large' }); chunks.push(chunk); }
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    request.headers = req.headers;
    json(res, 200, await handle(request));
  } catch (error) { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'invalid_request' } }); }
});
server.listen(port, '0.0.0.0');
process.on('SIGTERM', () => { clearInterval(personalPoll); coordinator.close(); server.close(); });
