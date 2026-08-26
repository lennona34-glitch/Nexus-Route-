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

  // Models that reject an OpenAI-style `tools` payload outright. Everything else
  // is attempted with tools attached: both chatCompletion and streamChatCompletion
  // already retry without tools on a 400, so an unknown model degrades gracefully
  // instead of being silently stripped of every tool it can actually use.
  private static readonly NO_TOOL_SUPPORT = [
    'gemma', 'phi-2', 'phi3', 'tinyllama', 'orca-mini', 'stablelm', 'vicuna',
    'moondream', 'llava', 'bakllava', 'minicpm-v',
    'starcoder', 'codellama', 'wizardcoder', 'stable-code',
    'embed', 'bge-', 'nomic-',
  ];

  private isKnownToolCallingModel(modelName: string): boolean {
    const m = modelName.toLowerCase();
    return !LocalAdapter.NO_TOOL_SUPPORT.some(name => m.includes(name));
  }

  protected override buildPayload(req: UniversalRequest, targetModel: string, stream: boolean): Record<string, unknown> {
    const payload = super.buildPayload(req, targetModel, stream);
    const numCtx = Number(process.env.OLLAMA_NUM_CTX || 32768);
    (payload as any).options = {
      ...(typeof (payload as any).options === 'object' && (payload as any).options ? (payload as any).options : {}),
      num_ctx: numCtx,
    };
    return payload;
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
