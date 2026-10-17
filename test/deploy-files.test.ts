import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Deployment knowledge has one place each: VERSION, config/vendors.json,
// config/secrets.json, config/openviking.conf.json and compose.yaml. These
// tests keep the files consistent; scripts/*.sh are checked in local Docker.
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const compose = read('compose.yaml');
const vendors = JSON.parse(read('config/vendors.json')) as Record<string, { repo?: string; commit?: string; image?: string; version?: string }>;
const catalog = JSON.parse(read('config/secrets.json')) as Array<{ name: string; services: string[]; source: string; hint: string; principal?: { name: string } & Record<string, unknown> }>;

// Read the mappings by indentation so comments and nested keys cannot count as services.
function mapping(text: string, name: string, indent = 0): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${name}:`);
  assert.ok(start >= 0, `${name} mapping is required`);
  const entries: Record<string, string> = {};
  const childIndent = indent + 2;
  let key = '';
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break;
    const match = new RegExp(`^ {${childIndent}}([\\w.-]+):(?:\\s*(.*))?$`).exec(line);
    if (match) { key = match[1]; entries[key] = match[2] ?? ''; }
    else if (key) entries[key] += `\n${line}`;
  }
  return entries;
}

const list = (field = '') => [...field.matchAll(/^\s*-\s+(?:source:\s*)?([\w./:-]+)/gm)].map((match) => match[1]);
const services = mapping(compose, 'services');
const service = (name: string) => mapping(compose, name, 2);

function memoryMb(field: string): number {
  const match = /^([0-9.]+)([kmg])?$/i.exec(field.replace(/["']/g, '').trim());
  assert.ok(match, `invalid memory limit: ${field}`);
  return Number(match[1]) * ({ k: 1 / 1024, m: 1, g: 1024 } as Record<string, number>)[match[2]?.toLowerCase() ?? 'm'];
}

test('VERSION is exactly three numbers', () => {
  assert.match(read('VERSION'), /^\d+\.\d+\.\d+\n?$/);
});

test('Dockerfile build arguments are exactly the vendors list, without defaults', () => {
  const expected = new Set<string>();
  for (const [name, vendor] of Object.entries(vendors)) {
    const prefix = name.toUpperCase().replace(/-/g, '_');
    if (vendor.repo) { assert.match(vendor.commit ?? '', /^[0-9a-f]{40}$/, `${name} commit`); expected.add(`${prefix}_REPO`).add(`${prefix}_COMMIT`); }
    if (vendor.image) { assert.match(vendor.image, /@sha256:[0-9a-f]{64}$/, `${name} image is pinned by digest`); expected.add(`${prefix}_IMAGE`); }
  }
  const dockerfiles = read('docker/coordinator.Dockerfile') + read('docker/telegram-mcp.Dockerfile');
  const args = [...dockerfiles.matchAll(/^ARG\s+(\S+)/gm)].map((match) => match[1]);
  for (const arg of args) assert.doesNotMatch(arg, /=/, `${arg} must not have a default`);
  // Vendor images that are not built (OpenViking) reach compose as variables.
  const composeVars = [...compose.matchAll(/\$\{(\w+_IMAGE)[:}]/g)].map((match) => match[1]);
  assert.deepEqual([...new Set([...args, ...composeVars])].sort(), [...expected].sort());
  assert.doesNotMatch(dockerfiles + compose, /[0-9a-f]{40}|sha256:[0-9a-f]{64}/, 'pins live only in config/vendors.json');
});

test('compose uses TM_VERSION for project images and TM_ROOT for every host file', () => {
  for (const name of ['coordinator', 'bots', 'telegram-mcp']) assert.match(service(name).image, /^telegram-memory\/[\w-]+:\$\{TM_VERSION:\?[^}]+\}$/);
  assert.match(service('openviking').image, /^\$\{OPENVIKING_IMAGE:\?[^}]+\}$/);
  const files = [...compose.matchAll(/^\s+file:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(file.startsWith('${TM_ROOT:-/etc/telegram-memory}/'), file);
  assert.doesNotMatch(compose, /BOTS_CONFIG\b(?!_FILE)|\.example|\.\/config\//);
});

test('each service mounts exactly its catalog secrets, from its own directory', () => {
  const declared = mapping(compose, 'secrets');
  const expected: Record<string, string[]> = {};
  for (const secret of catalog) for (const name of secret.services) (expected[name] ??= []).push(secret.name);
  const actual: Record<string, string[]> = {};
  for (const name of Object.keys(services)) {
    const refs = list(service(name).secrets);
    if (!refs.length) continue;
    actual[name] = refs.map((ref) => {
      const match = /\/secrets\/([\w-]+)\/([\w.-]+)$/.exec(declared[ref]?.match(/file:\s*(\S+)/)?.[1] ?? '');
      assert.ok(match, `${ref} must be declared with a file under TM_ROOT/secrets`);
      assert.equal(match[1], name, `${name} mounts ${ref} from another service's directory`);
      return match[2];
    }).sort();
  }
  for (const list of Object.values(expected)) list.sort();
  assert.deepEqual(actual, expected);
  assert.equal(Object.keys(declared).length, Object.values(expected).flat().length, 'no unused secret declarations');
});

