import { afterEach, describe, expect, it, vi } from 'vitest';
import { unloadOllamaModels } from '../src/gpu/ollama.js';

describe('Ollama GPU unloading', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('unloads every resident model and verifies the process table afterward', async () => {
    let processQueries = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) {
        processQueries++;
        return new Response(JSON.stringify({
          models: processQueries === 1 ? [{ name: 'qwen2.5-coder:7b' }] : [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/generate')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'qwen2.5-coder:7b',
          keep_alive: 0,
          stream: false,
        });
        return new Response('{}', { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unloadOllamaModels('http://127.0.0.1:11434');

    expect(result.success).toBe(true);
    expect(result.unloadedModels).toEqual(['qwen2.5-coder:7b']);
    expect(result.remainingModels).toEqual([]);
    expect(processQueries).toBe(2);
  });
});
