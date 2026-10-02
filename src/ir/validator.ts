import { UniversalRequest, UniversalMessage, ContentPart } from './types.js';

export class ValidationError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateAndNormalizeRequest(payload: unknown): UniversalRequest {
  if (!payload || typeof payload !== 'object') {
    throw new ValidationError('Request body must be a valid JSON object.');
  }

  const raw = payload as Record<string, unknown>;

  if (!raw.model || typeof raw.model !== 'string') {
    throw new ValidationError('Missing or invalid "model" field in request.');
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ValidationError('Request must include a non-empty "messages" array.');
  }

  const normalizedMessages: UniversalMessage[] = raw.messages.map((m, idx) => {
    if (!m || typeof m !== 'object') {
      throw new ValidationError(`Message at index ${idx} is not an object.`);
    }
    const msg = m as Record<string, unknown>;
    const role = msg.role;
    if (!['system', 'user', 'assistant', 'tool'].includes(role as string)) {
      throw new ValidationError(`Invalid role "${role}" at message index ${idx}.`);
    }

    let content: string | ContentPart[] = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content as ContentPart[];
    } else if (msg.content === null && role === 'assistant' && Array.isArray(msg.tool_calls)) {
      content = '';
    } else {
      throw new ValidationError(`Invalid content type at message index ${idx}. Expected string or array.`);
    }

    return {
      role: role as UniversalMessage['role'],
      content,
      name: typeof msg.name === 'string' ? msg.name : undefined,
      tool_calls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as UniversalMessage['tool_calls']) : undefined,
      tool_call_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined,
    };
  });

  return {
    model: raw.model,
    messages: normalizedMessages,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.7,
    top_p: typeof raw.top_p === 'number' ? raw.top_p : undefined,
    max_tokens: typeof raw.max_tokens === 'number' ? raw.max_tokens : undefined,
    stream: typeof raw.stream === 'boolean' ? raw.stream : false,
    tools: Array.isArray(raw.tools) ? (raw.tools as UniversalRequest['tools']) : undefined,
    tool_choice: raw.tool_choice as UniversalRequest['tool_choice'],
    response_format: raw.response_format as UniversalRequest['response_format'],
    stop: typeof raw.stop === 'string' || Array.isArray(raw.stop) ? raw.stop : undefined,
    user: typeof raw.user === 'string' ? raw.user : undefined,
    session_id: typeof raw.session_id === 'string' ? raw.session_id.slice(0, 200) : undefined,
    openrouter_routing: ['free', 'balanced', 'cheapest', 'fastest', 'tools'].includes(String(raw.openrouter_routing))
      ? raw.openrouter_routing as UniversalRequest['openrouter_routing']
      : undefined,
    metadata: typeof raw.metadata === 'object' && raw.metadata !== null ? (raw.metadata as Record<string, unknown>) : undefined,
    art_engine: typeof raw.art_engine === 'string' ? raw.art_engine : undefined,
    enable_tools: typeof raw.enable_tools === 'boolean' ? raw.enable_tools : undefined,
    ui_origin: typeof raw.ui_origin === 'string' ? (raw.ui_origin as UniversalRequest['ui_origin']) : undefined,
    reasoning_effort: ['none', 'low', 'medium', 'high'].includes(String(raw.reasoning_effort))
      ? (raw.reasoning_effort as UniversalRequest['reasoning_effort'])
      : undefined,
    caveman_mode: typeof raw.caveman_mode === 'boolean' ? raw.caveman_mode : undefined,
    routing_mode: ['smart_failover', 'fixed'].includes(String(raw.routing_mode))
      ? (raw.routing_mode as UniversalRequest['routing_mode'])
      : undefined,
    fixed_provider_mode: typeof raw.fixed_provider_mode === 'boolean' ? raw.fixed_provider_mode : undefined,
    timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : undefined,
  };
}

export function extractTextFromContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}
