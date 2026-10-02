import { FastifyReply } from 'fastify';
import { UniversalRequest, UniversalMessage, UniversalResponse, ToolDefinition } from '../ir/types.js';
import { RoutingEngine } from '../router/engine.js';

export function translateAnthropicToUniversalRequest(body: any): UniversalRequest {
  const model = typeof body.model === 'string' ? body.model : 'claude-3-5-sonnet-20241022';
  const messages: UniversalMessage[] = [];

  // 1. System instruction
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const sysText = body.system
        .map((part: any) => (typeof part === 'string' ? part : part?.text || ''))
        .filter(Boolean)
        .join('\n\n');
      if (sysText) messages.push({ role: 'system', content: sysText });
    }
  }

  // 2. Chat messages & tools
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;
      if (role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          let textContent = '';
          const parts: any[] = [];

          for (const block of msg.content) {
            if (block.type === 'text') {
              textContent += (textContent ? '\n' : '') + (block.text || '');
              parts.push({ type: 'text', text: block.text || '' });
            } else if (block.type === 'image' && block.source?.data) {
              const mime = block.source.media_type || 'image/png';
              const dataUrl = 'data:' + mime + ';base64,' + block.source.data;
              parts.push({ type: 'image_url', image_url: { url: dataUrl } });
            } else if (block.type === 'tool_result') {
              const resultText = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
                  : JSON.stringify(block.content || ''));
              messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id || 'call_0',
                name: block.tool_use_id,
                content: resultText || 'Success',
              });
            }
          }

          if (parts.length > 0 && !parts.every(p => p.type === 'tool_result')) {
            messages.push({
              role: 'user',
              content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
            });
          }
        }
      } else if (role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          let text = '';
          const toolCalls: any[] = [];

          for (const block of msg.content) {
            if (block.type === 'text') {
              text += (text ? '\n' : '') + (block.text || '');
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id || ('call_' + Date.now() + '_' + toolCalls.length),
                type: 'function',
                function: {
                  name: block.name,
                  arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                },
              });
            }
          }

          messages.push({
            role: 'assistant',
            content: text,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        }
      }
    }
  }

  // 3. Tools definitions
  let tools: ToolDefinition[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  return {
    model,
    messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }],
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 8192,
    stream: body.stream === true,
    tools,
    client_agent_mode: true,
  };
}

export function translateUniversalToAnthropicResponse(resp: UniversalResponse, requestedModel: string): any {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const contentBlocks: any[] = [];

  if (msg?.content) {
    contentBlocks.push({
      type: 'text',
      text: msg.content,
    });
  }

  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let parsedInput = {};
      try {
        parsedInput = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {});
      } catch {
        parsedInput = { raw: tc.function.arguments };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + Date.now()),
        name: tc.function.name,
        input: parsedInput,
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  const isToolCall = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  const outputModel = requestedModel.startsWith('claude-') ? requestedModel : 'claude-3-5-sonnet-20241022';

  return {
    id: resp.id || ('msg_' + Date.now()),
    type: 'message',
    role: 'assistant',
    model: outputModel,
    content: contentBlocks,
    stop_reason: isToolCall ? 'tool_use' : (choice?.finish_reason === 'stop' ? 'end_turn' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 10,
      output_tokens: resp.usage?.completion_tokens || 10,
    },
  };
}

export async function handleAnthropicMessagesStream(
  universalReq: UniversalRequest,
  router: RoutingEngine,
  reply: FastifyReply,
  requestedModel: string
): Promise<void> {
  reply.hijack();
  reply.raw.on('error', (err: any) => {
    // Suppress client disconnect / socket reset errors
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      console.warn('[Anthropic Stream Client Warning]:', err.message);
    }
  });

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof reply.raw.flushHeaders === 'function') {
    reply.raw.flushHeaders();
  }

  const outputModel = requestedModel.startsWith('claude-') ? requestedModel : 'claude-3-5-sonnet-20241022';
  const msgId = 'msg_' + Date.now();
  let blockIndex = 0;
  let textBlockStarted = false;
  let accumulatedText = '';
  const toolBlocks: Array<{ id: string; name: string; argsJson: string }> = [];
  let promptTokens = 15;
  let completionTokens = 0;

  const sendEvent = (eventType: string, data: any) => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      try {
        reply.raw.write('event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n');
      } catch (err: any) {
        // Socket closed by client
      }
    }
  };

  sendEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: outputModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: promptTokens,
        output_tokens: 1,
      },
    },
  });

  try {
    const stream = router.executeStream(universalReq);

    for await (const chunk of stream) {
      if (reply.raw.destroyed || reply.raw.writableEnded) break;
      if (chunk.usage) {
        if (chunk.usage.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens) completionTokens = chunk.usage.completion_tokens;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textBlockStarted) {
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'text',
              text: '',
            },
          });
          textBlockStarted = true;
        }

        accumulatedText += delta.content;
        completionTokens++;
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!toolBlocks[idx]) {
            toolBlocks[idx] = {
              id: tc.id || ('toolu_' + Date.now() + '_' + idx),
              name: tc.function?.name || 'tool',
              argsJson: '',
            };
          }
          if (tc.function?.name) {
            toolBlocks[idx].name = tc.function.name;
          }
          if (tc.function?.arguments) {
            toolBlocks[idx].argsJson += tc.function.arguments;
          }
        }
      }
    }

    if (textBlockStarted) {
      sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
    }

    for (const tb of toolBlocks.filter(Boolean)) {
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: tb.id,
          name: tb.name,
          input: {},
        },
      });

      sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: tb.argsJson || '{}',
        },
      });

      sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
    }

    const hasTools = toolBlocks.length > 0;

    sendEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: hasTools ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: Math.max(completionTokens, 1),
      },
    });

    sendEvent('message_stop', {
      type: 'message_stop',
    });

  } catch (err: any) {
    console.error('[Anthropic Stream Error]:', err.message);
    const rawMsg = err.message || 'Error executing completion stream';
    const isNotice = rawMsg.includes('Cash Guard') || rawMsg.includes('Freeze Source') || rawMsg.includes('Fixed Provider Mode');
    sendEvent('error', {
      type: 'error',
      error: {
        type: isNotice ? 'invalid_request_error' : 'api_error',
        message: isNotice ? rawMsg : `[NexusRoute Cash Guard] ${rawMsg}`,
      },
    });
  } finally {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch {}
    }
  }
}
