import { UniversalStreamChunk } from '../ir/types.js';

export function formatSseChunk(chunk: UniversalStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function formatSseDone(): string {
  return `data: [DONE]\n\n`;
}

export function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
