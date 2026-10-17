import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error the adapter is being extracted as a JavaScript module.
import { createOpenVikingClient } from '../src/server/openviking-adapter.mjs';

async function readBody(request: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(response: any, id: unknown, result: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function startOpenViking(options: {
  failWrites?: boolean;
  uploadUrl?: (origin: string, token: string) => string;
  uploadOutcome?: 'imported' | 'temp_file_only' | 'empty_root_uri';
  redirectUpload?: boolean;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, any>; authorization: string }> = [];
  const uploads: Array<{ method: string; url: string; contentType: string; authorization: string; targetUri?: string; body: Buffer }> = [];
  const uploadResponses: Array<{ statusCode: number; body: Record<string, any> }> = [];
  const importedUris: string[] = [];
  const unexpectedUploads: string[] = [];
  const redirectTargets: string[] = [];
  const uploadTargets = new Map<string, string>();
  let origin = '';
  let uploadSequence = 0;

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/mcp') {
        const rpc = JSON.parse((await readBody(request)).toString('utf8'));
        const name = String(rpc.params?.name ?? '');
        const args = (rpc.params?.arguments ?? {}) as Record<string, any>;
        calls.push({ name, args, authorization: String(request.headers.authorization ?? '') });

        if (name === 'write') {
          const acceptedMode = ['replace', 'append', 'create'].includes(args.mode);
          const isError = !acceptedMode || options.failWrites === true;
          return sendJson(response, rpc.id, {
            isError,
            content: [{ type: 'text', text: isError ? 'write rejected by v0.4.21 contract' : 'written' }],
          });
        }

        if (name === 'add_resource') {
          const validArgs = Object.keys(args).sort().join(',') === 'path,to'
            && typeof args.path === 'string'
            && typeof args.to === 'string';
          if (!validArgs) return sendJson(response, rpc.id, {
            isError: true,
            content: [{ type: 'text', text: 'add_resource requires path and to' }],
          });
          const token = `upload-${++uploadSequence}`;
          uploadTargets.set(token, args.to);
          return sendJson(response, rpc.id, {
            isError: false,
            content: [{ type: 'text', text: options.uploadUrl?.(origin, token) ?? `${origin}/api/v1/resources/temp_upload?token=${token}` }],
          });
        }

        if (name === 'forget') {
          const validArgs = Object.keys(args).join(',') === 'uri' && typeof args.uri === 'string';
          return sendJson(response, rpc.id, {
            isError: !validArgs,
            content: [{ type: 'text', text: validArgs ? 'forgotten' : 'forget requires uri' }],
          });
        }

        return sendJson(response, rpc.id, { isError: true, content: [{ type: 'text', text: `unsupported tool: ${name}` }] });
      }

      if (request.method === 'POST' && request.url?.startsWith('/api/v1/resources/temp_upload?')) {
        const body = await readBody(request);
        const uploadUrl = new URL(request.url, origin);
        const authorization = String(request.headers.authorization ?? '');
        const targetUri = uploadTargets.get(uploadUrl.searchParams.get('token') ?? '');
        uploads.push({
          method: request.method,
          url: request.url,
          contentType: String(request.headers['content-type'] ?? ''),
          authorization,
          targetUri,
          body,
        });
        if (options.redirectUpload) {
          response.writeHead(302, { location: `${origin}/upload-redirect-target` });
          response.end();
          return;
        }

        const outcome = options.uploadOutcome ?? (authorization ? 'temp_file_only' : 'imported');
        const result = outcome === 'temp_file_only'
          ? { temp_file_id: `temp-${uploadUrl.searchParams.get('token')}` }
          : { root_uri: outcome === 'empty_root_uri' ? '' : targetUri };
        const uploadResponse = { status: 'ok', result };
        uploadResponses.push({ statusCode: 200, body: uploadResponse });
        const rootUri = 'root_uri' in result ? result.root_uri : undefined;
        if (typeof rootUri === 'string' && rootUri.length > 0) importedUris.push(rootUri);
        response.writeHead(200, { 'content-type': 'application/json' });
        // v0.4.21 returns root_uri after ingest, but only temp_file_id when
        // an API key bypasses the signed-token import path.
        response.end(JSON.stringify(uploadResponse));
        return;
      }

      if (request.method === 'POST') {
        unexpectedUploads.push(String(request.url ?? ''));
        await readBody(request);
        response.writeHead(404);
        response.end();
        return;
      }

      if (request.url === '/upload-redirect-target') {
        redirectTargets.push(String(request.method));
        response.writeHead(200);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'fake OpenViking failure');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;

  return {
    endpoint: `${origin}/mcp`,
    calls,
    uploads,
    uploadResponses,
    importedUris,
    unexpectedUploads,
    redirectTargets,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
      });
    },
  };
}

function clientFor(fake: Awaited<ReturnType<typeof startOpenViking>>, token = 'openviking-test-token') {
  return createOpenVikingClient({
    endpoint: fake.endpoint,
    token,
    fetch: globalThis.fetch.bind(globalThis),
  });
}

async function startUploadCollector() {
  let uploads = 0;
  const server = createServer(async (request, response) => {
    uploads++;
    await readBody(request);
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get uploads() { return uploads; },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    },
  };
}

