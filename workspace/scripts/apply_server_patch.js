import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function writeFile(relPath, content) {
  const target = path.join(rootDir, relPath);
  fs.writeFileSync(target, content, 'utf8');
  console.log(`Successfully wrote ${relPath}`);
}

const serverTs = `import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoutingEngine } from './router/engine';
import { GlobalVault } from './security/vault';
import { CapabilityRegistry, MODEL_CAPABILITIES } from './router/capabilities';
import { RequestIR } from './ir/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'web/public')));

const engine = new RoutingEngine();

// In-Memory Transaction Ledger for session cost analytics
interface LedgerEntry {
  id: string;
  timestamp: number;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  total_tokens: number;
  cost_usd: number;
  cost_gbp: number;
  latency_ms: number;
}

const transactionLedger: LedgerEntry[] = [];

// API: List available models & capabilities
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: CapabilityRegistry.getAvailableModels()
  });
});

// API: Health status & Key Vault overview
app.get('/v1/status', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    vault: GlobalVault.getPoolStatus(),
    totalRequests: transactionLedger.length
  });
});

// API: Vault Key Management
app.get('/api/vault/keys', (req, res) => {
  res.json(GlobalVault.getPoolStatus());
});

app.post('/api/vault/keys', (req, res) => {
  const { provider, keys, key, label } = req.body;
  if (!provider) {
    return res.status(400).json({ error: 'Provider is required' });
  }

  if (Array.isArray(keys)) {
    GlobalVault.setKeysForProvider(provider, keys);
    return res.json({ success: true, vault: GlobalVault.getPoolStatus() });
  }

  if (key) {
    // Check if key contains commas or newlines
    const keyList = key.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean);
    for (const k of keyList) {
      GlobalVault.addKey(provider, k, label || 'dashboard');
    }
    return res.json({ success: true, vault: GlobalVault.getPoolStatus() });
  }

  res.status(400).json({ error: 'No keys provided' });
});

app.delete('/api/vault/keys', (req, res) => {
  const { provider, key } = req.body;
  if (!provider || !key) {
    return res.status(400).json({ error: 'Provider and key are required' });
  }
  GlobalVault.removeKey(provider, key);
  res.json({ success: true, vault: GlobalVault.getPoolStatus() });
});

// API: Cost Ledger & Spend Analytics
app.get('/api/ledger', (req, res) => {
  const totalTokens = transactionLedger.reduce((acc, l) => acc + l.total_tokens, 0);
  const totalCostUsd = transactionLedger.reduce((acc, l) => acc + l.cost_usd, 0);
  const totalCostGbp = transactionLedger.reduce((acc, l) => acc + l.cost_gbp, 0);

  // Group spend by model
  const byModel: Record<string, { count: number; tokens: number; usd: number; gbp: number }> = {};
  for (const entry of transactionLedger) {
    if (!byModel[entry.model]) {
      byModel[entry.model] = { count: 0, tokens: 0, usd: 0, gbp: 0 };
    }
    byModel[entry.model].count++;
    byModel[entry.model].tokens += entry.total_tokens;
    byModel[entry.model].usd += entry.cost_usd;
    byModel[entry.model].gbp += entry.cost_gbp;
  }

  res.json({
    summary: {
      totalRequests: transactionLedger.length,
      totalTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalCostGbp: Number(totalCostGbp.toFixed(6)),
      gbpExchangeRate: GlobalVault.getGbpRate()
    },
    byModel,
    recentTransactions: transactionLedger.slice(-50).reverse()
  });
});

app.delete('/api/ledger', (req, res) => {
  transactionLedger.length = 0;
  res.json({ success: true, message: 'Ledger cleared' });
});

// API: OpenAI Compatible Chat Completions Endpoint
app.post('/v1/chat/completions', async (req, res) => {
  const {
    model = 'auto',
    messages = [],
    temperature,
    max_tokens,
    stream = false,
    tools,
    tool_choice,
    strategy,
    provider: forceProvider
  } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages array' });
  }

  const requestIR: RequestIR = {
    model,
    messages,
    temperature,
    max_tokens,
    stream,
    tools,
    tool_choice
  };

  const routeOpts = {
    strategy: strategy || 'auto',
    forceProvider,
    forceModel: forceProvider ? model : undefined
  };

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      let accumulatedUsage: any = null;
      let targetModel = model;
      let targetProvider = forceProvider || 'auto';

      for await (const chunk of engine.streamRoute(requestIR, routeOpts)) {
        targetModel = chunk.model;
        targetProvider = chunk.provider;
        if (chunk.usage) {
          accumulatedUsage = chunk.usage;
        }

        const openAiChunk = {
          id: chunk.id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: chunk.model,
          choices: [
            {
              index: 0,
              delta: {
                role: chunk.delta.role,
                content: chunk.delta.content || null,
                reasoning_content: chunk.delta.reasoning_content || null,
                tool_calls: chunk.delta.tool_calls
              },
              finish_reason: chunk.finish_reason || null
            }
          ],
          usage: chunk.usage || undefined
        };

        res.write(\`data: \${JSON.stringify(openAiChunk)}\\n\\n\`);
      }

      // Record to ledger if usage was reported
      if (accumulatedUsage) {
        transactionLedger.push({
          id: \`tx_\${Date.now()}_\${Math.random().toString(36).substring(2, 7)}\`,
          timestamp: Date.now(),
          model: targetModel,
          provider: targetProvider,
          prompt_tokens: accumulatedUsage.prompt_tokens || 0,
          completion_tokens: accumulatedUsage.completion_tokens || 0,
          reasoning_tokens: accumulatedUsage.reasoning_tokens || 0,
          total_tokens: accumulatedUsage.total_tokens || 0,
          cost_usd: accumulatedUsage.cost_usd || 0,
          cost_gbp: accumulatedUsage.cost_gbp || 0,
          latency_ms: 0
        });
      }

      res.write('data: [DONE]\\n\\n');
      res.end();
    } catch (err: any) {
      console.error('Streaming error:', err);
      res.write(\`data: \${JSON.stringify({ error: err.message })}\\n\\n\`);
      res.end();
    }
  } else {
    try {
      const response = await engine.route(requestIR, routeOpts);

      // Record transaction in Ledger
      transactionLedger.push({
        id: \`tx_\${Date.now()}_\${Math.random().toString(36).substring(2, 7)}\`,
        timestamp: Date.now(),
        model: response.model,
        provider: response.provider,
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        reasoning_tokens: response.usage.reasoning_tokens,
        total_tokens: response.usage.total_tokens,
        cost_usd: response.usage.cost_usd || 0,
        cost_gbp: response.usage.cost_gbp || 0,
        latency_ms: response.latency_ms
      });

      res.json({
        id: response.id,
        object: 'chat.completion',
        created: response.created,
        model: response.model,
        provider: response.provider,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: response.content,
              reasoning_content: response.reasoning_content,
              tool_calls: response.tool_calls
            },
            finish_reason: response.finish_reason
          }
        ],
        usage: response.usage,
        latency_ms: response.latency_ms
      });
    } catch (err: any) {
      console.error('Route error:', err);
      res.status(500).json({
        error: {
          message: err.message || 'Internal Router Error',
          type: 'router_error'
        }
      });
    }
  }
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'web/public/index.html'));
});

app.listen(PORT, () => {
  console.log(\`⚡ NexusRoute Master Gateway active on http://localhost:\${PORT}\`);
  console.log(\`🔐 Multi-Key Vault & Quarantine: Online\`);
  console.log(\`📊 Cost Ledger & DeepSeek/OpenRouter Engine: Active\`);
});
`;

writeFile('src/server.ts', serverTs);
