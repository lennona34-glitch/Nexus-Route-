import fs from 'fs';
import path from 'path';
import { ProviderAdapter, AdapterError, readStreamWithInactivityTimeout } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType, ContentPart } from '../ir/types.js';
import { extractTextFromContent } from '../ir/validator.js';

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

async function resolveImageInlineData(rawUrl: string): Promise<{ mimeType: string; data: string } | null> {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();

  // 1. Data URL (e.g. data:image/png;base64,...)
  const dataMatch = trimmed.match(/^data:([^;,]+)(?:;charset=[^;,]+)?(?:;base64)?,([\s\S]+)$/i);
  if (dataMatch) {
    const mimeType = dataMatch[1].trim() || 'image/png';
    const data = dataMatch[2].replace(/\s+/g, '');
    return { mimeType, data };
  }

  // 2. Local workspace file path (e.g. /v1/workspace/files/art/...)
  let localPath = '';
  if (trimmed.startsWith('/v1/workspace/files/')) {
    const rel = decodeURIComponent(trimmed.slice('/v1/workspace/files/'.length));
    localPath = path.resolve(process.env.WORKSPACE_PATH || 'workspace', rel);
  } else if (trimmed.startsWith('art/') || trimmed.startsWith('workspace/')) {
    localPath = path.resolve(process.env.WORKSPACE_PATH || 'workspace', trimmed.replace(/^workspace[/\\]/, ''));
  } else if (fs.existsSync(trimmed)) {
    localPath = trimmed;
  }

  if (localPath && fs.existsSync(localPath)) {
    try {
      const ext = path.extname(localPath).toLowerCase();
      let mimeType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.svg') mimeType = 'image/svg+xml';
      const buf = fs.readFileSync(localPath);
      return { mimeType, data: buf.toString('base64') };
    } catch {}
  }

  // 3. Remote HTTP/HTTPS URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const res = await fetch(trimmed, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const contentType = res.headers.get('content-type') || 'image/png';
        const mimeType = contentType.split(';')[0].trim();
        const buf = Buffer.from(await res.arrayBuffer());
        return { mimeType, data: buf.toString('base64') };
      }
    } catch {}
  }

  return null;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'gemini';
  private baseUrl: string;
  private apiKey?: string;

  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = config?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = config?.apiKey || process.env.GEMINI_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private async formatPayload(req: UniversalRequest, fallbackToText = false) {
    let systemText = '';
    const contents: GeminiContent[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemText = (systemText ? systemText + '\n\n' : '') + extractTextFromContent(msg.content);
      } else if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];
        const textContent = (typeof msg.content === 'string' ? msg.content : (msg.content ? extractTextFromContent(msg.content) : '')).trim();
        if (textContent) {
          parts.push({ text: textContent });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const toolCallText = msg.tool_calls.map(tc => `[Executed tool: ${tc.function.name}(${tc.function.arguments || ''})]`).join('\n');
          parts.push({ text: toolCallText });
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        const toolResultText = extractTextFromContent(msg.content).trim() || 'Success';
        contents.push({
          role: 'user',
          parts: [{ text: `[Tool Result for ${msg.name || 'tool'}]: ${toolResultText}` }],
        });
      } else {
        const parts: GeminiPart[] = [];
        if (typeof msg.content === 'string') {
          const mdImgMatch = msg.content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^\)]+|\/v1\/workspace\/files\/[^\)]+|https?:\/\/[^\)]+)\)/);
          if (mdImgMatch) {
            const imgData = await resolveImageInlineData(mdImgMatch[1]);
            if (imgData) {
              parts.push({ inlineData: imgData });
            }
            const cleanText = msg.content.replace(mdImgMatch[0], '').trim();
            if (cleanText) parts.push({ text: cleanText });
          } else if (msg.content.trim()) {
            parts.push({ text: msg.content.trim() });
          }
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content as ContentPart[]) {
            if (part.type === 'text' && part.text?.trim()) {
              parts.push({ text: part.text.trim() });
            } else if (part.type === 'image_url') {
              const imgData = await resolveImageInlineData(part.image_url.url);
              if (imgData) {
                parts.push({ inlineData: imgData });
              }
            }
          }
        }
        if (parts.length === 0) {
          parts.push({ text: 'Hello' });
        }
        contents.push({ role: 'user', parts });
      }
    }

    // Strict turn alternation enforcement for Gemini: merge consecutive same-role messages
    const mergedContents: GeminiContent[] = [];
    for (const c of contents) {
      if (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === c.role) {
        mergedContents[mergedContents.length - 1].parts.push(...c.parts);
      } else {
        mergedContents.push({ role: c.role, parts: [...c.parts] });
      }
    }

    if (mergedContents.length === 0) {
      mergedContents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    const geminiTools = (!fallbackToText && req.tools && req.tools.length > 0) ? [
      {
        functionDeclarations: req.tools.map(t => ({
          name: t.function.name.replace(/^default_api:/, ''),
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ] : undefined;

    return {
      contents: mergedContents,
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      tools: geminiTools,
      generationConfig: {
        temperature: req.temperature,
        topP: req.top_p,
        maxOutputTokens: req.max_tokens || 65536,
      },
    };
  }

  private resolveModelName(targetModel: string): string {
    const m = targetModel.replace(/^gemini::/, '').replace(/^gemini\//, '').trim();
    if (m === 'gemini-flash' || m === 'gemini-2.5-flash' || m === 'gemini-2.0-flash') return 'gemini-3.6-flash';
    if (m === 'gemini-pro' || m === 'gemini-2.5-pro') return 'gemini-pro-latest';
    if (m === 'gemini-flash-lite' || m === 'gemini-2.5-flash-lite') return 'gemini-3.1-flash-lite';
    return m || 'gemini-3.6-flash';
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'NexusRoute/1.3.0 (+https://github.com/nexusroute/nexus-route)',
    };
  }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    if (!this.apiKey) {
      throw new AdapterError('Gemini API key not configured', 'gemini', 401, false);
    }

    let modelName = this.resolveModelName(targetModel);
    let url = `${this.baseUrl}/models/${modelName}:generateContent?key=${this.apiKey}`;
    let payload = await this.formatPayload(req, false);
    let res: Response | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
        });
      } catch (err: unknown) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new AdapterError(`Network error reaching Gemini: ${(err as Error).message}`, 'gemini', 503, true, err);
      }

      if (res.status === 429 || res.status >= 500) {
        const errText = await res.text().catch(() => '');
        const delayMatch = errText.match(/retry in ([0-9.]+)s/i) || errText.match(/"retryDelay":\s*"([0-9.]+)s"/i);
        const parsedWaitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) : 2500;
        if (parsedWaitMs > 3000 || attempt >= maxRetries) {
          throw new AdapterError(`Gemini rate-limited (429): ${errText}`, 'gemini', 429, true, undefined, parsedWaitMs);
        }
        await new Promise(r => setTimeout(r, parsedWaitMs));
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      const errText = await res?.text().catch(() => '') || '';
      const status = res?.status || 500;
      if (status === 404 && (errText.includes('no longer available') || errText.includes('NOT_FOUND'))) {
        const nextFallback = (modelName === 'gemini-3.6-flash') ? 'gemini-flash-latest' : 'gemini-3.6-flash';
        modelName = nextFallback;
        url = `${this.baseUrl}/models/${modelName}:generateContent?key=${this.apiKey}`;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const retryErr = await res.text().catch(() => '');
            throw new AdapterError(`Gemini error (${res.status}): ${retryErr}`, 'gemini', res.status, false);
          }
        } catch (e) {
          if (e instanceof AdapterError) throw e;
          throw new AdapterError(`Gemini error (${status}): ${errText}`, 'gemini', status, false);
        }
      } else if (status === 400 && (errText.includes('thought_signature') || errText.includes('INVALID_ARGUMENT'))) {
        payload = await this.formatPayload(req, true);
        try {
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (retryRes.ok) {
            res = retryRes;
          } else {
            const retryErr = await retryRes.text().catch(() => '');
            throw new AdapterError(`Gemini error (${retryRes.status}): ${retryErr}`, 'gemini', retryRes.status, false);
          }
        } catch (e) {
          if (e instanceof AdapterError) throw e;
          throw new AdapterError(`Gemini error (${status}): ${errText}`, 'gemini', status, false);
        }
      } else {
        let retryAfterMs = 4500;
        const delayMatch = errText.match(/retry in ([0-9.]+)s/i) || errText.match(/"retryDelay":\s*"([0-9.]+)s"/i);
        if (delayMatch) {
          retryAfterMs = Math.max(1000, Math.ceil(parseFloat(delayMatch[1]) * 1000));
        }
        throw new AdapterError(
          `Gemini error (${status}): ${errText}`,
          'gemini',
          status,
          status === 429 || status >= 500,
          undefined,
          retryAfterMs
        );
      }
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const candidate = data.candidates?.[0];
    const candidateParts = candidate?.content?.parts || [];
    let textContent = '';
    const toolCalls: UniversalResponse['choices'][0]['message']['tool_calls'] = [];

    for (const part of candidateParts) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    return {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    if (!this.apiKey) {
      throw new AdapterError('Gemini API key not configured', 'gemini', 401, false);
    }

    let modelName = this.resolveModelName(targetModel);
    let url = `${this.baseUrl}/models/${modelName}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    let payload = await this.formatPayload(req, false);
    let res: Response | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
        });
      } catch (err: unknown) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new AdapterError(`Network error reaching Gemini: ${(err as Error).message}`, 'gemini', 503, true, err);
      }

      if (res.status === 429 || res.status >= 500) {
        const errText = await res.text().catch(() => '');
        const delayMatch = errText.match(/retry in ([0-9.]+)s/i) || errText.match(/"retryDelay":\s*"([0-9.]+)s"/i);
        const parsedWaitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) : 2500;
        if (parsedWaitMs > 3000 || attempt >= maxRetries) {
          throw new AdapterError(`Gemini stream rate-limited (429): ${errText}`, 'gemini', 429, true, undefined, parsedWaitMs);
        }
        await new Promise(r => setTimeout(r, parsedWaitMs));
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      const errText = await res?.text().catch(() => '') || '';
      const status = res?.status || 500;
      if (status === 404 && (errText.includes('no longer available') || errText.includes('NOT_FOUND'))) {
        const nextFallback = (modelName === 'gemini-3.6-flash') ? 'gemini-flash-latest' : 'gemini-3.6-flash';
        modelName = nextFallback;
        url = `${this.baseUrl}/models/${modelName}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const retryErr = await res.text().catch(() => '');
            throw new AdapterError(`Gemini stream error (${res.status}): ${retryErr}`, 'gemini', res.status, false);
          }
        } catch (e) {
          if (e instanceof AdapterError) throw e;
          throw new AdapterError(`Gemini stream error (${status}): ${errText}`, 'gemini', status, false);
        }
      } else if (status === 400 && (errText.includes('thought_signature') || errText.includes('INVALID_ARGUMENT'))) {
        payload = await this.formatPayload(req, true);
        try {
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (retryRes.ok) {
            res = retryRes;
          } else {
            const retryErr = await retryRes.text().catch(() => '');
            throw new AdapterError(`Gemini stream error (${retryRes.status}): ${retryErr}`, 'gemini', retryRes.status, false);
          }
        } catch (e) {
          if (e instanceof AdapterError) throw e;
          throw new AdapterError(`Gemini stream error (${status}): ${errText}`, 'gemini', status, false);
        }
      } else {
        let retryAfterMs = 4500;
        const delayMatch = errText.match(/retry in ([0-9.]+)s/i) || errText.match(/"retryDelay":\s*"([0-9.]+)s"/i);
        if (delayMatch) {
          retryAfterMs = Math.max(1000, Math.ceil(parseFloat(delayMatch[1]) * 1000));
        }
        throw new AdapterError(
          `Gemini stream error (${status}): ${errText}`,
          'gemini',
          status,
          status === 429 || status >= 500,
          undefined,
          retryAfterMs
        );
      }
    }

    if (!res.body) {
      throw new AdapterError('Gemini stream has no body', 'gemini', 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const id = `chatcmpl-gemini-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    while (true) {
      const { done, value } = await readStreamWithInactivityTimeout(reader, req.timeout_ms || 120000, 'Gemini');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);

        try {
          const chunk = JSON.parse(jsonStr) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
              finishReason?: string;
            }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
            error?: { code?: number; message?: string };
            promptFeedback?: { blockReason?: string };
          };

          if (chunk.error) {
            throw new AdapterError(`Gemini stream error (${chunk.error.code || 500}): ${chunk.error.message || 'Unknown error'}`, 'gemini', chunk.error.code || 500, chunk.error.code === 429 || (chunk.error.code !== undefined && chunk.error.code >= 500));
          }
          if (chunk.promptFeedback?.blockReason) {
            throw new AdapterError(`Gemini response blocked by safety policy: ${chunk.promptFeedback.blockReason}`, 'gemini', 400, false);
          }

          if (chunk.usageMetadata) {
            promptTokens = chunk.usageMetadata.promptTokenCount || promptTokens;
            completionTokens = chunk.usageMetadata.candidatesTokenCount || completionTokens;
            totalTokens = chunk.usageMetadata.totalTokenCount || totalTokens;
          }

          const candidate = chunk.candidates?.[0];
          const candidateParts = candidate?.content?.parts || [];
          for (const part of candidateParts) {
            if (part.text) {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: { content: part.text },
                    finish_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : null,
                  },
                ],
              };
            }
            if (part.functionCall) {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${Date.now()}`,
                          type: 'function',
                          function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {}),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
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
        total_tokens: totalTokens || (promptTokens + completionTokens),
      },
    };
  }
}
