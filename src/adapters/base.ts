import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType } from '../ir/types.js';

export interface ProviderAdapter {
  readonly provider: ProviderType;
  chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse>;
  streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk>;
  isAvailable(): Promise<boolean>;
}

export async function readStreamWithInactivityTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  label: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const safeTimeoutMs = Math.max(5000, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reader.cancel(`${label} stream inactive`).catch(() => {});
          reject(new Error(`${label} stream produced no data for ${Math.round(safeTimeoutMs / 1000)} seconds`));
        }, safeTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public provider: ProviderType,
    public statusCode: number = 500,
    public isRetryable: boolean = true,
    public rawError?: unknown,
    public retryAfterMs?: number,
  ) {
    super(`[${provider.toUpperCase()}] ${message}`);
    this.name = 'AdapterError';
  }
}
