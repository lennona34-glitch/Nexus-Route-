import type { ProviderType, UniversalUsage } from '../ir/types.js';

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sumOptional(left: unknown, right: unknown): number | undefined {
  const a = finite(left);
  const b = finite(right);
  if (a === undefined && b === undefined) return undefined;
  return (a || 0) + (b || 0);
}

export function mergeUsage(total: UniversalUsage | undefined, next: UniversalUsage | undefined): UniversalUsage | undefined {
  if (!next) return total ? structuredClone(total) : undefined;
  if (!total) return structuredClone(next);

  const merged: UniversalUsage = {
    ...total,
    ...next,
    prompt_tokens: (total.prompt_tokens || 0) + (next.prompt_tokens || 0),
    completion_tokens: (total.completion_tokens || 0) + (next.completion_tokens || 0),
    total_tokens: (total.total_tokens || 0) + (next.total_tokens || 0),
  };

  const cost = sumOptional(total.cost, next.cost);
  if (cost !== undefined) merged.cost = cost;
  const cacheDiscount = sumOptional(total.cache_discount, next.cache_discount);
  if (cacheDiscount !== undefined) merged.cache_discount = cacheDiscount;

  const cachedTokens = sumOptional(total.prompt_tokens_details?.cached_tokens, next.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = sumOptional(total.prompt_tokens_details?.cache_write_tokens, next.prompt_tokens_details?.cache_write_tokens);
  const audioTokens = sumOptional(total.prompt_tokens_details?.audio_tokens, next.prompt_tokens_details?.audio_tokens);
  if (cachedTokens !== undefined || cacheWriteTokens !== undefined || audioTokens !== undefined) {
    merged.prompt_tokens_details = {
      ...total.prompt_tokens_details,
      ...next.prompt_tokens_details,
      ...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
      ...(audioTokens !== undefined ? { audio_tokens: audioTokens } : {}),
    };
  }

  const reasoningTokens = sumOptional(total.completion_tokens_details?.reasoning_tokens, next.completion_tokens_details?.reasoning_tokens);
  if (reasoningTokens !== undefined) {
    merged.completion_tokens_details = {
      ...total.completion_tokens_details,
      ...next.completion_tokens_details,
      reasoning_tokens: reasoningTokens,
    };
  }

  const upstreamCost = sumOptional(total.cost_details?.upstream_inference_cost, next.cost_details?.upstream_inference_cost);
  if (upstreamCost !== undefined) {
    merged.cost_details = {
      ...total.cost_details,
      ...next.cost_details,
      upstream_inference_cost: upstreamCost,
    };
  }

  return merged;
}

export function finalizeUsageCost(
  provider: ProviderType,
  usage: UniversalUsage,
  estimatedCostUsd: number,
): UniversalUsage {
  const providerCost = provider === 'openrouter' ? finite(usage.cost) : undefined;
  usage.estimated_cost_usd = providerCost !== undefined ? Math.max(0, providerCost) : Math.max(0, estimatedCostUsd);
  usage.cost_source = providerCost !== undefined ? 'provider' : 'estimated';
  return usage;
}

export function zeroUsageCostForCache(usage: UniversalUsage): UniversalUsage {
  const originalCost = finite(usage.estimated_cost_usd) ?? finite(usage.cost) ?? 0;
  return {
    ...structuredClone(usage),
    cost: 0,
    estimated_cost_usd: 0,
    cache_savings_usd: Math.max(0, originalCost),
    cost_source: 'cache',
  };
}
