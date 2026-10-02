import type { UniversalRequest } from '../ir/types.js';

const DEFAULT_GROQ_TPM_LIMIT = 30_000;
const DEFAULT_SAFETY_RATIO = 0.95;
const MIN_USEFUL_COMPLETION_TOKENS = 512;

export interface GroqRequestBudget {
  limit: number;
  safetyLimit: number;
  estimatedPromptTokens: number;
  requestedCompletionTokens: number;
  maxCompletionTokens: number;
  allowed: boolean;
  reason?: string;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Conservative estimate for routing decisions. JSON-heavy tool schemas and
 * code tokenize less efficiently than ordinary English, so chars/2.2 plus a
 * small structural allowance is intentionally safer than the former chars/3.
 */
export function estimateGroqPromptTokens(req: UniversalRequest): number {
  const messageChars = JSON.stringify(req.messages || []).length;
  const toolChars = JSON.stringify(req.tools || []).length;
  const formatChars = JSON.stringify(req.response_format || {}).length;
  const messageOverhead = (req.messages?.length || 0) * 12;
  const toolOverhead = (req.tools?.length || 0) * 24;
  return Math.ceil((messageChars + toolChars + formatChars) / 2.2) + messageOverhead + toolOverhead;
}

export function getGroqRequestBudget(req: UniversalRequest): GroqRequestBudget {
  const limit = Math.floor(positiveNumber(process.env.GROQ_TPM_LIMIT, DEFAULT_GROQ_TPM_LIMIT));
  const ratio = Math.min(0.98, positiveNumber(process.env.GROQ_TPM_SAFETY_RATIO, DEFAULT_SAFETY_RATIO));
  const safetyLimit = Math.max(2_000, Math.floor(limit * ratio));
  const estimatedPromptTokens = estimateGroqPromptTokens(req);
  const requestedCompletionTokens = Math.max(1, req.max_tokens || 8_192);
  const availableCompletionTokens = safetyLimit - estimatedPromptTokens;
  const maxCompletionTokens = availableCompletionTokens > 0
    ? Math.min(requestedCompletionTokens, Math.min(8192, availableCompletionTokens))
    : 0;
  const minimumRequired = Math.min(requestedCompletionTokens, MIN_USEFUL_COMPLETION_TOKENS);
  const allowed = availableCompletionTokens >= minimumRequired && maxCompletionTokens >= minimumRequired;

  return {
    limit,
    safetyLimit,
    estimatedPromptTokens,
    requestedCompletionTokens,
    maxCompletionTokens,
    allowed,
    reason: allowed
      ? undefined
      : `Groq skipped: estimated ${estimatedPromptTokens.toLocaleString()} prompt tokens leave less than ${minimumRequired.toLocaleString()} completion tokens inside the ${limit.toLocaleString()} TPM limit.`,
  };
}
