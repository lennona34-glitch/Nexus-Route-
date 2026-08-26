import { describe, expect, it } from 'vitest';
import { app } from '../src/server.js';

describe('NexusRoute MCP endpoint', () => {
  it('negotiates the current protocol and advertises tools', async () => {
    const initialize = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.protocolVersion).toBe('2025-11-25');

    const list = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(list.statusCode).toBe(200);
    const names = list.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('calculator');
    expect(names).toContain('recover_raw_context');
  });

  it('executes a tool through JSON-RPC', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 'calculation',
        method: 'tools/call',
        params: { name: 'calculator', arguments: { expression: '6 * 7' } },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).toBe(false);
    expect(response.json().result.content[0].text).toContain('42');
  });
});
