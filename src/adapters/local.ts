import { OpenAIAdapter } from './openai.js';
import { ProviderType, UniversalRequest, UniversalResponse, UniversalStreamChunk } from '../ir/types.js';
import { AdapterError } from './base.js';

export class LocalAdapter extends OpenAIAdapter {
  override readonly provider: ProviderType = 'local';

  constructor(config?: { baseUrl?: string }) {
    super({
      baseUrl: config?.baseUrl || process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
      apiKey: 'local',
    });
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private cleanModelName(targetModel: string): string {
    let m = targetModel;
    if (m.startsWith('local/')) m = m.slice(6);
    if (m.startsWith('ollama/')) m = m.slice(7);
    if (m === 'free') m = 'qwen2.5-coder:7b';
    return m;
  }

  private isKnownToolCallingModel(modelName: string): boolean {
    const m = modelName.toLowerCase();
    return m.includes('qwen2.5-coder') || m.includes('llama3.1') || m.includes('llama3.2') || m.includes('mistral-nemo');
  }

  override async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    const modelToUse = this.cleanModelName(targetModel);

    // If model does not natively support OpenAI tools in Ollama, strip tools from HTTP payload to avoid 400 error
    const shouldOmitTools = req.tools && !this.isKnownToolCallingModel(modelToUse);
    const effectiveReq = shouldOmitTools ? { ...req, tools: undefined, tool_choice: undefined } : req;

    let resp: UniversalResponse;
    try {
      resp = await super.chatCompletion(effectiveReq, modelToUse);
    } catch (err: unknown) {
      if (err instanceof AdapterError && (err.message.includes('does not support tools') || err.statusCode === 400) && req.tools) {
        resp = await super.chatCompletion({ ...req, tools: undefined, tool_choice: undefined }, modelToUse);
      } else {
        throw err;
      }
    }

    const msg = resp.choices?.[0]?.message;

    // Parse JSON tool calls emitted in content by Ollama / Dolphin / Qwen / Llama
    if (msg && msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      const trimmed = msg.content.trim();
      let parsedJson: { name?: string; arguments?: Record<string, unknown> | string } | null = null;

      try {
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          parsedJson = JSON.parse(trimmed);
        } else {
          const match = trimmed.match(/<tool_call>([\s\S]*?)<\/tool_call>/) || trimmed.match(/```json\s*(\{[\s\S]*?\})\s*```/);
          if (match) {
            parsedJson = JSON.parse(match[1]);
          }
        }
      } catch {}

      if (parsedJson && parsedJson.name) {
        msg.tool_calls = [
          {
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
              name: parsedJson.name,
              arguments: typeof parsedJson.arguments === 'string' ? parsedJson.arguments : JSON.stringify(parsedJson.arguments || {}),
            },
          },
        ];
        msg.content = '';
      }
    }
    return resp;
  }

  override async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    const modelToUse = this.cleanModelName(targetModel);

    // If model does not natively support OpenAI tools in Ollama, strip tools from HTTP payload to avoid 400 error
    const shouldOmitTools = req.tools && !this.isKnownToolCallingModel(modelToUse);
    const effectiveReq = shouldOmitTools ? { ...req, tools: undefined, tool_choice: undefined } : req;

    try {
      yield* super.streamChatCompletion(effectiveReq, modelToUse);
    } catch (err: unknown) {
      if (err instanceof AdapterError && (err.message.includes('does not support tools') || err.statusCode === 400) && req.tools) {
        yield* super.streamChatCompletion({ ...req, tools: undefined, tool_choice: undefined }, modelToUse);
      } else {
        throw err;
      }
    }
  }
}
