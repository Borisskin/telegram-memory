import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as ts from 'typescript';

test('координатор копирует в образ все относительные импорты серверных модулей', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dockerfile = readFileSync(resolve(root, 'docker/coordinator.Dockerfile'), 'utf8');
  const copies = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)\s*$/gm)].map((match) => ({
    source: resolve(root, match[1]), destination: posix.resolve('/app', match[2]),
  }));
  const runtimePath = (file: string) => {
    const copy = copies.find((entry) => file === entry.source || (existsSync(entry.source) && statSync(entry.source).isDirectory() && file.startsWith(`${entry.source}${sep}`)));
    if (!copy) return undefined;
    return statSync(copy.source).isDirectory() ? posix.join(copy.destination, relative(copy.source, file).split(sep).join('/')) : copy.destination;
  };
  const seen = new Set<string>();
  const server = resolve(root, 'src/server/coordinator-server.mjs');
  const command = /^CMD\s+(\[[^\n]+\])/m.exec(dockerfile);
  assert.ok(command, 'Dockerfile должен запускать сервер');
  assert.equal(posix.resolve('/app', (JSON.parse(command[1]) as string[]).at(-1)!), runtimePath(server));
  const pending = [server];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const deployed = runtimePath(file);
    assert.ok(deployed, `${relative(root, file)} отсутствует в COPY`);
    const source = readFileSync(file, 'utf8');
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
    for (const specifier of imports.filter((value) => value.startsWith('.'))) {
      const target = resolve(dirname(file), specifier);
      assert.ok(existsSync(target), `${relative(root, file)} импортирует отсутствующий ${specifier}`);
      assert.equal(runtimePath(target), posix.resolve(posix.dirname(deployed), specifier), `${relative(root, file)} импортирует ${specifier}, но COPY кладёт его не туда`);
      if (target.endsWith('.mjs')) pending.push(target);
    }
  }
});