test('the secrets catalog has the sources of the specification', () => {
  const bySource = (source: string) => catalog.filter((secret) => secret.source === source).map((secret) => secret.name).sort();
  assert.deepEqual(bySource('ask'), ['model_api_key', 'owner_user_id', 'receiver_bot_token', 'talker_shared_bot_token', 'telegram_api_hash', 'telegram_api_id', 'telegram_session_string']);
  assert.deepEqual(bySource('generate'), ['coordinator_mcp_token', 'receiver_coord_token', 'talker_shared_coord_token']);
  assert.deepEqual(bySource('principals'), ['bot_principals']);
  assert.deepEqual(bySource('openviking'), ['openviking_api_key', 'ov.conf']);
  assert.deepEqual(bySource('file'), ['notebooklm_cookies']);
  for (const secret of catalog) assert.ok(secret.hint && secret.services.length, secret.name);
  const template = JSON.stringify(JSON.parse(read('config/openviking.conf.json')));
  assert.doesNotMatch(template, /"(root_)?api_key":/, 'the OpenViking template has no keys');
});

test('principals computed from the catalog are accepted by the coordinator', async () => {
  const { createAccess } = await import(new URL('src/access.ts', root).href);
  const principals = catalog.filter((secret) => secret.principal).map((secret) => ({
    ...secret.principal, token_sha256: createHash('sha256').update(secret.name).digest('hex'),
  }));
  assert.deepEqual(principals.map((item) => item.name).sort(), ['receiver', 'talker_shared']);
  assert.ok(createAccess({ principals, legacyToken: 'system-token', ownerId: 'owner' }));
});

test('compose has four restricted services with isolated networks', () => {
  assert.deepEqual(Object.keys(services).sort(), ['bots', 'coordinator', 'openviking', 'telegram-mcp']);
  assert.doesNotMatch(compose, /^\s+(ports|build):/m);
  assert.doesNotMatch(compose, /:latest\b/);
  let memory = 0;
  let cpus = 0;
  for (const name of Object.keys(services)) {
    const entry = service(name);
    assert.equal(entry.read_only, 'true', `${name} read_only`);
    assert.match(entry.security_opt, /no-new-privileges:true/, `${name} no-new-privileges`);
    assert.match(entry.cap_drop, /ALL/, `${name} cap_drop`);
    memory += memoryMb(entry.mem_limit);
    cpus += Number(entry.cpus?.replace(/["']/g, ''));
    const exchange = (entry.volumes ?? '').includes(':/exchange');
    assert.equal(exchange, name === 'coordinator' || name === 'telegram-mcp', `${name} /exchange`);
  }
  assert.ok(memory <= 4096 && cpus <= 2, 'limits fit a 2-core 4 GB server');
  assert.deepEqual(list(service('bots').networks), ['bots_coord']);
  assert.deepEqual(list(service('telegram-mcp').networks), ['coordinator_telegram']);
  assert.deepEqual(list(service('openviking').networks), ['coordinator_openviking']);
  assert.deepEqual(list(service('coordinator').networks).sort(), ['bots_coord', 'coordinator_openviking', 'coordinator_telegram']);
});

test('bots runs the coordinator image with its own entrypoint and a mounted settings file', () => {
  const bots = service('bots');
  const coordinator = service('coordinator');
  assert.equal(bots.image, coordinator.image);
  assert.notEqual(bots.entrypoint, coordinator.entrypoint);
  assert.match(bots.environment, /BOTS_CONFIG_FILE: \/run\/config\/bots\.json/);
  assert.match(bots.configs, /source: bots_config\s+target: \/run\/config\/bots\.json/);
  assert.match(mapping(compose, 'configs').bots_config, /\/config\/bots\.json/);
});

test('README and docs link only to existing files and anchors', () => {
  const files = ['README.md', ...readdirSync(new URL('docs/', root)).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
  // GitHub anchors: lower case, spaces to hyphens, punctuation dropped.
  const anchors = (text: string) => new Set([...text.matchAll(/^#+\s+(.+)$/gm)].map((match) => match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')));
  for (const file of files) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const resolved = path ? new URL(path, new URL(file, root)) : new URL(file, root);
      assert.ok(existsSync(resolved), `${file} links to missing ${target}`);
      if (anchor) assert.ok(anchors(readFileSync(resolved, 'utf8')).has(anchor), `${file} links to missing anchor ${target}`);
    }
  }
});

test('docs do not describe the removed Windows deployment', () => {
  for (const file of ['README.md', ...readdirSync(new URL('docs/', root)).map((name) => `docs/${name}`)]) {
    assert.doesNotMatch(read(file), /secrets\.ps1|build-images|check-deploy\.ps1|Диспетчер учётных данных|\.env\b|\.example\b|BOTS_CONFIG\b(?!_FILE)/, file);
  }
});
