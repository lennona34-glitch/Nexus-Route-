import { ProviderAdapter, AdapterError } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, UniversalUsage, ProviderType } from '../ir/types.js';
import { extractTextFromContent } from '../ir/validator.js';

export class MockAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'mock';
  private static chaosTriggeredModels = new Set<string>();

  public static setChaos(model: string, fail: boolean) {
    if (fail) {
      this.chaosTriggeredModels.add(model);
    } else {
      this.chaosTriggeredModels.delete(model);
    }
  }

  public static clearChaos() {
    this.chaosTriggeredModels.clear();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private generateMockReply(req: UniversalRequest, targetModel: string): string {
    const lastMsg = req.messages[req.messages.length - 1];
    const userPrompt = lastMsg ? extractTextFromContent(lastMsg.content) : 'Hello';

    if (userPrompt.toLowerCase().includes('code') || userPrompt.toLowerCase().includes('function') || targetModel.includes('coding')) {
      return `\`\`\`typescript\n// Synthesized by NexusRoute [${targetModel}]\nexport function solve(): string {\n  return "Execution successful on ${targetModel}";\n}\n\`\`\``;
    }

    if (userPrompt.toLowerCase().includes('think') || userPrompt.toLowerCase().includes('why') || targetModel.includes('reasoning') || targetModel.includes('o3')) {
      return `Here is a step-by-step breakdown from **${targetModel}**:\n\n1. **Context Assessment**: Analyzed user intent ("${userPrompt.slice(0, 40)}...").\n2. **Synthesis**: Evaluated multi-provider constraints and routing parameters.\n3. **Conclusion**: The unified routing pipeline dispatched this to ${targetModel} flawlessly.`;
    }

    return `Hello from **${targetModel}**! (Routed via NexusRoute)\n\nI received your request: "${userPrompt}". The request was successfully received and processed by the unified gateway.`;
  }

  private checkChaos(targetModel: string) {
    if (targetModel.includes('fail') || MockAdapter.chaosTriggeredModels.has(targetModel)) {
      throw new AdapterError(
        `Rate limit exceeded / 429 Too Many Requests on ${targetModel}`,
        'mock',
        429,
        true
      );
    }
  }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    this.checkChaos(targetModel);

    // Simulate minor network latency (30-60ms)
    await new Promise(r => setTimeout(r, 40));

    const reply = this.generateMockReply(req, targetModel);
    const promptText = req.messages.map(m => extractTextFromContent(m.content)).join(' ');
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
    const completionTokens = Math.max(1, Math.ceil(reply.length / 4));

    const usage: UniversalUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    return {
      id: `chatcmpl-mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: reply,
          },
          finish_reason: 'stop',
        },
      ],
      usage,
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.checkChaos(targetModel);

    const reply = this.generateMockReply(req, targetModel);
    const id = `chatcmpl-mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const created = Math.floor(Date.now() / 1000);

    // First chunk: Role
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: targetModel,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    };

    // Split into realistic word/token chunks
    const words = reply.split(/(\s+)/);
    for (const word of words) {
      await new Promise(r => setTimeout(r, 15));
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model: targetModel,
        choices: [
          {
            index: 0,
            delta: { content: word },
            finish_reason: null,
          },
        ],
      };
    }

    // Final chunk: finish_reason
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
        prompt_tokens: 15,
        completion_tokens: Math.ceil(reply.length / 4),
        total_tokens: 15 + Math.ceil(reply.length / 4),
      },
    };
  }
}
