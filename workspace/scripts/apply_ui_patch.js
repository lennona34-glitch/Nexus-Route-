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

const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NexusRoute | Autonomous AI Multi-Model Gateway & Cost Ledger</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: {
              50: '#f0f9ff',
              500: '#0284c7',
              600: '#0369a1',
              900: '#0c4a6e'
            },
            dark: {
              900: '#0b0f19',
              800: '#111827',
              750: '#151d30',
              700: '#1f2937',
              600: '#374151'
            }
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulseGlow {
      0%, 100% { box-shadow: 0 0 15px rgba(56, 189, 248, 0.2); }
      50% { box-shadow: 0 0 25px rgba(56, 189, 248, 0.4); }
    }
    .glow-panel { animation: pulseGlow 4s infinite ease-in-out; }
    .custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
    .custom-scroll::-webkit-scrollbar-track { background: #0b0f19; }
    .custom-scroll::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 3px; }
    .custom-scroll::-webkit-scrollbar-thumb:hover { background: #374151; }
  </style>
</head>
<body class="bg-dark-900 text-slate-100 min-h-screen flex flex-col font-sans selection:bg-cyan-500 selection:text-black">

  <!-- Top Navigation Bar -->
  <header class="border-b border-slate-800/80 bg-dark-800/90 backdrop-blur sticky top-0 z-40 px-6 py-3.5 flex items-center justify-between shadow-lg">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 text-white font-black text-xl">
        <i class="fa-solid fa-network-wired"></i>
      </div>
      <div>
        <div class="flex items-center gap-2">
          <span class="font-bold text-lg tracking-tight bg-gradient-to-r from-cyan-400 via-sky-300 to-indigo-400 bg-clip-text text-transparent">NexusRoute</span>
          <span class="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800">v2.1 Gateway</span>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Universal Multi-Model Router &amp; Dynamic Key Failover
        </div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="flex items-center gap-2 bg-dark-900/80 p-1 rounded-xl border border-slate-800">
      <button id="tabChatBtn" onclick="switchView('chat')" class="px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 bg-cyan-600 text-white shadow">
        <i class="fa-solid fa-comments"></i> Playground
      </button>
      <button id="tabLedgerBtn" onclick="switchView('ledger')" class="px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 text-slate-400 hover:text-white hover:bg-dark-750">
        <i class="fa-solid fa-receipt"></i> Cost Ledger
      </button>
      <button id="tabVaultBtn" onclick="switchView('vault')" class="px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 text-slate-400 hover:text-white hover:bg-dark-750">
        <i class="fa-solid fa-key"></i> Key Vault &amp; Quarantine
      </button>
    </div>

    <!-- Quick Stats in Header -->
    <div class="flex items-center gap-4 text-xs font-mono">
      <div class="bg-dark-750 px-3 py-1.5 rounded-lg border border-slate-700/60 flex items-center gap-2">
        <span class="text-slate-400">Total Spend:</span>
        <span id="quickSpendUsd" class="font-bold text-emerald-400">$0.0000</span>
        <span class="text-slate-500">|</span>
        <span id="quickSpendGbp" class="font-bold text-indigo-400">£0.0000</span>
      </div>
      <div class="bg-dark-750 px-3 py-1.5 rounded-lg border border-slate-700/60 flex items-center gap-2">
        <span class="text-slate-400">Tokens:</span>
        <span id="quickTokens" class="font-bold text-sky-400">0</span>
      </div>
    </div>
  </header>

  <!-- Main Workspace -->
  <main class="flex-1 flex overflow-hidden">

    <!-- VIEW 1: Chat & Router Playground -->
    <section id="viewChat" class="flex-1 flex flex-col md:flex-row h-[calc(100vh-65px)]">
      
      <!-- Controls Sidebar -->
      <aside class="w-full md:w-80 border-r border-slate-800 bg-dark-800/60 p-5 flex flex-col gap-5 overflow-y-auto custom-scroll">
        <div>
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
            <i class="fa-solid fa-sliders text-cyan-400"></i> Dispatch Policy
          </h2>

          <label class="block text-xs font-medium text-slate-300 mb-1.5">Model Target</label>
          <select id="modelSelect" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500">
            <option value="auto">⚡ Auto-Smart Router (Nexus Adaptive)</option>
            <optgroup label="Direct DeepSeek">
              <option value="deepseek-reasoner">DeepSeek R1 Reasoner (Direct)</option>
              <option value="deepseek-chat">DeepSeek V3 (Direct)</option>
            </optgroup>
            <optgroup label="OpenRouter Unified Hub">
              <option value="deepseek/deepseek-r1">DeepSeek R1 (OpenRouter)</option>
              <option value="deepseek/deepseek-chat">DeepSeek V3 (OpenRouter)</option>
              <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet (OpenRouter)</option>
              <option value="openai/gpt-4o-mini">GPT-4o Mini (OpenRouter)</option>
            </optgroup>
            <optgroup label="Direct OpenAI">
              <option value="gpt-4o">GPT-4o Omni</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="o3-mini">OpenAI o3-mini Reasoner</option>
            </optgroup>
            <optgroup label="Direct Anthropic & Gemini">
              <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
              <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
            </optgroup>
            <optgroup label="High Speed & Local">
              <option value="llama-3.3-70b-versatile">Groq Llama 3.3 70B (Fast)</option>
              <option value="llama3:latest">Local Ollama Llama 3</option>
            </optgroup>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1.5">Optimization Tier</label>
          <select id="strategySelect" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500">
            <option value="auto">Auto Selection (Complexity Based)</option>
            <option value="latency_optimized">Ultra-Low Latency (Fastest)</option>
            <option value="cost_optimized">Minimum Cost (Budget)</option>
            <option value="quality_optimized">Maximum Reasoning &amp; Quality</option>
          </select>
        </div>

        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-xs font-medium text-slate-300">Temperature</label>
            <span id="tempVal" class="text-xs font-mono text-cyan-400">0.7</span>
          </div>
          <input id="tempSlider" type="range" min="0" max="1" step="0.05" value="0.7" class="w-full accent-cyan-500" oninput="document.getElementById('tempVal').innerText = this.value">
        </div>

        <div class="pt-4 border-t border-slate-700/60">
          <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" id="streamToggle" checked class="rounded bg-dark-900 border-slate-700 text-cyan-500 focus:ring-cyan-500 accent-cyan-500">
            <span>Enable Streaming Response (SSE)</span>
          </label>
        </div>

        <!-- Telemetry Panel -->
        <div class="mt-auto bg-dark-900/90 rounded-xl p-4 border border-slate-800 text-xs">
          <h3 class="font-bold text-slate-300 mb-2 flex items-center justify-between">
            <span>⚡ Last Turn Metrics</span>
            <span id="lastProviderBadge" class="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">-</span>
          </h3>
          <div class="space-y-1.5 font-mono text-slate-400">
            <div class="flex justify-between"><span>Prompt / Comp:</span> <span id="metricTokens" class="text-slate-200">- / -</span></div>
            <div class="flex justify-between"><span>Reasoning Tokens:</span> <span id="metricReasoning" class="text-amber-400">0</span></div>
            <div class="flex justify-between"><span>Turn Cost (USD):</span> <span id="metricCostUsd" class="text-emerald-400">$0.0000</span></div>
            <div class="flex justify-between"><span>Turn Cost (GBP):</span> <span id="metricCostGbp" class="text-indigo-400">£0.0000</span></div>
            <div class="flex justify-between"><span>Latency:</span> <span id="metricLatency" class="text-sky-400">0 ms</span></div>
          </div>
        </div>
      </aside>

      <!-- Chat Canvas & Prompt Stream -->
      <section class="flex-1 flex flex-col bg-dark-900 overflow-hidden relative">
        <div id="messagesContainer" class="flex-1 overflow-y-auto p-6 space-y-4 custom-scroll">
          <div class="bg-dark-800/60 border border-slate-800 rounded-xl p-4 text-slate-300 text-sm max-w-2xl mx-auto flex gap-3 shadow-md">
            <div class="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-800 flex items-center justify-center text-cyan-400 shrink-0">
              <i class="fa-solid fa-robot"></i>
            </div>
            <div>
              <div class="font-semibold text-slate-200 mb-1">NexusRoute Gateway Ready</div>
              <p class="text-slate-400 text-xs leading-relaxed">
                Connect your OpenRouter, DeepSeek V3/R1, OpenAI, Gemini, and Anthropic keys in the <b class="text-cyan-400">Key Vault</b> tab. Queries are dynamically routed with auto-failover, 429 quarantine handling, and real-time ledger accounting.
              </p>
            </div>
          </div>
        </div>

        <!-- Input Box -->
        <div class="p-4 bg-dark-800/80 border-t border-slate-800">
          <form id="chatForm" onsubmit="handleSend(event)" class="max-w-4xl mx-auto relative flex items-end gap-3">
            <div class="relative flex-1 bg-dark-900 border border-slate-700 rounded-xl shadow-inner focus-within:border-cyan-500 transition">
              <textarea id="promptInput" rows="2" placeholder="Send a prompt to NexusRoute (e.g. 'Solve this mathematical problem step-by-step' or 'Write a Python FastAPI service')..." class="w-full bg-transparent px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none resize-none custom-scroll" onkeydown="if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); handleSend(event); }"></textarea>
            </div>
            <button type="submit" id="sendBtn" class="bg-cyan-600 hover:bg-cyan-500 text-white font-medium px-5 py-3 rounded-xl shadow-lg shadow-cyan-600/30 flex items-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed">
              <span>Send</span>
              <i class="fa-solid fa-paper-plane text-xs"></i>
            </button>
          </form>
        </div>
      </section>
    </section>

    <!-- VIEW 2: Cost Ledger & Analytics -->
    <section id="viewLedger" class="hidden flex-1 flex flex-col p-6 overflow-y-auto custom-scroll bg-dark-900">
      <div class="max-w-6xl mx-auto w-full space-y-6">
        
        <!-- Header -->
        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h1 class="text-2xl font-bold text-slate-100 flex items-center gap-3">
              <i class="fa-solid fa-receipt text-cyan-400"></i> Real-Time Cost &amp; Token Ledger
            </h1>
            <p class="text-slate-400 text-sm mt-1">Live breakdown of token usage, reasoning overhead, and actual monetary spend calculated against model capability rates.</p>
          </div>
          <button onclick="clearLedger()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800/80 transition flex items-center gap-2">
            <i class="fa-solid fa-trash-can"></i> Reset Ledger
          </button>
        </div>

        <!-- Summary Cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-dark-800/80 border border-slate-800 p-5 rounded-xl shadow">
            <div class="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">Total Requests</div>
            <div id="ledgerTotalReqs" class="text-2xl font-bold text-slate-100 font-mono">0</div>
          </div>
          <div class="bg-dark-800/80 border border-slate-800 p-5 rounded-xl shadow">
            <div class="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">Total Tokens Consumed</div>
            <div id="ledgerTotalTokens" class="text-2xl font-bold text-sky-400 font-mono">0</div>
          </div>
          <div class="bg-dark-800/80 border border-slate-800 p-5 rounded-xl shadow">
            <div class="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">Total Cost (USD)</div>
            <div id="ledgerTotalCostUsd" class="text-2xl font-bold text-emerald-400 font-mono">$0.000000</div>
          </div>
          <div class="bg-dark-800/80 border border-slate-800 p-5 rounded-xl shadow">
            <div class="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">Total Cost (GBP @ 0.79)</div>
            <div id="ledgerTotalCostGbp" class="text-2xl font-bold text-indigo-400 font-mono">£0.000000</div>
          </div>
        </div>

        <!-- Per-Model Cost Breakdown Table -->
        <div class="bg-dark-800/80 border border-slate-800 rounded-xl overflow-hidden shadow">
          <div class="px-5 py-4 border-b border-slate-800 flex justify-between items-center">
            <h3 class="font-bold text-slate-200 text-sm uppercase tracking-wider flex items-center gap-2">
              <i class="fa-solid fa-chart-pie text-cyan-400"></i> Spend &amp; Volume by Model
            </h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs font-mono">
              <thead class="bg-dark-750 text-slate-400 uppercase text-[11px] border-b border-slate-800">
                <tr>
                  <th class="px-5 py-3">Model</th>
                  <th class="px-5 py-3">Calls</th>
                  <th class="px-5 py-3">Tokens</th>
                  <th class="px-5 py-3">Spend (USD)</th>
                  <th class="px-5 py-3">Spend (GBP)</th>
                </tr>
              </thead>
              <tbody id="ledgerModelTableBody" class="divide-y divide-slate-800 text-slate-300">
                <tr><td colspan="5" class="px-5 py-6 text-center text-slate-500 font-sans">No transactions recorded yet in this session.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Recent Transactions Feed -->
        <div class="bg-dark-800/80 border border-slate-800 rounded-xl overflow-hidden shadow">
          <div class="px-5 py-4 border-b border-slate-800">
            <h3 class="font-bold text-slate-200 text-sm uppercase tracking-wider flex items-center gap-2">
              <i class="fa-solid fa-list-check text-cyan-400"></i> Recent Gateway Transactions
            </h3>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs font-mono">
              <thead class="bg-dark-750 text-slate-400 uppercase text-[11px] border-b border-slate-800">
                <tr>
                  <th class="px-5 py-3">Time</th>
                  <th class="px-5 py-3">Model / Provider</th>
                  <th class="px-5 py-3">Prompt</th>
                  <th class="px-5 py-3">Comp</th>
                  <th class="px-5 py-3">Reasoning</th>
                  <th class="px-5 py-3">Cost ($)</th>
                  <th class="px-5 py-3">Cost (£)</th>
                </tr>
              </thead>
              <tbody id="ledgerTxTableBody" class="divide-y divide-slate-800 text-slate-300">
                <tr><td colspan="7" class="px-5 py-6 text-center text-slate-500 font-sans">No recent transactions.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </section>

    <!-- VIEW 3: Multi-Key Vault & Quarantine Management -->
    <section id="viewVault" class="hidden flex-1 flex flex-col p-6 overflow-y-auto custom-scroll bg-dark-900">
      <div class="max-w-6xl mx-auto w-full space-y-6">

        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h1 class="text-2xl font-bold text-slate-100 flex items-center gap-3">
              <i class="fa-solid fa-vault text-cyan-400"></i> Multi-Key Vault &amp; Auto-Quarantine
            </h1>
            <p class="text-slate-400 text-sm mt-1">Manage multiple API keys per provider with round-robin rotation, 429 backoff cooldowns, and automatic failover.</p>
          </div>
          <button onclick="fetchVaultStatus()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950/60 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 transition flex items-center gap-2">
            <i class="fa-solid fa-arrows-rotate"></i> Refresh Status
          </button>
        </div>

        <!-- Add Keys Form -->
        <div class="bg-dark-800/80 border border-slate-800 p-5 rounded-xl shadow">
          <h3 class="font-bold text-slate-200 text-sm mb-3 flex items-center gap-2">
            <i class="fa-solid fa-plus-circle text-emerald-400"></i> Add Provider API Keys
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Provider</label>
              <select id="addKeyProvider" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500">
                <option value="openrouter">OpenRouter (Unified)</option>
                <option value="deepseek">DeepSeek (Direct)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
                <option value="groq">Groq</option>
                <option value="mistral">Mistral AI</option>
                <option value="together">Together AI</option>
              </select>
            </div>
            <div class="md:col-span-2">
              <label class="block text-xs font-medium text-slate-300 mb-1">API Key(s) <span class="text-slate-500">(comma or newline separated for multiple keys)</span></label>
              <div class="flex gap-2">
                <input type="password" id="addKeyInput" placeholder="sk-or-v1-..., sk-ant-..., etc." class="flex-1 bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500 font-mono">
                <button onclick="submitKey()" class="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition shrink-0 flex items-center gap-2">
                  <i class="fa-solid fa-key"></i> Save Key(s)
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Key Pools Display Grid -->
        <div id="vaultPoolsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Dynamically populated -->
        </div>

      </div>
    </section>

  </main>

  <script>
    let currentView = 'chat';
    let chatHistory = [];

    function switchView(view) {
      currentView = view;
      ['chat', 'ledger', 'vault'].forEach(v => {
        const el = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
        const btn = document.getElementById('tab' + v.charAt(0).toUpperCase() + v.slice(1) + 'Btn');
        if (v === view) {
          el.classList.remove('hidden');
          btn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 bg-cyan-600 text-white shadow';
        } else {
          el.classList.add('hidden');
          btn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 text-slate-400 hover:text-white hover:bg-dark-750';
        }
      });

      if (view === 'ledger') fetchLedger();
      if (view === 'vault') fetchVaultStatus();
    }

    async function handleSend(e) {
      if (e) e.preventDefault();
      const input = document.getElementById('promptInput');
      const text = input.value.trim();
      if (!text) return;

      const model = document.getElementById('modelSelect').value;
      const strategy = document.getElementById('strategySelect').value;
      const temperature = parseFloat(document.getElementById('tempSlider').value);
      const stream = document.getElementById('streamToggle').checked;

      // Append User message
      chatHistory.push({ role: 'user', content: text });
      appendMessageUI('user', text);
      input.value = '';

      const sendBtn = document.getElementById('sendBtn');
      sendBtn.disabled = true;

      // Placeholder for Assistant message
      const msgId = 'msg_' + Date.now();
      appendAssistantPlaceholder(msgId);

      const startTime = Date.now();

      try {
        if (stream) {
          const resp = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              strategy,
              temperature,
              stream: true,
              messages: chatHistory
            })
          });

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          let fullReasoning = '';
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') break;

              try {
                const chunk = JSON.parse(dataStr);
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                  fullContent += delta.content;
                }
                if (delta?.reasoning_content) {
                  fullReasoning += delta.reasoning_content;
                }

                updateAssistantUI(msgId, fullContent, fullReasoning, chunk.model);

                if (chunk.usage) {
                  updateMetricsUI({
                    model: chunk.model,
                    usage: chunk.usage,
                    latency_ms: Date.now() - startTime
                  });
                }
              } catch (err) {}
            }
          }

          chatHistory.push({ role: 'assistant', content: fullContent });
        } else {
          const resp = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              strategy,
              temperature,
              stream: false,
              messages: chatHistory
            })
          });

          const data = await resp.json();
          if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

          const message = data.choices?.[0]?.message;
          const content = message?.content || '';
          const reasoning = message?.reasoning_content || '';

          chatHistory.push({ role: 'assistant', content });
          updateAssistantUI(msgId, content, reasoning, data.model);
          updateMetricsUI(data);
        }
      } catch (err) {
        document.getElementById(msgId).innerHTML = `
          <div class="p-3 rounded-lg bg-red-950/60 border border-red-800 text-red-300 text-xs">
            <b>Router Error:</b> ${escapeHtml(err.message)}
          </div>
        `;
      } finally {
        sendBtn.disabled = false;
        fetchLedgerQuickStats();
      }
    }

    function appendMessageUI(role, content) {
      const container = document.getElementById('messagesContainer');
      const div = document.createElement('div');
      div.className = 'flex gap-3 max-w-3xl ml-auto justify-end';
      div.innerHTML = `
        <div class="bg-cyan-900/60 border border-cyan-700/60 rounded-2xl rounded-tr-sm p-4 text-slate-100 text-sm shadow">
          ${escapeHtml(content).replace(/\\n/g, '<br>')}
        </div>
      `;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function appendAssistantPlaceholder(id) {
      const container = document.getElementById('messagesContainer');
      const div = document.createElement('div');
      div.id = id;
      div.className = 'flex gap-3 max-w-3xl mr-auto';
      div.innerHTML = `
        <div class="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center text-indigo-400 shrink-0">
          <i class="fa-solid fa-microchip"></i>
        </div>
        <div class="bg-dark-800/80 border border-slate-800 rounded-2xl rounded-tl-sm p-4 text-slate-200 text-sm shadow-md flex-1">
          <div class="animate-pulse flex space-x-2">
            <div class="h-2 w-2 bg-cyan-400 rounded-full"></div>
            <div class="h-2 w-2 bg-indigo-400 rounded-full"></div>
            <div class="h-2 w-2 bg-sky-400 rounded-full"></div>
          </div>
        </div>
      `;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function updateAssistantUI(id, content, reasoning, model) {
      const el = document.getElementById(id);
      if (!el) return;

      let reasoningHtml = '';
      if (reasoning) {
        reasoningHtml = `
          <details class="mb-3 border border-amber-900/50 bg-amber-950/20 rounded-lg p-2.5 text-xs text-amber-300">
            <summary class="font-mono font-semibold cursor-pointer select-none flex items-center gap-1.5">
              <i class="fa-solid fa-brain"></i> Reasoning &amp; Thought Process
            </summary>
            <div class="mt-2 text-slate-300 whitespace-pre-wrap font-mono text-[11px] leading-relaxed border-t border-amber-900/40 pt-2">
              ${escapeHtml(reasoning)}
            </div>
          </details>
        `;
      }

      el.innerHTML = `
        <div class="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center text-indigo-400 shrink-0 mt-1">
          <i class="fa-solid fa-microchip"></i>
        </div>
        <div class="bg-dark-800/80 border border-slate-800 rounded-2xl rounded-tl-sm p-4 text-slate-200 text-sm shadow-md flex-1">
          <div class="text-[10px] uppercase font-mono text-cyan-400 mb-2 flex items-center gap-1.5">
            <i class="fa-solid fa-bolt"></i> ${escapeHtml(model || 'nexus-engine')}
          </div>
          ${reasoningHtml}
          <div class="whitespace-pre-wrap leading-relaxed">${escapeHtml(content)}</div>
        </div>
      `;
      const container = document.getElementById('messagesContainer');
      container.scrollTop = container.scrollHeight;
    }

    function updateMetricsUI(data) {
      if (!data) return;
      document.getElementById('lastProviderBadge').innerText = data.provider || 'routed';
      const u = data.usage || {};
      document.getElementById('metricTokens').innerText = `${u.prompt_tokens || 0} / ${u.completion_tokens || 0}`;
      document.getElementById('metricReasoning').innerText = u.reasoning_tokens || 0;
      document.getElementById('metricCostUsd').innerText = '$' + (u.cost_usd || 0).toFixed(6);
      document.getElementById('metricCostGbp').innerText = '£' + (u.cost_gbp || 0).toFixed(6);
      document.getElementById('metricLatency').innerText = (data.latency_ms || 0) + ' ms';
    }

    async function fetchLedgerQuickStats() {
      try {
        const res = await fetch('/api/ledger');
        const data = await res.json();
        if (data.summary) {
          document.getElementById('quickSpendUsd').innerText = '$' + data.summary.totalCostUsd.toFixed(4);
          document.getElementById('quickSpendGbp').innerText = '£' + data.summary.totalCostGbp.toFixed(4);
          document.getElementById('quickTokens').innerText = data.summary.totalTokens.toLocaleString();
        }
      } catch (e) {}
    }

    async function fetchLedger() {
      try {
        const res = await fetch('/api/ledger');
        const data = await res.json();
        
        document.getElementById('ledgerTotalReqs').innerText = data.summary.totalRequests;
        document.getElementById('ledgerTotalTokens').innerText = data.summary.totalTokens.toLocaleString();
        document.getElementById('ledgerTotalCostUsd').innerText = '$' + data.summary.totalCostUsd.toFixed(6);
        document.getElementById('ledgerTotalCostGbp').innerText = '£' + data.summary.totalCostGbp.toFixed(6);

        // Populate Model Table
        const modelTbody = document.getElementById('ledgerModelTableBody');
        const modelKeys = Object.keys(data.byModel);
        if (modelKeys.length === 0) {
          modelTbody.innerHTML = '<tr><td colspan="5" class="px-5 py-6 text-center text-slate-500 font-sans">No transactions recorded yet.</td></tr>';
        } else {
          modelTbody.innerHTML = modelKeys.map(m => {
            const item = data.byModel[m];
            return `
              <tr class="hover:bg-dark-750/50">
                <td class="px-5 py-3 font-bold text-cyan-400">${escapeHtml(m)}</td>
                <td class="px-5 py-3">${item.count}</td>
                <td class="px-5 py-3">${item.tokens.toLocaleString()}</td>
                <td class="px-5 py-3 text-emerald-400">$${item.usd.toFixed(6)}</td>
                <td class="px-5 py-3 text-indigo-400">£${item.gbp.toFixed(6)}</td>
              </tr>
            `;
          }).join('');
        }

        // Populate Recent Transactions Table
        const txTbody = document.getElementById('ledgerTxTableBody');
        if (data.recentTransactions.length === 0) {
          txTbody.innerHTML = '<tr><td colspan="7" class="px-5 py-6 text-center text-slate-500 font-sans">No recent transactions.</td></tr>';
        } else {
          txTbody.innerHTML = data.recentTransactions.map(tx => {
            const timeStr = new Date(tx.timestamp).toLocaleTimeString();
            return `
              <tr class="hover:bg-dark-750/50">
                <td class="px-5 py-3 text-slate-400">${timeStr}</td>
                <td class="px-5 py-3"><span class="text-cyan-400 font-bold">${escapeHtml(tx.model)}</span> <span class="text-[10px] text-slate-500">(${escapeHtml(tx.provider)})</span></td>
                <td class="px-5 py-3">${tx.prompt_tokens}</td>
                <td class="px-5 py-3">${tx.completion_tokens}</td>
                <td class="px-5 py-3 text-amber-400">${tx.reasoning_tokens || 0}</td>
                <td class="px-5 py-3 text-emerald-400">$${tx.cost_usd.toFixed(6)}</td>
                <td class="px-5 py-3 text-indigo-400">£${tx.cost_gbp.toFixed(6)}</td>
              </tr>
            `;
          }).join('');
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function clearLedger() {
      if (!confirm('Are you sure you want to reset the session ledger spend analytics?')) return;
      await fetch('/api/ledger', { method: 'DELETE' });
      fetchLedger();
      fetchLedgerQuickStats();
    }

    async function fetchVaultStatus() {
      try {
        const res = await fetch('/api/vault/keys');
        const pools = await res.json();
        const grid = document.getElementById('vaultPoolsGrid');
        grid.innerHTML = '';

        const providers = ['openrouter', 'deepseek', 'openai', 'anthropic', 'gemini', 'groq', 'together', 'mistral'];
        
        for (const p of providers) {
          const info = pools[p] || { total: 0, healthy: 0, quarantined: 0, keys: [] };
          const card = document.createElement('div');
          card.className = 'bg-dark-800/80 border border-slate-800 rounded-xl p-5 shadow flex flex-col gap-3';

          const keysListHtml = info.keys.length === 0 
            ? '<div class="text-xs text-slate-500 italic">No keys configured for this provider.</div>'
            : info.keys.map(k => `
              <div class="flex items-center justify-between bg-dark-900/80 p-2 rounded-lg border ${k.isQuarantined ? 'border-amber-700/60 bg-amber-950/20' : (!k.isActive ? 'border-red-700/60 bg-red-950/20' : 'border-slate-800')} text-xs font-mono">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full ${k.isQuarantined ? 'bg-amber-400 animate-pulse' : (!k.isActive ? 'bg-red-500' : 'bg-emerald-400')}"></span>
                  <span class="text-slate-300">${escapeHtml(k.id)}</span>
                </div>
                <div class="flex items-center gap-2">
                  ${k.isQuarantined ? `<span class="text-[10px] text-amber-400 uppercase font-semibold">Quarantined (429)</span>` : ''}
                  ${!k.isActive ? `<span class="text-[10px] text-red-400 uppercase font-semibold">Disabled (401/403)</span>` : ''}
                  <button onclick="removeKey('${p}', '${k.id}')" class="text-slate-500 hover:text-red-400 text-xs px-1">
                    <i class="fa-solid fa-xmark"></i>
                  </button>
                </div>
              </div>
            `).join('');

          card.innerHTML = `
            <div class="flex items-center justify-between pb-2 border-b border-slate-800">
              <div class="font-bold text-sm text-slate-200 uppercase tracking-wide flex items-center gap-2">
                <i class="fa-solid fa-server text-cyan-400"></i> ${escapeHtml(p)}
              </div>
              <div class="flex items-center gap-2 text-xs font-mono">
                <span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">${info.healthy} Active</span>
                ${info.quarantined > 0 ? `<span class="px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-800">${info.quarantined} Quarantined</span>` : ''}
              </div>
            </div>
            <div class="space-y-2">
              ${keysListHtml}
            </div>
          `;
          grid.appendChild(card);
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function submitKey() {
      const provider = document.getElementById('addKeyProvider').value;
      const key = document.getElementById('addKeyInput').value.trim();
      if (!key) return;

      await fetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key, label: 'dashboard' })
      });

      document.getElementById('addKeyInput').value = '';
      fetchVaultStatus();
    }

    async function removeKey(provider, keyId) {
      await fetch('/api/vault/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: keyId })
      });
      fetchVaultStatus();
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Init on load
    fetchLedgerQuickStats();
  </script>
</body>
</html>
`;

writeFile('src/web/public/index.html', html);
console.log('Frontend UI updated with Ledger, Vault, and DeepSeek/OpenRouter controls!');
