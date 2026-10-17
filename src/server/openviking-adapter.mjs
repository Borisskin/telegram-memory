import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createOpenVikingClient({ endpoint, token, fetch: fetchImpl }) {
  const headers = { authorization: `Bearer ${token}` };

  async function callMcp(name, args = {}) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!response.ok) throw new Error(`OpenViking MCP ${response.status}`);
    const value = await response.json();
    if (value?.error) throw new Error(value.error.message ?? `OpenViking MCP ${name} failed`);
    const result = value?.result ?? value;
    const payload = result?.structuredContent ?? result;
    if (result?.isError || payload?.isError) {
      const message = (result?.content ?? payload?.content ?? [])
        .map((item) => item?.text)
        .filter(Boolean)
        .join('\n');
      throw new Error(message || `OpenViking MCP ${name} failed`);
    }
    return result?.structuredContent ?? value?.structuredContent ?? result;
  }

  return {
    importText: ({ uri, text }) => callMcp('write', { uri, content: text, mode: 'replace', wait: true }),
    async importFile({ uri, path }) {
      const file = await readFile(path);
      const result = await callMcp('add_resource', { path, to: uri });
      const instruction = (result?.content ?? [])
        .map((item) => item?.text)
        .filter(Boolean)
        .join('\n');
      const uploadUrlText = instruction.match(/https?:\/\/[^\s<>"']+/)?.[0]?.replace(/[),.;]+$/, '');
      if (!uploadUrlText) throw new Error('OpenViking add_resource did not return an upload URL');
      const uploadUrl = new URL(uploadUrlText);
      if (uploadUrl.origin !== new URL(endpoint).origin || uploadUrl.pathname !== '/api/v1/resources/temp_upload') {
        throw new Error('OpenViking add_resource returned an invalid upload URL');
      }

      const form = new FormData();
      form.append('file', new Blob([file]), basename(path));
      const response = await fetchImpl(uploadUrl, { method: 'POST', body: form, redirect: 'error' });
      if (!response.ok) throw new Error(`OpenViking file upload ${response.status}`);
      const outcome = await response.json();
      if (outcome?.status !== 'ok' || typeof outcome?.result?.root_uri !== 'string' || !outcome.result.root_uri.trim()) {
        throw new Error('OpenViking file upload did not import the resource');
      }
    },
    delete: ({ uri }) => callMcp('forget', { uri }),
    search: (args) => callMcp('search', args),
    read: (archiveId) => callMcp('read', { uris: [archiveId] }),
  };
}
