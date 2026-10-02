import { ProviderAdapter, AdapterError, readStreamWithInactivityTimeout } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType, ContentPart } from '../ir/types.js';
import { extractTextFromContent } from '../ir/validator.js';
import { ToolRegistry } from '../tools/registry.js';

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function normalizeAnthropicMessages(raw: AnthropicMessage[]): AnthropicMessage[] {
  // 1. Sanitize content for each message
  const sanitized: AnthropicMessage[] = [];
  for (const m of raw) {
    if (typeof m.content === 'string') {
      const trimmed = m.content.trim();
      sanitized.push({
        role: m.role,
        content: trimmed.length > 0 ? trimmed : '(empty message)',
      });
    } else if (Array.isArray(m.content)) {
      const cleanBlocks: AnthropicContentBlock[] = [];
      for (const b of m.content) {
        if (b.type === 'text') {
          const t = (b.text || '').trim();
          if (t.length > 0) {
            cleanBlocks.push({ ...b, text: t });
          }
        } else {
          cleanBlocks.push(b);
        }
      }
      if (cleanBlocks.length === 0) {
        cleanBlocks.push({ type: 'text', text: '(empty message)' });
      }
      sanitized.push({
        role: m.role,
        content: cleanBlocks,
      });
    }
  }

  // 2. Auto-merge consecutive same-role messages
  const merged: AnthropicMessage[] = [];
  for (const m of sanitized) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content = `${prev.content}\n\n${m.content}`;
      } else {
        const prevBlocks: AnthropicContentBlock[] = typeof prev.content === 'string'
          ? [{ type: 'text', text: prev.content }]
          : prev.content;
        const currBlocks: AnthropicContentBlock[] = typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : m.content;
        prev.content = [...prevBlocks, ...currBlocks];
      }
    } else {
      merged.push(m);
    }
  }

  // 3. Ensure conversation begins with a user turn
  if (merged.length === 0) {
    merged.push({ role: 'user', content: 'Hello' });
  } else if (merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(Initiate session)' });
  }

  return merged;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'anthropic';
  private config?: { baseUrl?: string; apiKey?: string };

  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.config = config;
  }

  private get baseUrl(): string {
    return this.config?.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  }

  private get apiKey(): string | undefined {
    return this.config?.apiKey || process.env.ANTHROPIC_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private formatPayload(req: UniversalRequest, targetModel: string, stream: boolean) {
    let systemPrompt: string | undefined;
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + extractTextFromContent(msg.content);
      } else if (msg.role === 'assistant') {
        const blocks: AnthropicContentBlock[] = [];
        const textContent = typeof msg.content === 'string' ? msg.content : (msg.content ? extractTextFromContent(msg.content) : '');
        if (textContent) {
          blocks.push({ type: 'text', text: textContent });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            let parsedArgs = {};
            try {
              parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {});
            } catch {}
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs,
            });
          }
        }
        anthropicMessages.push({
          role: 'assistant',
          content: blocks.length > 0 ? blocks : textContent || '',
        });
      } else if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          anthropicMessages.push({
            role: 'user',
            content: msg.content,
          });
        } else {
          const blocks: AnthropicContentBlock[] = [];
          for (const part of msg.content as ContentPart[]) {
            if (part.type === 'text') {
              blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url') {
              const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                blocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2],
                  },
                });
              }
            }
          }
          anthropicMessages.push({
            role: 'user',
            content: blocks,
          });
        }
      } else if (msg.role === 'tool') {
        const toolResultBlock: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || 'call_0',
          content: extractTextFromContent(msg.content),
        };
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.some(b => b.type === 'tool_result')) {
          (lastMsg.content as AnthropicContentBlock[]).push(toolResultBlock);
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      }
    }

    const cleanModel = targetModel.replace(/^anthropic::/i, '').replace(/^anthropic\//i, '');
    const normalizeMap: Record<string, string> = {
      'claude-3-7-sonnet': 'claude-3-5-sonnet-20241022',
      'claude-3-7-sonnet-latest': 'claude-3-5-sonnet-20241022',
      'claude-3-7-sonnet-20250219': 'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',
      'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
      'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
      'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
      'claude-3-haiku-20240307': 'claude-3-haiku-20240307',
      'claude-3-haiku': 'claude-3-haiku-20240307',
      'claude-haiku-4.5': 'claude-3-5-haiku-20241022',
      'claude-haiku-4-5': 'claude-3-5-haiku-20241022',
      'claude-haiku-4-5-20251001': 'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229': 'claude-3-opus-20240229',
      'claude-3-opus': 'claude-3-opus-20240229',
      'claude-3-opus-latest': 'claude-3-opus-20240229',
      'claude-sonnet-5': 'claude-3-5-sonnet-20241022',
      'claude-sonnet-4-5-20250929': 'claude-3-5-sonnet-20241022',
    };
    const modelToUse = normalizeMap[cleanModel] || cleanModel;

    const normalizedMessages = normalizeAnthropicMessages(anthropicMessages);

    const hasToolHistory = normalizedMessages.some(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')
    );
    const availableTools = (req.tools && req.tools.length > 0)
      ? req.tools
      : (hasToolHistory ? ToolRegistry.getBuiltInTools() : undefined);

    const anthropicTools = availableTools && availableTools.length > 0 ? availableTools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    })) : undefined;

    return {
      model: modelToUse,
      messages: normalizedMessages,
      system: systemPrompt,
      tools: anthropicTools,
      max_tokens: req.max_tokens || 8192,
      temperature: req.temperature,
      stream,
    };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'NexusRoute/1.3.0 (+https://github.com/nexusroute/nexus-route)',
      'anthropic-version': '2023-06-01',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    if (!this.apiKey) {
      throw new AdapterError('Anthropic API key not configured', 'anthropic', 401, false);
    }

    const payload = this.formatPayload(req, targetModel, false);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      throw new AdapterError(`Network error reaching Anthropic: ${(err as Error).message}`, 'anthropic', 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const retryAfterHeader = res.headers.get('retry-after');
      let retryAfterMs: number | undefined;
      if (retryAfterHeader) {
        const secs = Number(retryAfterHeader);
        if (Number.isFinite(secs) && secs >= 0) {
          retryAfterMs = Math.round(secs * 1000);
        }
      }
      throw new AdapterError(
        `Anthropic error (${res.status}): ${errText}`,
        'anthropic',
        res.status,
        res.status === 429 || res.status === 529 || res.status >= 500,
        undefined,
        retryAfterMs
      );
    }

    const data = (await res.json()) as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    let textContent = '';
    const toolCalls: UniversalResponse['choices'][0]['message']['tool_calls'] = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        textContent += block.text;
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id || `tool-${Date.now()}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    return {
      id: data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model || targetModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    if (!this.apiKey) {
      throw new AdapterError('Anthropic API key not configured', 'anthropic', 401, false);
    }

    const payload = this.formatPayload(req, targetModel, true);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      throw new AdapterError(`Network error reaching Anthropic: ${(err as Error).message}`, 'anthropic', 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const retryAfterHeader = res.headers.get('retry-after');
      let retryAfterMs: number | undefined;
      if (retryAfterHeader) {
        const secs = Number(retryAfterHeader);
        if (Number.isFinite(secs) && secs >= 0) {
          retryAfterMs = Math.round(secs * 1000);
        }
      }
      throw new AdapterError(
        `Anthropic stream error (${res.status}): ${errText}`,
        'anthropic',
        res.status,
        res.status === 429 || res.status === 529 || res.status >= 500,
        undefined,
        retryAfterMs
      );
    }

    if (!res.body) {
      throw new AdapterError('Anthropic response body stream is missing', 'anthropic', 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const id = `chatcmpl-anthropic-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let currentToolBlock: { index: number; id: string; name: string } | null = null;
    let promptTokens = 0;
    let completionTokens = 0;

    while (true) {
      const { done, value } = await readStreamWithInactivityTimeout(reader, req.timeout_ms || 120000, 'Anthropic');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') return;

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            index?: number;
            content_block?: { type: string; id?: string; name?: string };
            delta?: { type: string; text?: string; partial_json?: string };
            message?: { id: string; model: string; usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (event.type === 'message_start' && event.message?.usage) {
            promptTokens = event.message.usage.input_tokens || 0;
          } else if (event.type === 'message_delta' && event.usage) {
            completionTokens = event.usage.output_tokens || 0;
          } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            currentToolBlock = {
              index: event.index ?? 0,
              id: event.content_block.id || `call_${Date.now()}`,
              name: event.content_block.name || '',
            };
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model: targetModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: currentToolBlock.index,
                        id: currentToolBlock.id,
                        type: 'function',
                        function: {
                          name: currentToolBlock.name,
                          arguments: '',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.text) {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: targetModel,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  },
                ],
              };
            } else if (event.delta?.partial_json && currentToolBlock) {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: targetModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: currentToolBlock.index,
                          id: currentToolBlock.id,
                          type: 'function',
                          function: {
                            arguments: event.delta.partial_json,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            }
          } else if (event.type === 'content_block_stop') {
            currentToolBlock = null;
          } else if (event.type === 'message_stop') {
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model: targetModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
          }
        } catch {
          // ignore stream parse errors
        }
      }
    }
  }
}
