import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { DeepSeekAdapter } from '../src/adapters/deepseek.js';
import { GroqAdapter } from '../src/adapters/groq.js';
import { MistralAdapter } from '../src/adapters/mistral.js';
import { XAIAdapter } from '../src/adapters/xai.js';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import type { UniversalRequest, UniversalResponse } from '../src/ir/types.js';

const sampleRequest: UniversalRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'You are an AI assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
  temperature: 0.7,
  max_tokens: 150,
};

function openAIResponse(content: string, model = 'test-model'): UniversalResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mockJsonFetch(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestFromCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, any>,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('provider adapters use the live NexusRoute contract', () => {
  describe('AnthropicAdapter', () => {
    it('sends system prompts separately to the Messages API', async () => {
      const fetchMock = mockJsonFetch({
        id: 'msg_123',
        model: 'claude-test',
        content: [{ type: 'text', text: 'Greetings human!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
      });
      const adapter = new AnthropicAdapter({ apiKey: 'test-key' });

      await adapter.chatCompletion(sampleRequest, 'claude-test');

      const request = requestFromCall(fetchMock);
      expect(request.url).toBe('https://api.anthropic.com/v1/messages');
      expect(request.headers['x-api-key']).toBe('test-key');
      expect(request.body.system).toBe('You are an AI assistant.');
      expect(request.body.messages).toHaveLength(1);
    });

    it('normalises Anthropic responses to OpenAI-compatible output', async () => {
      mockJsonFetch({
        id: 'msg_123',
        model: 'claude-test',
        content: [{ type: 'text', text: 'Greetings human!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
      });
      const result = await new AnthropicAdapter({ apiKey: 'test-key' }).chatCompletion(sampleRequest, 'claude-test');

      expect(result.choices[0].message.content).toBe('Greetings human!');
      expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    });
  });

  describe.each([
    ['deepseek', DeepSeekAdapter, 'https://api.deepseek.com/v1/chat/completions', 'deepseek/deepseek-chat'],
    ['groq', GroqAdapter, 'https://api.groq.com/openai/v1/chat/completions', 'groq/llama-3.3-70b-versatile'],
    ['mistral', MistralAdapter, 'https://api.mistral.ai/v1/chat/completions', 'mistral/mistral-large-latest'],
    ['xai', XAIAdapter, 'https://api.x.ai/v1/chat/completions', 'xai/grok-4.6'],
  ] as const)('%s adapter', (provider, Adapter, expectedUrl, targetModel) => {
    it('uses the provider endpoint and bearer authentication', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('ok'));
      const adapter = new Adapter({ apiKey: 'provider-test-key' });

      await adapter.chatCompletion(sampleRequest, targetModel);

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe(provider);
      expect(request.url).toBe(expectedUrl);
      expect(request.headers.Authorization).toBe('Bearer provider-test-key');
      expect(request.body.model).not.toContain('/');
      expect(request.body.temperature).toBe(0.7);
    });

    it('returns the provider OpenAI-compatible response unchanged', async () => {
      mockJsonFetch(openAIResponse(`${provider} response`, targetModel));
      const result = await new Adapter({ apiKey: 'provider-test-key' }).chatCompletion(sampleRequest, targetModel);

      expect(result.choices[0].message.content).toBe(`${provider} response`);
      expect(result.usage.total_tokens).toBe(15);
    });
  });

  describe('XAIAdapter', () => {
    it('keeps related turns cache-affine without leaking prompt content into headers', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('cached route', 'grok-4.6'));
      const adapter = new XAIAdapter({ apiKey: 'xai-test-key' });

      await adapter.chatCompletion({
        ...sampleRequest,
        session_id: 'chat-session-123',
      }, 'grok-4.6');

      const request = requestFromCall(fetchMock);
      expect(request.headers['x-grok-conv-id']).toBe('chat-session-123');
      expect(JSON.stringify(request.headers)).not.toContain('Hello!');
    });
  });

  describe('OllamaAdapter', () => {
    it('uses Ollama\'s OpenAI-compatible local endpoint', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('local response', 'llama3.2'));
      const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });

      await adapter.chatCompletion(sampleRequest, 'ollama/llama3.2');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('ollama');
      expect(request.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(request.body.model).toBe('llama3.2');
      expect(request.body.temperature).toBe(0.7);
    });

    it('returns local OpenAI-compatible responses', async () => {
      mockJsonFetch(openAIResponse('Running 100% locally.', 'llama3.2'));
      const result = await new OllamaAdapter().chatCompletion(sampleRequest, 'ollama/llama3.2');

      expect(result.choices[0].message.content).toContain('100% locally');
      expect(result.usage.total_tokens).toBe(15);
    });
  });
});
