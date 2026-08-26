const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const testCode = `import { describe, it, expect } from 'vitest';
import { AdapterFactory } from '../src/adapters/factory';
import { AnthropicAdapter } from '../src/adapters/anthropic';
import { GroqAdapter } from '../src/adapters/groq';
import { DeepSeekAdapter } from '../src/adapters/deepseek';
import { MistralAdapter } from '../src/adapters/mistral';
import { OllamaAdapter } from '../src/adapters/ollama';
import { UnifiedChatRequest } from '../src/ir/types';

describe('New Provider Adapters', () => {
  const sampleRequest: UnifiedChatRequest = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are an AI assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
    temperature: 0.7,
    maxTokens: 1000,
  };

  it('Factory correctly instantiates all new adapters', () => {
    expect(AdapterFactory.create('anthropic', {})).toBeInstanceOf(AnthropicAdapter);
    expect(AdapterFactory.create('claude', {})).toBeInstanceOf(AnthropicAdapter);
    expect(AdapterFactory.create('groq', {})).toBeInstanceOf(GroqAdapter);
    expect(AdapterFactory.create('deepseek', {})).toBeInstanceOf(DeepSeekAdapter);
    expect(AdapterFactory.create('mistral', {})).toBeInstanceOf(MistralAdapter);
    expect(AdapterFactory.create('ollama', {})).toBeInstanceOf(OllamaAdapter);
  });

  describe('AnthropicAdapter', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key' });

    it('transforms unified request to Anthropic message format', async () => {
      const transformed = await adapter.transformRequest(sampleRequest);
      expect(transformed.model).toBe('test-model');
      expect(transformed.system).toBe('You are an AI assistant.');
      expect(transformed.messages).toHaveLength(1);
      expect(transformed.messages[0].role).toBe('user');
      expect(transformed.messages[0].content).toBe('Hello!');
      expect(transformed.max_tokens).toBe(1000);
    });

    it('transforms Anthropic response to unified format', async () => {
      const rawAnthropicResponse = {
        id: 'msg_123',
        model: 'claude-3-5-sonnet',
        content: [{ type: 'text', text: 'Greetings, human.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 8,
        },
      };

      const unified = await adapter.transformResponse(rawAnthropicResponse);
      expect(unified.id).toBe('msg_123');
      expect(unified.provider).toBe('anthropic');
      expect(unified.message.content).toBe('Greetings, human.');
      expect(unified.usage.promptTokens).toBe(12);
      expect(unified.usage.completionTokens).toBe(8);
      expect(unified.usage.totalTokens).toBe(20);
    });
  });

  describe('OllamaAdapter', () => {
    const adapter = new OllamaAdapter({});

    it('transforms unified request to Ollama API format', async () => {
      const transformed = await adapter.transformRequest(sampleRequest);
      expect(transformed.model).toBe('test-model');
      expect(transformed.messages).toHaveLength(2);
      expect(transformed.options.temperature).toBe(0.7);
      expect(transformed.options.num_predict).toBe(1000);
    });

    it('transforms Ollama response to unified format', async () => {
      const rawOllamaResponse = {
        created_at: '2025-01-01T00:00:00Z',
        model: 'llama3.2',
        message: {
          role: 'assistant',
          content: 'Hello from local Ollama!',
        },
        done: true,
        prompt_eval_count: 15,
        eval_count: 10,
      };

      const unified = await adapter.transformResponse(rawOllamaResponse);
      expect(unified.provider).toBe('ollama');
      expect(unified.message.content).toBe('Hello from local Ollama!');
      expect(unified.finishReason).toBe('stop');
      expect(unified.usage.totalTokens).toBe(25);
    });
  });
});
`;

fs.writeFileSync(path.join(rootDir, 'tests/new-adapters.test.ts'), testCode, 'utf8');
console.log('Written tests/new-adapters.test.ts');
