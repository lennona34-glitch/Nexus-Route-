import { ToolRegistry } from '../tools/registry.js';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];

function result(id: string | number, value: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function getMcpInfo() {
  return {
    name: 'NexusRoute Tools',
    transport: 'Streamable HTTP (stateless JSON responses)',
    endpoint: 'http://127.0.0.1:3000/mcp',
    protocolVersions: SUPPORTED_PROTOCOLS,
    toolCount: ToolRegistry.getBuiltInTools().length,
    explanation: 'MCP lets another AI application discover and call NexusRoute tools through a standard JSON-RPC interface.',
    clientConfig: {
      mcpServers: {
        nexusroute: {
          type: 'http',
          url: 'http://127.0.0.1:3000/mcp',
        },
      },
    },
  };
}

export async function handleMcpMessage(body: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return error(body?.id ?? null, -32600, 'Invalid JSON-RPC request');
  }

  // Notifications intentionally receive HTTP 202 with no JSON-RPC response.
  if (body.id === undefined) return null;
  const id = body.id;

  if (body.method === 'initialize') {
    const requested = String((body.params as any)?.protocolVersion || '2025-03-26');
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
    return result(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'nexusroute', title: 'NexusRoute Local Tools', version: '1.3.0' },
      instructions: 'Local Windows tools are workspace-scoped. File writes are verified on disk. Use recover_raw_context when a compacted result contains a raw context id.',
    });
  }

  if (body.method === 'ping') return result(id, {});

  if (body.method === 'tools/list') {
    const tools = ToolRegistry.getBuiltInTools()
      .map(tool => ({
        name: tool.function.name,
        description: tool.function.description || '',
        inputSchema: tool.function.parameters || { type: 'object', properties: {} },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return result(id, { tools });
  }

  if (body.method === 'tools/call') {
    const name = String((body.params as any)?.name || '').trim();
    const args = (body.params as any)?.arguments;
    if (!name) return error(id, -32602, 'tools/call requires params.name');
    const known = ToolRegistry.getBuiltInTools().some(tool => tool.function.name === name);
    if (!known) return error(id, -32602, `Unknown NexusRoute tool: ${name}`);
    try {
      const output = await ToolRegistry.executeTool(name, JSON.stringify(args || {}));
      let isError = /^\s*error\b/i.test(output);
      try {
        const parsed = JSON.parse(output);
        if (parsed?.success === false || parsed?.error) isError = true;
      } catch {}
      return result(id, {
        content: [{ type: 'text', text: output }],
        isError,
      });
    } catch (toolError: unknown) {
      return result(id, {
        content: [{ type: 'text', text: toolError instanceof Error ? toolError.message : String(toolError) }],
        isError: true,
      });
    }
  }

  return error(id, -32601, `Method not found: ${body.method}`);
}
