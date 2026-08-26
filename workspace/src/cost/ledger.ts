export interface TokenBreakdown {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens: number;
}

export interface ModelPricing {
  promptCostPer1k: number;
  completionCostPer1k: number;
  reasoningCostPer1k?: number;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { promptCostPer1k: 0.0025, completionCostPer1k: 0.010 },
  'gpt-4o-mini': { promptCostPer1k: 0.00015, completionCostPer1k: 0.0006 },
  'o1': { promptCostPer1k: 0.015, completionCostPer1k: 0.060, reasoningCostPer1k: 0.060 },
  'o3-mini': { promptCostPer1k: 0.0011, completionCostPer1k: 0.0044, reasoningCostPer1k: 0.0044 },

  // Anthropic
  'claude-3-5-sonnet-20241022': { promptCostPer1k: 0.003, completionCostPer1k: 0.015 },
  'claude-haiku-4-5-20251001': { promptCostPer1k: 0.0008, completionCostPer1k: 0.004 },

  // Gemini
  'gemini-flash-latest': { promptCostPer1k: 0.000075, completionCostPer1k: 0.0003 },
  'gemini-pro-latest': { promptCostPer1k: 0.00125, completionCostPer1k: 0.005 },

  // Groq (Cheapest / Ultra-fast)
  'qwen/qwen3.6-27b': { promptCostPer1k: 0.0002, completionCostPer1k: 0.0006 },
  'openai/gpt-oss-120b': { promptCostPer1k: 0.0005, completionCostPer1k: 0.0015 },

  // DeepSeek Direct
  'deepseek-chat': { promptCostPer1k: 0.00014, completionCostPer1k: 0.00028 },
  'deepseek-reasoner': { promptCostPer1k: 0.00055, completionCostPer1k: 0.00219, reasoningCostPer1k: 0.00219 },

  // GitHub Models / Local GPU (100% Free)
  'github/gpt-4o': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'github/gpt-4o-mini': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'github/o3-mini': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'github/deepseek-r1': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'github/meta-llama-3.3-70b': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'local/dolphin-roaster': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'local/dolphin-maverick': { promptCostPer1k: 0, completionCostPer1k: 0 },
  'local/wizard-coder': { promptCostPer1k: 0, completionCostPer1k: 0 },
};

export interface LedgerEntry {
  id: string;
  timestamp: number;
  model: string;
  provider: string;
  virtualKeyMasked?: string;
  tokens: TokenBreakdown;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
}

export class CostLedger {
  private entries: LedgerEntry[] = [];
  private maxEntries = 500;
  private totalCostUsd = 0;
  private totalTokens = 0;
  private totalSavedCostUsd = 0;

  public recordCompletion(
    model: string,
    provider: string,
    tokens: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; total_tokens?: number },
    latencyMs: number,
    cached: boolean = false,
    virtualKeyMasked?: string
  ): LedgerEntry {
    const pricing = PRICING_TABLE[model] || { promptCostPer1k: 0.001, completionCostPer1k: 0.002 };
    const pTokens = tokens.prompt_tokens || 0;
    const cTokens = tokens.completion_tokens || 0;
    const rTokens = tokens.reasoning_tokens || 0;
    const tTokens = tokens.total_tokens || (pTokens + cTokens + rTokens);

    let cost = 0;
    if (!cached) {
      cost = (pTokens / 1000) * pricing.promptCostPer1k +
             (cTokens / 1000) * pricing.completionCostPer1k +
             (rTokens / 1000) * (pricing.reasoningCostPer1k || pricing.completionCostPer1k);
    } else {
      // Estimated savings from cache
      const saved = (pTokens / 1000) * pricing.promptCostPer1k + (cTokens / 1000) * pricing.completionCostPer1k;
      this.totalSavedCostUsd += saved;
    }

    const entry: LedgerEntry = {
      id: `ledg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      model,
      provider,
      virtualKeyMasked,
      tokens: {
        promptTokens: pTokens,
        completionTokens: cTokens,
        reasoningTokens: rTokens,
        totalTokens: tTokens,
      },
      costUsd: Number(cost.toFixed(6)),
      latencyMs,
      cached,
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }

    this.totalCostUsd += cost;
    this.totalTokens += tTokens;

    return entry;
  }

  public getSummary() {
    return {
      totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
      totalTokens: this.totalTokens,
      totalSavedCostUsd: Number(this.totalSavedCostUsd.toFixed(6)),
      recentEntries: this.entries.slice(0, 50),
      byModel: this.getAggregatedByModel(),
      byProvider: this.getAggregatedByProvider(),
    };
  }

  public clear() {
    this.entries = [];
    this.totalCostUsd = 0;
    this.totalTokens = 0;
    this.totalSavedCostUsd = 0;
  }

  private getAggregatedByModel(): Record<string, { count: number; cost: number; tokens: number }> {
    const acc: Record<string, { count: number; cost: number; tokens: number }> = {};
    for (const e of this.entries) {
      if (!acc[e.model]) {
        acc[e.model] = { count: 0, cost: 0, tokens: 0 };
      }
      acc[e.model].count++;
      acc[e.model].cost = Number((acc[e.model].cost + e.costUsd).toFixed(6));
      acc[e.model].tokens += e.tokens.totalTokens;
    }
    return acc;
  }

  private getAggregatedByProvider(): Record<string, { count: number; cost: number; tokens: number }> {
    const acc: Record<string, { count: number; cost: number; tokens: number }> = {};
    for (const e of this.entries) {
      if (!acc[e.provider]) {
        acc[e.provider] = { count: 0, cost: 0, tokens: 0 };
      }
      acc[e.provider].count++;
      acc[e.provider].cost = Number((acc[e.provider].cost + e.costUsd).toFixed(6));
      acc[e.provider].tokens += e.tokens.totalTokens;
    }
    return acc;
  }
}

export const GlobalCostLedger = new CostLedger();
