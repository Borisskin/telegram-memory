export class NotebookError extends Error {
  readonly code: 'notebook_auth' | 'notebook_quota' | 'upstream_unavailable';
  readonly resetAt?: string;
  readonly reset_at?: string;
  constructor(code: NotebookError['code'], message: string, resetAt?: string) {
    super(message);
    this.code = code;
    this.resetAt = resetAt;
    this.reset_at = resetAt;
  }
}

type Client = { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };

function result(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && 'result' in value) return result((value as { result: unknown }).result);
  if (typeof value === 'string') {
    try { return result(JSON.parse(value)); } catch { throw new NotebookError('upstream_unavailable', 'NotebookLM вернул неожиданный ответ'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotebookError('upstream_unavailable', 'NotebookLM вернул неожиданный ответ');
  return value as Record<string, unknown>;
}

export function createNotebookGateway(client: Client): { summarize(markdown: string, prompt: string): Promise<string> } {
  const call = async (name: string, args: Record<string, unknown>) => result(await client.callTool(name, args));
  const checked = async (name: string, args: Record<string, unknown>) => {
    const response = await call(name, args);
    if (response.status === 'success') return response;
    const reason = String(response.error ?? response.message ?? '');
    if (response.status === 'expired' || /auth|cookie|login|token|credential|401/i.test(reason)) {
      const refreshed = await call('refresh_auth', {});
      if (refreshed.status === 'success') {
        const retry = await call(name, args);
        if (retry.status === 'success') return retry;
      }
      throw new NotebookError('notebook_auth', 'Куки NotebookLM протухли, обновите');
    }
    if (/quota|limit|exhaust|429/i.test(reason)) {
      let resetAt: string | undefined;
      try {
        const usage = await call('usage_get', {});
        if (usage.status === 'success' && Array.isArray(usage.windows)) {
          resetAt = usage.windows.flatMap((window) => window && typeof window === 'object' && Number((window as { percent_remaining?: unknown }).percent_remaining) <= 0 && typeof (window as { resets_at?: unknown }).resets_at === 'string' ? [(window as { resets_at: string }).resets_at] : []).sort().at(-1);
        }
      } catch { /* Сбой проверки лимита не скрывает исходную ошибку. */ }
      throw new NotebookError('notebook_quota', 'Лимит NotebookLM исчерпан', resetAt);
    }
    throw new NotebookError('upstream_unavailable', `Ошибка NotebookLM на шаге ${name}`);
  };
  return {
    async summarize(markdown, prompt) {
      const created = await checked('notebook_create', { title: 'Временная сводка' });
      const id = created.notebook_id;
      if (typeof id !== 'string' || !id) throw new NotebookError('upstream_unavailable', 'NotebookLM не вернул идентификатор блокнота');
      let failure: unknown;
      let answer: string | undefined;
      try {
        await checked('source_add', { notebook_id: id, source_type: 'text', text: markdown, title: 'Материалы групп', wait: true });
        const response = await checked('notebook_query', { notebook_id: id, query: prompt });
        if (typeof response.answer !== 'string' || !response.answer.trim()) throw new NotebookError('upstream_unavailable', 'NotebookLM не вернул сводку');
        answer = response.answer.trim();
      } catch (error) { failure = error; }
      try { await checked('notebook_delete', { notebook_id: id, confirm: true }); }
      catch (error) { if (!failure) failure = error; }
      if (failure) throw failure;
      return answer!;
    },
  };
}
