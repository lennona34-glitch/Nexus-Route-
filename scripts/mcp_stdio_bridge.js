#!/usr/bin/env node
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleMcpMessage } from '../dist/mcp/handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        let val = match[2] ? match[2].trim() : '';
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[match[1]] = val;
      }
    }
  } catch {}
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err?.message || String(err)}` },
      }) + '\n'
    );
    return;
  }

  // 1. First attempt: forward to running NexusRoute HTTP server if active
  let handled = false;
  try {
    const res = await fetch('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: trimmed,
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const json = await res.json();
      process.stdout.write(JSON.stringify(json) + '\n');
      handled = true;
    }
  } catch {
    // NexusRoute HTTP server not active or timed out; fall back to in-process handler
  }

  // 2. Seamless in-process execution fallback
  if (!handled) {
    try {
      const response = await handleMcpMessage(request);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32603, message: `Internal error: ${err?.message || String(err)}` },
        }) + '\n'
      );
    }
  }
});
