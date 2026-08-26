import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compressMessages, recoverRawContext } from '../src/context/compression.js';
import type { UniversalMessage } from '../src/ir/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('recoverable context compression', () => {
  it('compacts only old large output and recovers the exact original', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusroute-context-'));
    tempDirs.push(workspace);
    const largeOutput = `tool heading\n${'exact tool data '.repeat(220)}`;
    const recent = 'recent message must stay byte-for-byte intact';
    const messages: UniversalMessage[] = [
      { role: 'tool', tool_call_id: 'call_old', content: largeOutput },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
      { role: 'assistant', content: recent },
    ];

    const result = compressMessages(messages, workspace, 6);
    expect(result.stats.savedChars).toBeGreaterThan(0);
    expect(result.stats.rawIds).toHaveLength(1);
    expect(result.messages[0].content).toContain('Raw context id:');
    expect(result.messages[6]).toEqual(messages[6]);

    const recovered = recoverRawContext(workspace, result.stats.rawIds[0]);
    expect(recovered?.content).toBe(largeOutput);
  });
});
