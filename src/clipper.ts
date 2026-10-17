export type ClipResult = { content?: string; markdown?: string; title?: string };

export async function clipHtml(html: string, url: string): Promise<ClipResult> {
  const vendor = new URL('../vendor/obsidian-clipper/', import.meta.url);
  const { parseHTML } = await import(new URL('node_modules/linkedom/cjs/index.js', vendor).href);
  const runtime = globalThis as typeof globalThis & { window?: any; DOMParser?: any; document?: any };
  if (!runtime.window) runtime.window = runtime;
  if (!runtime.DOMParser) runtime.DOMParser = class { parseFromString(source: string) { return parseHTML(source).document; } };
  if (!runtime.window.DOMParser) runtime.window.DOMParser = runtime.DOMParser;
  if (!runtime.document) runtime.document = parseHTML('<!doctype html><html><head></head><body></body></html>').document;
  const api = await import(new URL('dist/api.mjs', vendor).href);
  const result = await api.clip({
    html,
    url,
    template: { noteNameFormat: '{{title}}', properties: [], noteContentFormat: '{{content}}' },
    documentParser: { parseFromString: (source: string) => parseHTML(source).document },
  });
  return { content: result.content, title: result.variables?.title ?? result.noteName };
}
