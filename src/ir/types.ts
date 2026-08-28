export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface UniversalMessage {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface UniversalRequest {
  model: string; // Can be a virtual alias ("auto", "fast") or a concrete model ID ("gpt-4o")
  messages: UniversalMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; [key: string]: unknown };
  stop?: string | string[];
  user?: string;
  session_id?: string;
  openrouter_routing?: 'free' | 'balanced' | 'cheapest' | 'fastest' | 'tools';
  art_engine?: 'cloud' | 'gpu' | 'together' | 'huggingface' | 'openai' | 'imagen' | 'auto' | string;
  enable_tools?: boolean;
  timeout_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface UniversalUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  cost_details?: {
    upstream_inference_cost?: number;
    [key: string]: unknown;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  cache_discount?: number;
  cache_savings_usd?: number;
  estimated_cost_usd?: number;
  cost_source?: 'provider' | 'estimated' | 'cache';
}

export interface UniversalChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface UniversalResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: UniversalChoice[];
  usage: UniversalUsage;
  system_fingerprint?: string;
  cache_discount?: number;
  route_info?: RouteMetadata;
}

export interface UniversalStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }[];
  usage?: UniversalUsage;
  cache_discount?: number;
  route_info?: RouteMetadata;
}

export interface RouteMetadata {
  request_id?: string;
  route_stage?: 'selected' | 'completed';
  requested_model: string;
  selected_provider: string;
  selected_model: string;
  routing_strategy: string;
  attempts: Array<{
    provider: string;
    model: string;
    connection_id?: string;
    connection_label?: string;
    status: 'success' | 'failed';
    error?: string;
    latency_ms: number;
  }>;
  total_latency_ms: number;
  selected_connection_id?: string;
  selected_connection_label?: string;
  decision_reasons?: string[];
  cached?: boolean;
  classification?: {
    category: string;
    complexityScore: number;
    recommendedTier: string;
    paretoExplanation: string;
  };
  tools_executed?: string[];
  compression?: {
    original_chars: number;
    compressed_chars: number;
    saved_chars: number;
    raw_blocks_stored: number;
    raw_ids: string[];
  };
  files_written?: Array<{
    filename: string;
    full_path: string;
    bytes_written: number;
  }>;
  turn_count?: number;
}

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'xai'
  | 'openrouter'
  | 'github'
  | 'together'
  | 'huggingface'
  | 'qwen'
  | 'local'
  | 'ollama'
  | 'mock';

export interface ProviderConfig {
  base_url?: string;
  api_key?: string;
  api_key_env?: string;
  enabled?: boolean;
}

export interface ModelCapability {
  id: string;
  provider: ProviderType;
  displayName: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}
