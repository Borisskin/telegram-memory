import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import { isIP } from 'node:net';
import { URL } from 'node:url';

const listen = (emitter, event, handler) => {
  if (typeof emitter.once === 'function') emitter.once(event, handler);
  else emitter.on(event, handler);
};

const headersOf = (headers) => Object.fromEntries(
  Object.entries(headers ?? {}).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? '']),
);

/**
 * Create a one-hop HTTP fetcher. Redirects are returned to the caller so the
 * service can validate the next URL and choose its address before another hop.
 */
export function createFetchPage({ http = nodeHttp, https = nodeHttps } = {}) {
  return function fetchPage(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!transport) throw new Error('unsupported protocol');

    const address = String(options.address ?? '');
    const family = isIP(address);
    if (!family) throw new Error('resolved address is required');

    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'host'),
    );
    headers.accept ??= 'text/html,application/xhtml+xml';
    headers.host = target.host;

    const requestOptions = {
      protocol: target.protocol,
      hostname: address,
      family,
      port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers,
      // Keep DNS out of every hop: the service has already selected this IP.
      lookup: (_hostname, _lookupOptions, callback) => callback(null, address, family),
      ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const req = transport.request(requestOptions, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        listen(response, 'aborted', () => fail(new Error('response aborted')));
        listen(response, 'error', fail);
        listen(response, 'end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            finalUrl: target.href,
            headers: headersOf(response.headers),
            remoteAddress: response.socket?.remoteAddress,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      listen(req, 'error', fail);
      if (Number.isFinite(options.timeout) && typeof req.setTimeout === 'function') {
        req.setTimeout(options.timeout, () => req.destroy(new Error('timeout')));
      }
      req.end(options.body);
    });
  };
}

export const fetchPage = createFetchPage();
