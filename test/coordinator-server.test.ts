import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error the test supplies the JavaScript transport module directly.
import { createFetchPage } from '../src/server/fetch-page.mjs';

test('coordinator startup rejects an empty owner_user_id secret', () => {
  const secretDir = mkdtempSync(join(tmpdir(), 'telegram-memory-empty-owner-'));
  const coordinatorTokenPath = join(secretDir, 'coordinator_mcp_token');
  const ownerIdPath = join(secretDir, 'owner_user_id');
  writeFileSync(coordinatorTokenPath, 'coordinator-token');
  writeFileSync(ownerIdPath, ' \r\n\t');

  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(process.cwd(), 'src/server/coordinator-server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, COORDINATOR_MCP_TOKEN_FILE: coordinatorTokenPath, OWNER_USER_ID_FILE: ownerIdPath },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_USER_ID_FILE is empty/);
});

test('fetchPage connects to the selected IP while preserving HTTP host and TLS SNI', async () => {
  let requestOptions: any;
  let requests = 0;
  const https = {
    request(options: any, callback: (response: EventEmitter & any) => void) {
      requestOptions = options;
      requests += 1;
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & any;
        response.statusCode = 302;
        response.headers = { location: '/next', 'content-type': 'text/html' };
        response.socket = { remoteAddress: '93.184.216.34' };
        queueMicrotask(() => {
          callback(response);
          response.emit('data', 'redirect');
          response.emit('end');
        });
      };
      return request;
    },
  };

  const page = await createFetchPage({ https }).call(null, 'https://Example.test/start?q=1', { address: '93.184.216.34' });

  assert.equal(requests, 1);
  assert.equal(requestOptions.hostname, '93.184.216.34');
  assert.equal(requestOptions.servername, 'example.test');
  assert.equal(requestOptions.headers.host, 'example.test');
  assert.equal(requestOptions.path, '/start?q=1');
  requestOptions.lookup('ignored.example', {}, (error: Error | null, address: string, family: number) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  assert.equal(page.status, 302);
  assert.equal(page.finalUrl, 'https://example.test/start?q=1');
  assert.equal(page.remoteAddress, '93.184.216.34');
  assert.equal(page.headers.location, '/next');
});