test('OpenViking adapter writes text with the accepted replace mode', async () => {
  const fake = await startOpenViking();
  try {
    const client = clientFor(fake);
    const uri = 'viking://resources/telegram/channels/-1009001/1.md';
    await client.importText({ uri, text: 'message text' });

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].name, 'write');
    assert.deepEqual({ uri: fake.calls[0].args.uri, content: fake.calls[0].args.content, mode: fake.calls[0].args.mode }, {
      uri,
      content: 'message text',
      mode: 'replace',
    });
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter rejects a write MCP result marked isError', async () => {
  const fake = await startOpenViking({ failWrites: true });
  try {
    const client = clientFor(fake);
    await assert.rejects(client.importText({
      uri: 'viking://resources/telegram/channels/-1009002/2.md',
      text: 'write must stay retryable',
    }));
    assert.equal(fake.calls[0]?.args.mode, 'replace');
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter authenticates MCP calls with the supplied OpenViking key', async () => {
  const fake = await startOpenViking();
  try {
    const coordinatorToken = 'coordinator-secret';
    const openVikingApiKey = 'openviking-api-key';
    const client = clientFor(fake, openVikingApiKey);
    await client.importText({ uri: 'viking://resources/telegram/channels/-1009002/2.md', text: 'authorized' });

    assert.equal(fake.calls[0].authorization, `Bearer ${openVikingApiKey}`);
    assert.notEqual(fake.calls[0].authorization, `Bearer ${coordinatorToken}`);
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter uploads a file to the add_resource URL as multipart field file', async () => {
  const fake = await startOpenViking();
  try {
    const client = clientFor(fake);
    const path = fileURLToPath(import.meta.url);
    const file = readFileSync(path);
    const uri = `viking://resources/attachments/${createHash('sha256').update(file).digest('hex')}.ts`;
    await client.importFile({ uri, path });

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].name, 'add_resource');
    assert.deepEqual(fake.calls[0].args, { path, to: uri });
    assert.equal(fake.uploads.length, 1);
    assert.equal(fake.uploads[0].method, 'POST');
    assert.equal(fake.uploads[0].targetUri, uri);
    assert.equal(fake.uploads[0].authorization, '');
    assert.deepEqual(fake.uploadResponses, [{
      statusCode: 200,
      body: { status: 'ok', result: { root_uri: uri } },
    }]);
    assert.deepEqual(fake.importedUris, [uri]);
    assert.match(fake.uploads[0].contentType, /^multipart\/form-data;\s*boundary=/i);
    assert.match(fake.uploads[0].body.toString('latin1'), new RegExp(`name="file"; filename="${basename(path)}"`));
    assert.ok(fake.uploads[0].body.includes(file));
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter rejects HTTP 200 with temp_file_id instead of root_uri', async () => {
  const fake = await startOpenViking({ uploadOutcome: 'temp_file_only' });
  try {
    const client = clientFor(fake);
    const path = fileURLToPath(import.meta.url);
    const uri = 'viking://resources/attachments/temporary-only.pdf';
    await assert.rejects(client.importFile({ uri, path }));

    assert.deepEqual(fake.uploadResponses, [{
      statusCode: 200,
      body: { status: 'ok', result: { temp_file_id: 'temp-upload-1' } },
    }]);
    assert.deepEqual(fake.importedUris, []);
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter rejects HTTP 200 with an empty root_uri', async () => {
  const fake = await startOpenViking({ uploadOutcome: 'empty_root_uri' });
  try {
    const client = clientFor(fake);
    await assert.rejects(client.importFile({
      uri: 'viking://resources/attachments/empty-root.pdf',
      path: fileURLToPath(import.meta.url),
    }));

    assert.deepEqual(fake.uploadResponses, [{ statusCode: 200, body: { status: 'ok', result: { root_uri: '' } } }]);
    assert.deepEqual(fake.importedUris, []);
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter rejects a signed upload URL with a different origin before sending the file', async () => {
  const foreign = await startUploadCollector();
  const fake = await startOpenViking({ uploadUrl: (_origin, token) => `${foreign.origin}/api/v1/resources/temp_upload?token=${token}` });
  try {
    const client = clientFor(fake);
    await assert.rejects(client.importFile({ uri: 'viking://resources/attachments/foreign.pdf', path: fileURLToPath(import.meta.url) }));

    assert.equal(fake.uploads.length, 0);
    assert.equal(foreign.uploads, 0);
  } finally {
    await fake.close();
    await foreign.close();
  }
});

test('OpenViking adapter rejects a signed upload URL outside the temp_upload path before sending the file', async () => {
  const fake = await startOpenViking({ uploadUrl: (origin, token) => `${origin}/api/v1/resources/not_temp_upload?token=${token}` });
  try {
    const client = clientFor(fake);
    await assert.rejects(client.importFile({ uri: 'viking://resources/attachments/wrong-path.pdf', path: fileURLToPath(import.meta.url) }));

    assert.equal(fake.uploads.length, 0);
    assert.deepEqual(fake.unexpectedUploads, []);
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter refuses redirects from the signed upload URL', async () => {
  const fake = await startOpenViking({ redirectUpload: true });
  try {
    const client = clientFor(fake);
    await assert.rejects(client.importFile({ uri: 'viking://resources/attachments/redirect.pdf', path: fileURLToPath(import.meta.url) }));

    assert.equal(fake.uploads.length, 1);
    assert.deepEqual(fake.redirectTargets, []);
  } finally {
    await fake.close();
  }
});

test('OpenViking adapter deletes through forget using the URI previously imported', async () => {
  const fake = await startOpenViking();
  try {
    const client = clientFor(fake);
    const uri = 'viking://resources/telegram/channels/-1009003/3.md';
    await client.importText({ uri, text: 'message to remove' });
    await client.delete({ uri });

    assert.deepEqual(fake.calls.map(({ name }) => name), ['write', 'forget']);
    assert.equal(fake.calls[0].args.uri, uri);
    assert.deepEqual(fake.calls[1].args, { uri });
  } finally {
    await fake.close();
  }
});
