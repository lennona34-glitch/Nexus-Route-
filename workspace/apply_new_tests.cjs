const fs = require('fs');
const path = require('path');

const testDir = path.resolve('..', 'tests');

const testCode = `import { describe, it, expect } from 'vitest';
import { DeepSeekAdapter } from '../src/adapters/deepseek';
import { GroqAdapter } from '../src/adapters/groq';
import { MistralAdapter } from '../src/adapters/mistral';
import { OllamaAdapter } from '../src/adapters/ollama';
import { AnthropicAdapter } from '../src/adapters/anthropic';
import { UnifiedRequest } from '../src/ir/types';

describe('New Provider Adapters', () => {
  const sampleRequest: UnifiedRequest = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are an AI assistant.' },
      { role: 'user', content: 'Hello!' }
    ],
    temperature: 0.7,
    max_tokens: 150,
    stream: false
  };

  describe('AnthropicAdapter', () => {
    const adapter = new AnthropicAdapter();

    it('should format request with system prompt separated', () => {
      const formatted = adapter.formatRequest(sampleRequest, { apiKey: 'test-key' });
      expect(formatted.url).toBe('https://api.anthropic.com/v1/messages');
      expect(formatted.headers['x-api-key']).toBe('test-key');
      expect(formatted.headers['anthropic-version']).toBe('2023-06-01');
      expect(formatted.body.system).toBe('You are an AI assistant.');
      expect(formatted.body.messages.length).toBe(1);
      expect(formatted.body.messages[0].role).toBe('user');
    });

    it('should parse Anthropic response format', () => {
      const mockResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'Greetings human!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 8 }
        }
      };

      const parsed = adapter.parseResponse(mockResponse);
      expect(parsed.provider).toBe('anthropic');
      expect(parsed.message.content).toBe('Greetings human!');
      expect(parsed.usage.prompt_tokens).toBe(12);
      expect(parsed.usage.completion_tokens).toBe(8);
    });
  });

  describe('DeepSeekAdapter', () => {
    const adapter = new DeepSeekAdapter();

    it('should format request correctly', () => {
      const formatted = adapter.formatRequest(sampleRequest, { apiKey: 'ds-test-key' });
      expect(formatted.url).toBe('https://api.deepseek.com/chat/completions');
      expect(formatted.headers['Authorization']).toBe('Bearer ds-test-key');
      expect(formatted.body.messages.length).toBe(2);
      expect(formatted.body.temperature).toBe(0.7);
    });

    it('should parse DeepSeek response', () => {
      const mockResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'ds-123',
          model: 'deepseek-chat',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'DeepSeek response' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      };

      const parsed = adapter.parseResponse(mockResponse);
      expect(parsed.provider).toBe('deepseek');
      expect(parsed.message.content).toBe('DeepSeek response');
      expect(parsed.usage.total_tokens).toBe(15);
    });
  });

  describe('GroqAdapter', () => {
    const adapter = new GroqAdapter();

    it('should format request with Groq OpenAI-compatible endpoint', () => {
      const formatted = adapter.formatRequest(sampleRequest, { apiKey: 'gsk-test' });
      expect(formatted.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(formatted.headers['Authorization']).toBe('Bearer gsk-test');
    });

    it('should parse Groq response', () => {
      const mockResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'chatcmpl-groq',
          model: 'llama-3.3-70b-versatile',
          choices: [{
            message: { role: 'assistant', content: 'Ultra-fast Groq inference' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        }
      };

      const parsed = adapter.parseResponse(mockResponse);
      expect(parsed.provider).toBe('groq');
      expect(parsed.message.content).toBe('Ultra-fast Groq inference');
    });
  });

  describe('MistralAdapter', () => {
    const adapter = new MistralAdapter();

    it('should format request to Mistral API', () => {
      const formatted = adapter.formatRequest(sampleRequest, { apiKey: 'mistral-key' });
      expect(formatted.url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(formatted.headers['Authorization']).toBe('Bearer mistral-key');
    });

    it('should parse Mistral response', () => {
      const mockResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'mistral-123',
          model: 'mistral-large-latest',
          choices: [{
            message: { role: 'assistant', content: 'Bonjour!' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
        }
      };

      const parsed = adapter.parseResponse(mockResponse);
      expect(parsed.provider).toBe('mistral');
      expect(parsed.message.content).toBe('Bonjour!');
    });
  });

  describe('OllamaAdapter', () => {
    const adapter = new OllamaAdapter();

    it('should format request targeting local Ollama daemon /api/chat', () => {
      const formatted = adapter.formatRequest(sampleRequest, { endpoint: 'http://localhost:11434' });
      expect(formatted.url).toBe('http://localhost:11434/api/chat');
      expect(formatted.body.options.temperature).toBe(0.7);
      expect(formatted.body.options.num_predict).toBe(150);
    });

    it('should parse Ollama JSON response', () => {
      const mockResponse = {
        status: 200,
        headers: {},
        body: {
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Running 100% locally with zero cloud tethering.' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 14,
          eval_count: 22
        }
      };

      const parsed = adapter.parseResponse(mockResponse);
      expect(parsed.provider).toBe('ollama');
      expect(parsed.message.content).toContain('100% locally');
      expect(parsed.usage.prompt_tokens).toBe(14);
      expect(parsed.usage.completion_tokens).toBe(22);
      expect(parsed.usage.total_tokens).toBe(36);
    });
  });
});
`;

fs.writeFileSync(path.join(testDir, 'new-adapters.test.ts'), testCode);
console.log('Test suite installed at tests/new-adapters.test.ts');
