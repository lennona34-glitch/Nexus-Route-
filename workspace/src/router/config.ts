export interface RouterConfig {
  defaultProvider?: string;
  enableFallback?: boolean;
  enableRetry?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  costOptimization?: boolean;
  latencyOptimization?: boolean;
  modelAliases?: Record<string, string>;
  modelMappings?: Record<string, { provider: string; model: string }>;
  providerPriority?: string[];
}

export const DEFAULT_MODEL_MAPPINGS: Record<string, { provider: string; model: string }> = {
  // DeepSeek
  'deepseek-chat': { provider: 'deepseek', model: 'deepseek-chat' },
  'deepseek-v3': { provider: 'deepseek', model: 'deepseek-chat' },
  'deepseek-reasoner': { provider: 'deepseek', model: 'deepseek-reasoner' },
  'deepseek-r1': { provider: 'deepseek', model: 'deepseek-reasoner' },

  // Groq
  'llama-3.3-70b-versatile': { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  'llama-3.1-8b-instant': { provider: 'groq', model: 'llama-3.1-8b-instant' },
  'mixtral-8x7b-32768': { provider: 'groq', model: 'mixtral-8x7b-32768' },
  'groq/llama3': { provider: 'groq', model: 'llama-3.3-70b-versatile' },

  // OpenRouter
  'openrouter/auto': { provider: 'openrouter', model: 'openrouter/auto' },

  // OpenAI
  'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  'gpt-4-turbo': { provider: 'openai', model: 'gpt-4-turbo' },
  'gpt-3.5-turbo': { provider: 'openai', model: 'gpt-3.5-turbo' },
  'o1': { provider: 'openai', model: 'o1' },
  'o1-mini': { provider: 'openai', model: 'o1-mini' },
  'o3-mini': { provider: 'openai', model: 'o3-mini' },

  // Anthropic
  'claude-3-5-sonnet-20241022': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  'claude-3-5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  'claude-3-5-haiku-20241022': { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
  'claude-3-opus-20240229': { provider: 'anthropic', model: 'claude-3-opus-20240229' },
  'claude-3-opus': { provider: 'anthropic', model: 'claude-3-opus-20240229' },

  // Gemini
  'gemini-1.5-pro': { provider: 'gemini', model: 'gemini-1.5-pro' },
  'gemini-1.5-pro-latest': { provider: 'gemini', model: 'gemini-1.5-pro' },
  'gemini-1.5-flash': { provider: 'gemini', model: 'gemini-1.5-flash' },
  'gemini-1.5-flash-latest': { provider: 'gemini', model: 'gemini-1.5-flash' },
  'gemini-2.0-flash-exp': { provider: 'gemini', model: 'gemini-2.0-flash-exp' },
};
