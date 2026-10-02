import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { DeepSeekAdapter } from '../src/adapters/deepseek.js';
import { GroqAdapter } from '../src/adapters/groq.js';
import { MistralAdapter } from '../src/adapters/mistral.js';
import { XAIAdapter } from '../src/adapters/xai.js';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import { NvidiaAdapter } from '../src/adapters/nvidia.js';
import { UnorouterAdapter } from '../src/adapters/unorouter.js';
import { QwenAdapter, resolveQwenBaseUrl } from '../src/adapters/qwen.js';
import { XkiroAdapter } from '../src/adapters/xkiro.js';
import { CloudflareAdapter, resolveCloudflareConfig } from '../src/adapters/cloudflare.js';
import { AimlapiAdapter } from '../src/adapters/aimlapi.js';
import { GmiCloudAdapter } from '../src/adapters/gmicloud.js';
import { InceptionAdapter } from '../src/adapters/inception.js';
import { AtriaAdapter } from '../src/adapters/atria.js';
import { CerebrasAdapter } from '../src/adapters/cerebras.js';
import { AdapterFactory } from '../src/adapters/factory.js';
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

    it('does not attach reasoning_effort to non-reasoning Grok models like grok-build-0.1', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('build reply', 'grok-build-0.1'));
      const adapter = new XAIAdapter({ apiKey: 'xai-test-key' });

      await adapter.chatCompletion({
        ...sampleRequest,
        reasoning_effort: 'low',
      }, 'grok-build-0.1');

      const request = requestFromCall(fetchMock);
      expect(request.body.reasoning_effort).toBeUndefined();
    });

    it('attaches reasoning_effort to reasoning Grok models like grok-3-mini', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('reasoning reply', 'grok-3-mini'));
      const adapter = new XAIAdapter({ apiKey: 'xai-test-key' });

      await adapter.chatCompletion({
        ...sampleRequest,
        reasoning_effort: 'low',
      }, 'grok-3-mini');

      const request = requestFromCall(fetchMock);
      expect(request.body.reasoning_effort).toBe('low');
    });

    it('auto-recovers and retries without reasoning_effort if upstream xAI rejects it with 400', async () => {
      let callCount = 0;
      const fetchMock = vi.fn(async (_url, init) => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            error: {
              message: 'Model grok-build-0.1 does not support parameter reasoningEffort..',
              type: 'invalid_request_error',
              code: 'invalid-argument',
            }
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(openAIResponse('recovered response', 'grok-build-0.1')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapter = new XAIAdapter({ apiKey: 'xai-test-key' });
      // Even if payload somehow carried reasoning_effort or thinking, adapter should retry clean
      const result = await adapter.chatCompletion({
        ...sampleRequest,
        reasoning_effort: 'low',
      }, 'grok-build-0.1');

      expect(result.choices[0].message.content).toBe('recovered response');
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

  describe('NvidiaAdapter', () => {
    it('uses NVIDIA NIM endpoint and preserves model vendor prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('nim response', 'meta/llama-3.3-70b-instruct'));
      const adapter = new NvidiaAdapter({ apiKey: 'nvapi-test' });

      await adapter.chatCompletion(sampleRequest, 'nvidia::meta/llama-3.3-70b-instruct');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('nvidia');
      expect(request.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer nvapi-test');
      expect(request.body.model).toBe('meta/llama-3.3-70b-instruct');
    });
  });

  describe('UnorouterAdapter', () => {
    it('uses UnoRouter endpoint and cleans provider prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('unorouter response', 'qwen/qwen-2.5-coder-32b-instruct:free'));
      const adapter = new UnorouterAdapter({ apiKey: 'uno-test-key' });

      await adapter.chatCompletion(sampleRequest, 'unorouter/qwen/qwen-2.5-coder-32b-instruct:free');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('unorouter');
      expect(request.url).toBe('https://api.unorouter.com/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer uno-test-key');
      expect(request.body.model).toBe('qwen/qwen-2.5-coder-32b-instruct:free');
    });
  });

  describe('QwenAdapter', () => {
    it('resolves correct base URL based on key prefix', () => {
      expect(resolveQwenBaseUrl('sk-standard-key')).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
      expect(resolveQwenBaseUrl('sk-sp-token-plan-key')).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
    });

    it('uses resolved base URL for completions', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('qwen response', 'qwen-2.5-coder-32b-instruct'));
      const adapter = new QwenAdapter({ apiKey: 'sk-sp-mytoken' });

      await adapter.chatCompletion(sampleRequest, 'qwen/qwen-2.5-coder-32b-instruct');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('qwen');
      expect(request.url).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer sk-sp-mytoken');
      expect(request.body.model).toBe('qwen-2.5-coder-32b-instruct');
    });
  });

  describe('XkiroAdapter', () => {
    it('uses xKiro endpoint and cleans provider prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('xkiro response', 'deepseek/deepseek-r1:free'));
      const adapter = new XkiroAdapter({ apiKey: 'xkiro-test-key' });

      await adapter.chatCompletion(sampleRequest, 'xkiro::deepseek/deepseek-r1:free');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('xkiro');
      expect(request.url).toBe('https://api.xkiro.com/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer xkiro-test-key');
      expect(request.body.model).toBe('deepseek/deepseek-r1:free');
    });
  });

  describe('CloudflareAdapter', () => {
    it('resolves accountId and token from composite key', () => {
      const { accountId, apiKey, baseUrl } = resolveCloudflareConfig({ apiKey: 'myaccount123:mytoken456' });
      expect(accountId).toBe('myaccount123');
      expect(apiKey).toBe('mytoken456');
      expect(baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/myaccount123/ai/v1');
    });

    it('uses Cloudflare Workers AI endpoint', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('cf response', '@cf/meta/llama-3.3-70b-instruct'));
      const adapter = new CloudflareAdapter({ apiKey: 'acc999:tok888' });

      await adapter.chatCompletion(sampleRequest, 'cloudflare::@cf/meta/llama-3.3-70b-instruct');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('cloudflare');
      expect(request.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc999/ai/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer tok888');
      expect(request.body.model).toBe('@cf/meta/llama-3.3-70b-instruct');
    });
  });

  describe('AimlapiAdapter', () => {
    it('uses AI/ML API endpoint and cleans provider prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('aimlapi response', 'deepseek/deepseek-r1'));
      const adapter = new AimlapiAdapter({ apiKey: 'aiml-test-key' });

      await adapter.chatCompletion(sampleRequest, 'aimlapi::deepseek/deepseek-r1');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('aimlapi');
      expect(request.url).toBe('https://api.aimlapi.com/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer aiml-test-key');
      expect(request.body.model).toBe('deepseek/deepseek-r1');
    });
  });

  describe('GmiCloudAdapter', () => {
    it('uses GMI Cloud serving endpoint and cleans provider prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('gmi response', 'deepseek-ai/DeepSeek-R1'));
      const adapter = new GmiCloudAdapter({ apiKey: 'gmi-test-key' });

      await adapter.chatCompletion(sampleRequest, 'gmicloud::deepseek-ai/DeepSeek-R1');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('gmicloud');
      expect(request.url).toBe('https://api.gmi-serving.com/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer gmi-test-key');
      expect(request.body.model).toBe('deepseek-ai/DeepSeek-R1');
    });
  });

  describe('InceptionAdapter', () => {
    it('uses Inception Labs endpoint and cleans provider prefix', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('inception response', 'mercury-2.5'));
      const adapter = new InceptionAdapter({ apiKey: 'inception-test-key' });

      await adapter.chatCompletion(sampleRequest, 'inception::mercury-2.5');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('inception');
      expect(request.url).toBe('https://api.inceptionlabs.ai/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer inception-test-key');
      expect(request.body.model).toBe('mercury-2.5');
    });

    it('supports custom base URL for Inception Labs', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('custom response', 'mercury-2'));
      const adapter = new InceptionAdapter({ apiKey: 'inception-test-key', baseUrl: 'https://custom.inceptionlabs.ai/v1' });

      await adapter.chatCompletion(sampleRequest, 'inception/mercury-2');

      const request = requestFromCall(fetchMock);
      expect(request.url).toBe('https://custom.inceptionlabs.ai/v1/chat/completions');
      expect(request.body.model).toBe('mercury-2');
    });
  });

  describe('CerebrasAdapter & Thinking Pruning', () => {
    it('uses Cerebras endpoint and strips historical <think> traces from assistant messages', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('cerebras response', 'qwen-3.8-27b'));
      const adapter = new CerebrasAdapter({ apiKey: 'cerebras-test-key' });

      const requestWithThinkHistory: UniversalRequest = {
        model: 'cerebras::qwen-3.8-27b',
        messages: [
          { role: 'user', content: 'build a vocoder' },
          {
            role: 'assistant',
            content: '<think>I should verify python and tkinter first.\nExtensive monologue...</think>\n\nChecking environment now.',
          },
          { role: 'user', content: 'continue' },
        ],
      };

      await adapter.chatCompletion(requestWithThinkHistory, 'cerebras::qwen-3.8-27b');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('cerebras');
      expect(request.url).toBe('https://api.cerebras.ai/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer cerebras-test-key');
      expect(request.body.model).toBe('qwen-3.8-27b');
      // Verify historical <think> trace was stripped from assistant message sent to upstream
      expect(request.body.messages[1].content).toBe('Checking environment now.');
      expect(request.body.messages[1].content).not.toContain('<think>');
    });
  });

  describe('AtriaAdapter', () => {
    it('uses Atria ASI endpoint and Bearer auth header', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('atria response', 'Atria-Dawn-Preview'));
      const adapter = new AtriaAdapter({ apiKey: 'atria-test-key' });

      await adapter.chatCompletion(sampleRequest, 'atria::Atria-Dawn-Preview');

      const request = requestFromCall(fetchMock);
      expect(adapter.provider).toBe('atria');
      expect(request.url).toBe('https://api.atria-asi.ai/v1/chat/completions');
      expect(request.headers.Authorization).toBe('Bearer atria-test-key');
      expect(request.body.model).toBe('Atria-Dawn-Preview');
    });

    it('supports custom base URL for Atria ASI', async () => {
      const fetchMock = mockJsonFetch(openAIResponse('custom response', 'Atria-Dawn'));
      const adapter = new AtriaAdapter({ apiKey: 'atria-test-key', baseUrl: 'https://custom.atria-asi.ai/v1' });

      await adapter.chatCompletion(sampleRequest, 'atria/Atria-Dawn');

      const request = requestFromCall(fetchMock);
      expect(request.url).toBe('https://custom.atria-asi.ai/v1/chat/completions');
      expect(request.body.model).toBe('Atria-Dawn');
    });
  });

  describe('AdapterFactory', () => {
    it('instantiates all 4 new providers via factory', () => {
      expect(AdapterFactory.create('xkiro', { apiKey: 'k' })).toBeInstanceOf(XkiroAdapter);
      expect(AdapterFactory.create('cloudflare', { apiKey: 'acc:tok' })).toBeInstanceOf(CloudflareAdapter);
      expect(AdapterFactory.create('aimlapi', { apiKey: 'k' })).toBeInstanceOf(AimlapiAdapter);
      expect(AdapterFactory.create('gmicloud', { apiKey: 'k' })).toBeInstanceOf(GmiCloudAdapter);
      expect(AdapterFactory.create('inception', { apiKey: 'k' })).toBeInstanceOf(InceptionAdapter);
      expect(AdapterFactory.create('inceptionlabs', { apiKey: 'k' })).toBeInstanceOf(InceptionAdapter);
      expect(AdapterFactory.create('atria', { apiKey: 'k' })).toBeInstanceOf(AtriaAdapter);
      expect(AdapterFactory.create('atria-asi', { apiKey: 'k' })).toBeInstanceOf(AtriaAdapter);
      expect(AdapterFactory.create('dawn', { apiKey: 'k' })).toBeInstanceOf(AtriaAdapter);
      expect(AdapterFactory.create('cerebras', { apiKey: 'k' })).toBeInstanceOf(CerebrasAdapter);
    });
  });
});
