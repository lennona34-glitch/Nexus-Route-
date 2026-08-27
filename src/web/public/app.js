// State & Elements
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const modelSelect = document.getElementById('modelSelect');
const openRouterRoutingSelect = document.getElementById('openRouterRoutingSelect');
const streamToggle = document.getElementById('streamToggle');
const toolsToggle = document.getElementById('toolsToggle');

// Inspector Elements
const kpiModel = document.getElementById('kpiModel');
const kpiProvider = document.getElementById('kpiProvider');
const kpiLatency = document.getElementById('kpiLatency');
const kpiCost = document.getElementById('kpiCost');
const kpiCostDetails = document.getElementById('kpiCostDetails');
const kpiTokens = document.getElementById('kpiTokens');
const kpiTokenBreakdown = document.getElementById('kpiTokenBreakdown');
const kpiSessionTokens = document.getElementById('kpiSessionTokens');
const kpiSessionCost = document.getElementById('kpiSessionCost');
const artEngineSelect = document.getElementById('artEngineSelect');
const attemptsBadge = document.getElementById('attemptsBadge');
const waterfallList = document.getElementById('waterfallList');
const clearTraceBtn = document.getElementById('clearTraceBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const intentCategory = document.getElementById('intentCategory');
const complexityPill = document.getElementById('complexityPill');
const classifierDesc = document.getElementById('classifierDesc');

// Session Cumulative Telemetry
let sessionTotalTokens = 0;
let sessionTotalCost = 0.0;
let lastReportedCostUsd = 0.0;
let lastReportedSavedUsd = 0.0;
let lastRequestCacheSavingsUsd = 0.0;
let lastRequestCachedTokens = 0;
let lastRequestCacheDiscountUsd = 0.0;
let lastRequestCostSource = 'estimated';

// Admin Session Token Authentication
let adminSessionToken = '';
async function loadAdminSession() {
  try {
    const res = await fetch('/v1/auth/session');
    if (res.ok) {
      const data = await res.json();
      adminSessionToken = data.token || '';
    }
  } catch {}
}
loadAdminSession();

function adminHeaders(custom = {}) {
  const h = { 'Content-Type': 'application/json', ...custom };
  if (adminSessionToken) {
    h['Authorization'] = `Bearer ${adminSessionToken}`;
    h['x-admin-key'] = adminSessionToken;
  }
  return h;
}

// Global Provider Derivation Helper
function deriveProviderFromModel(model) {
  if (!model) return 'cloud';
  const m = model.toLowerCase();
  const discoveredProvider = m.match(/^([a-z]+)::/);
  if (discoveredProvider) return discoveredProvider[1];
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('mistral')) return 'mistral';
  if (m.startsWith('grok') || m.startsWith('xai')) return 'xai';
  if (m.startsWith('openrouter')) return 'openrouter';
  if (m.startsWith('together') || m.includes('together')) return 'together';
  if (m.startsWith('huggingface') || m.startsWith('hf') || m.includes('flux')) return 'huggingface';
  if (m.startsWith('qwen') || m.includes('groq')) return 'groq';
  if (m.startsWith('github')) return 'github';
  if (m.startsWith('local')) return 'local';
  if (m.startsWith('mock')) return 'mock';
  return 'cloud';
}

// Collapsible Route Inspector Sidebar & Fullscreen Chat
const mainGrid = document.querySelector('.grid-layout');
const toggleFullscreenChatBtn = document.getElementById('toggleFullscreenChatBtn');
const collapseInspectorBtn = document.getElementById('collapseInspectorBtn');
const openInspectorTabBtn = document.getElementById('openInspectorTabBtn');

function setInspectorCollapsed(collapsed) {
  if (!mainGrid) return;
  if (collapsed) {
    mainGrid.classList.add('inspector-collapsed');
    if (openInspectorTabBtn) openInspectorTabBtn.classList.remove('hidden');
    if (toggleFullscreenChatBtn) toggleFullscreenChatBtn.textContent = '◧ Split View';
    localStorage.setItem('nexus_inspector_collapsed', 'true');
  } else {
    mainGrid.classList.remove('inspector-collapsed');
    if (openInspectorTabBtn) openInspectorTabBtn.classList.add('hidden');
    if (toggleFullscreenChatBtn) toggleFullscreenChatBtn.textContent = '⤢ Fullscreen';
    localStorage.setItem('nexus_inspector_collapsed', 'false');
  }
}

if (toggleFullscreenChatBtn) {
  toggleFullscreenChatBtn.addEventListener('click', () => {
    const isCurrentlyCollapsed = mainGrid?.classList.contains('inspector-collapsed');
    setInspectorCollapsed(!isCurrentlyCollapsed);
  });
}

if (collapseInspectorBtn) {
  collapseInspectorBtn.addEventListener('click', () => {
    setInspectorCollapsed(true);
  });
}

if (openInspectorTabBtn) {
  openInspectorTabBtn.addEventListener('click', () => {
    setInspectorCollapsed(false);
  });
}

// Restore user's sidebar preference
if (localStorage.getItem('nexus_inspector_collapsed') === 'true') {
  setInspectorCollapsed(true);
}

// Claude Code Terminal View Toggle Handler
const toggleClaudeCodeBtn = document.getElementById('toggleClaudeCodeBtn');
function setClaudeCodeMode(active) {
  if (active) {
    document.body.classList.add('claude-code-mode');
    if (toggleClaudeCodeBtn) {
      toggleClaudeCodeBtn.innerHTML = '📟 Claude Code: ON';
      toggleClaudeCodeBtn.classList.add('active');
    }
    localStorage.setItem('nexus_claude_code_view', 'true');
  } else {
    document.body.classList.remove('claude-code-mode');
    if (toggleClaudeCodeBtn) {
      toggleClaudeCodeBtn.innerHTML = '📟 Claude Code View';
      toggleClaudeCodeBtn.classList.remove('active');
    }
    localStorage.setItem('nexus_claude_code_view', 'false');
  }
}

if (toggleClaudeCodeBtn) {
  toggleClaudeCodeBtn.addEventListener('click', () => {
    const isCc = document.body.classList.contains('claude-code-mode');
    setClaudeCodeMode(!isCc);
  });
}

// Enable Claude Code View by default (or restore user's preference)
if (localStorage.getItem('nexus_claude_code_view') !== 'false') {
  setClaudeCodeMode(true);
}

// Currency Settings (GBP £ by default for British user, toggleable to USD $)
let currentCurrency = localStorage.getItem('nexus_currency') || 'GBP';
const USD_TO_GBP_RATE = 0.785;

function formatCurrency(amountUsd, precision = 6) {
  const usd = typeof amountUsd === 'number' ? amountUsd : parseFloat(amountUsd) || 0;
  if (currentCurrency === 'GBP') {
    const gbp = usd * USD_TO_GBP_RATE;
    return `£${gbp.toFixed(precision)}`;
  }
  return `$${usd.toFixed(precision)}`;
}

function updateRequestCostDetails() {
  if (!kpiCostDetails) return;
  const sourceLabels = {
    provider: 'Exact provider cost',
    estimated: 'Estimated',
    cache: 'Nexus cache',
  };
  const details = [sourceLabels[lastRequestCostSource] || 'Estimated'];
  if (lastRequestCachedTokens > 0) {
    details.push(`♻ ${lastRequestCachedTokens.toLocaleString()} cached tok`);
  }
  if (lastRequestCacheSavingsUsd > 0) {
    details.push(`saved ${formatCurrency(lastRequestCacheSavingsUsd, 6)}`);
  } else if (lastRequestCacheDiscountUsd > 0) {
    details.push(`cache saved ${formatCurrency(lastRequestCacheDiscountUsd, 6)}`);
  } else if (lastRequestCacheDiscountUsd < 0) {
    details.push(`cache write +${formatCurrency(Math.abs(lastRequestCacheDiscountUsd), 6)}`);
  }
  kpiCostDetails.textContent = details.join(' · ');
}

function updateCurrencyUI() {
  const iconEl = document.getElementById('currencyIcon');
  const labelEl = document.getElementById('currencyLabel');
  if (iconEl) iconEl.textContent = currentCurrency === 'GBP' ? '💷' : '💵';
  if (labelEl) labelEl.textContent = currentCurrency === 'GBP' ? 'GBP (£)' : 'USD ($)';

  if (kpiCost) kpiCost.textContent = formatCurrency(lastReportedCostUsd, 6);
  if (kpiSessionCost) kpiSessionCost.textContent = `Total Cost: ${formatCurrency(sessionTotalCost, 5)}`;
  if (cacheSavedUsdVal) cacheSavedUsdVal.textContent = formatCurrency(lastReportedSavedUsd, 6);
  updateRequestCostDetails();
}

const toggleCurrencyBtn = document.getElementById('toggleCurrencyBtn');
if (toggleCurrencyBtn) {
  toggleCurrencyBtn.addEventListener('click', () => {
    currentCurrency = currentCurrency === 'GBP' ? 'USD' : 'GBP';
    localStorage.setItem('nexus_currency', currentCurrency);
    updateCurrencyUI();
  });
}

// Art Engine Select persistence
if (artEngineSelect) {
  const savedArtEngine = localStorage.getItem('nexus_art_engine');
  if (savedArtEngine) artEngineSelect.value = savedArtEngine;
  artEngineSelect.addEventListener('change', () => {
    localStorage.setItem('nexus_art_engine', artEngineSelect.value);
  });
}

// One compact OpenRouter policy control; Balanced preserves the existing behaviour.
if (openRouterRoutingSelect) {
  const savedOpenRouterRouting = localStorage.getItem('nexus_openrouter_routing');
  if (savedOpenRouterRouting && ['balanced', 'cheapest', 'fastest', 'tools'].includes(savedOpenRouterRouting)) {
    openRouterRoutingSelect.value = savedOpenRouterRouting;
  }
  openRouterRoutingSelect.addEventListener('change', () => {
    localStorage.setItem('nexus_openrouter_routing', openRouterRoutingSelect.value);
  });
}

// Cache Elements
const cacheHitRateBadge = document.getElementById('cacheHitRateBadge');
const cacheHitsVal = document.getElementById('cacheHitsVal');
const cacheSavedLatencyVal = document.getElementById('cacheSavedLatencyVal');
const cacheSavedUsdVal = document.getElementById('cacheSavedUsdVal');

// Chaos Elements
const chaosMockGpt4o = document.getElementById('chaosMockGpt4o');
const chaosStatus = document.getElementById('chaosStatus');

// Provider Key Modal Elements
const openKeysModalBtn = document.getElementById('openKeysModalBtn');
const closeKeysModalBtn = document.getElementById('closeKeysModalBtn');
const modalDoneBtn = document.getElementById('modalDoneBtn');
const keysModal = document.getElementById('keysModal');
const modalToast = document.getElementById('modalToast');
const providerBadges = document.getElementById('providerBadges');

// Virtual Keys Modal Elements
const openVirtualKeysBtn = document.getElementById('openVirtualKeysBtn');
const closeVirtualKeysModalBtn = document.getElementById('closeVirtualKeysModalBtn');
const virtualKeysDoneBtn = document.getElementById('virtualKeysDoneBtn');
const virtualKeysModal = document.getElementById('virtualKeysModal');
const generateKeyBtn = document.getElementById('generateKeyBtn');
const newKeyName = document.getElementById('newKeyName');
const newKeyBudget = document.getElementById('newKeyBudget');
const newKeyRpm = document.getElementById('newKeyRpm');
const virtualKeysTableBody = document.getElementById('virtualKeysTableBody');

// Connect Apps Modal Elements
const openConnectModalBtn = document.getElementById('openConnectModalBtn');
const closeConnectModalBtn = document.getElementById('closeConnectModalBtn');
const connectDoneBtn = document.getElementById('connectDoneBtn');
const connectModal = document.getElementById('connectModal');
const snippetTabs = document.querySelectorAll('.snippet-tab');

// Free Capacity, persisted routes, and MCP status
const openCapacityModalBtn = document.getElementById('openCapacityModalBtn');
const closeCapacityModalBtn = document.getElementById('closeCapacityModalBtn');
const capacityDoneBtn = document.getElementById('capacityDoneBtn');
const capacityModal = document.getElementById('capacityModal');
const capacityReadyBadge = document.getElementById('capacityReadyBadge');
const capacityConnectionsBody = document.getElementById('capacityConnectionsBody');
const freeTierCatalog = document.getElementById('freeTierCatalog');
const addProviderConnectionBtn = document.getElementById('addProviderConnectionBtn');
const refreshRouteHistoryBtn = document.getElementById('refreshRouteHistoryBtn');
const routeHistoryList = document.getElementById('routeHistoryList');
const mcpStatusLine = document.getElementById('mcpStatusLine');
// Session State & Chat History
let currentSessionId = localStorage.getItem('nexus_current_session_id') || `session_${Date.now()}`;
let currentSessionTitle = 'New Conversation';
let activeFileTargets = [];
let allSessions = [];

// DOM Elements for Chat History Sidebar
const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
const chatSidebar = document.getElementById('chatSidebar');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');
const sidebarNewChatBtn = document.getElementById('sidebarNewChatBtn');
const searchChatsInput = document.getElementById('searchChatsInput');
const chatSessionsList = document.getElementById('chatSessionsList');
const clearAllHistoryBtn = document.getElementById('clearAllHistoryBtn');
const historyCountBadge = document.getElementById('historyCountBadge');

const conversationHistory = [];
let availableTools = [];

// Fetch initial data
async function init() {
  updateCurrencyUI();
  await Promise.all([
    loadProviderStatus(),
    loadProviderModels(),
    loadDynamicLocalModels(),
    loadGpuStatus(),
    loadCacheStats(),
    loadToolsList(),
    loadSessionsList(),
    loadFreeCapacity(),
    loadRouteHistory(),
    loadMcpInfo(),
  ]);
  setInterval(loadGpuStatus, 4000);
  setInterval(loadDynamicLocalModels, 10000);
  setInterval(loadProviderModels, 15 * 60 * 1000);
  setInterval(loadRouteHistory, 15000);
  setInterval(loadFreeCapacity, 30000);

  // If previous active session exists, load it
  const savedCurrentId = localStorage.getItem('nexus_current_session_id');
  if (savedCurrentId) {
    await loadSession(savedCurrentId);
  }
}

function formatContextLength(tokens) {
  const value = Number(tokens || 0);
  if (!value) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(value / 1024)}k ctx`;
}

// Populate cloud models from each configured provider's own catalogue. The
// internal provider::model route ID keeps identical vendor model names tied to
// the account that actually advertised them.
async function loadProviderModels(force = false) {
  try {
    const res = await fetch(`/v1/provider-models${force ? '?refresh=1' : ''}`, { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const providerGroups = Array.isArray(data.providers) ? data.providers : [];
    const localGroup = document.getElementById('localModelsOptgroup');
    if (!modelSelect || !localGroup) return;

    const currentSelected = modelSelect.value;
    modelSelect.querySelectorAll('optgroup[data-live-provider-catalogue="true"]').forEach(group => group.remove());
    const oldAnchor = document.getElementById('providerModelsAnchor');
    if (oldAnchor) oldAnchor.remove();

    let rendered = 0;
    for (const provider of providerGroups) {
      if (!provider.configured) continue;
      const group = document.createElement('optgroup');
      group.dataset.liveProviderCatalogue = 'true';

      if (provider.status === 'ready' && Array.isArray(provider.models) && provider.models.length > 0) {
        group.label = `${provider.displayName} · ${provider.models.length} available`;
        for (const model of provider.models) {
          const option = document.createElement('option');
          option.value = model.routeId;
          const details = [model.free ? 'free' : '', formatContextLength(model.contextLength), model.supportsTools ? 'tools' : ''].filter(Boolean);
          option.textContent = `${model.free ? '🟢 ' : ''}${model.name || model.id}${details.length ? ` · ${details.join(' · ')}` : ''}`;
          option.title = `${provider.displayName}: ${model.id}`;
          group.appendChild(option);
        }
      } else {
        group.label = `${provider.displayName} · ${provider.status}`;
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = provider.error || 'No chat models were returned by this provider.';
        group.appendChild(option);
      }

      modelSelect.insertBefore(group, localGroup);
      rendered++;
    }

    if (rendered === 0) {
      const group = document.createElement('optgroup');
      group.id = 'providerModelsAnchor';
      group.dataset.liveProviderCatalogue = 'true';
      group.label = 'Cloud Models';
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = 'Add a provider key to load its available models.';
      group.appendChild(option);
      modelSelect.insertBefore(group, localGroup);
    }

    if (currentSelected && Array.from(modelSelect.options).some(option => option.value === currentSelected)) {
      modelSelect.value = currentSelected;
    }
  } catch (err) {
    console.warn('Failed to load provider model catalogues:', err);
  }
}

// Dynamically populate local Ollama models (offline GGUF & custom models)
async function loadDynamicLocalModels() {
  try {
    const res = await fetch('/v1/local/models');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && Array.isArray(data.models) && data.models.length > 0) {
      const optgroup = document.getElementById('localModelsOptgroup');
      if (optgroup) {
        const currentSelected = modelSelect ? modelSelect.value : '';
        optgroup.innerHTML = '<option value="free">🟢 Free Tier (Auto-Route to Local GPU)</option>';
        for (const m of data.models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          let icon = '🖥️';
          const lower = m.cleanName.toLowerCase();
          if (lower.includes('dolphin')) icon = '🐬';
          else if (lower.includes('wizard')) icon = '🧙';
          else if (lower.includes('claude')) icon = '🧠';
          else if (lower.includes('gemma')) icon = '💎';
          else if (lower.includes('qwen')) icon = '⚡';
          else if (lower.includes('llama')) icon = '🦙';
          else if (lower.includes('deepseek')) icon = '🐋';
          else if (lower.includes('moondream')) icon = '🌙';
          else if (lower.includes('animat') || lower.includes('safetensor')) icon = '🎨';

          opt.textContent = `${icon} ${m.cleanName} (${m.sizeGb})`;
          optgroup.appendChild(opt);
        }
        if (currentSelected && modelSelect) {
          modelSelect.value = currentSelected;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load dynamic local models:', err);
  }
}

// Load tools list
async function loadToolsList() {
  try {
    const res = await fetch('/v1/tools');
    if (res.ok) {
      const data = await res.json();
      availableTools = data.tools || [];
    }
  } catch {
    // ignore
  }
}

// Fetch provider status
async function loadProviderStatus() {
  try {
    const res = await fetch('/v1/keys/status');
    if (!res.ok) return;
    const data = await res.json();
    updateProviderUI(data.providers || {});
  } catch (err) {
    console.error('Failed to load provider status:', err);
  }
}

// Fetch Cache stats & controls
const cacheToggle = document.getElementById('cacheToggle');
const cacheStatusVal = document.getElementById('cacheStatusVal');

async function loadCacheStats() {
  try {
    const res = await fetch('/v1/cache');
    if (!res.ok) return;
    const data = await res.json();
    const s = data.stats;
    const isEnabled = !!data.enabled;

    if (cacheToggle) cacheToggle.checked = isEnabled;
    if (cacheStatusVal) {
      cacheStatusVal.textContent = isEnabled ? 'Active (Caching)' : 'Disabled (Fresh)';
      cacheStatusVal.style.color = isEnabled ? 'var(--accent-purple)' : 'var(--text-muted)';
    }
    if (cacheHitRateBadge) {
      cacheHitRateBadge.textContent = isEnabled ? `${(s ? s.hitRatio * 100 : 0).toFixed(0)}% Hit Rate` : 'Disabled';
    }

    if (s) {
      if (cacheHitsVal) cacheHitsVal.textContent = s.hits;
      if (cacheSavedLatencyVal) cacheSavedLatencyVal.textContent = `${s.totalSavedLatencyMs}ms`;
      lastReportedSavedUsd = s.totalSavedUsd || 0;
      if (cacheSavedUsdVal) cacheSavedUsdVal.textContent = formatCurrency(lastReportedSavedUsd, 6);
    }
  } catch (err) {
    console.error('Failed to load cache stats:', err);
  }
}

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    try {
      await fetch('/v1/cache/clear', { method: 'POST', headers: adminHeaders() });
      clearCacheBtn.textContent = '✓ Cleared!';
      await loadCacheStats();
      setTimeout(() => { if (clearCacheBtn) clearCacheBtn.textContent = '🧹 Clear Cache'; }, 2000);
    } catch (err) {
      console.error('Failed to clear cache:', err);
    }
  });
}

if (cacheToggle) {
  cacheToggle.addEventListener('change', async () => {
    try {
      await fetch('/v1/cache/toggle', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: cacheToggle.checked }),
      });
      await loadCacheStats();
    } catch (err) {
      console.error('Failed to toggle cache:', err);
    }
  });
}

function updateProviderUI(providers) {
  providerBadges.innerHTML = '';
  const list = ['openai', 'anthropic', 'gemini', 'groq', 'xai', 'deepseek', 'mistral', 'openrouter', 'github', 'together', 'huggingface'];
  let anyConfigured = false;

  for (const p of list) {
    const info = providers[p];
    const isConfigured = !!info?.configured;
    const isEnabled = info?.enabled !== false;
    if (isConfigured) anyConfigured = true;

    // Navbar Badge
    const badge = document.createElement('div');
    badge.className = 'metric-pill';
    const readyConnections = Number(info?.usableConnections || 0);
    const totalConnections = Number(info?.connections || 0);
    const hasPoolInfo = totalConnections > 0;
    badge.title = isConfigured
      ? `${p.toUpperCase()}: ${isEnabled ? 'Active' : 'Paused'}${hasPoolInfo ? ` · ${readyConnections}/${totalConnections} connections ready` : ''}. Click to configure.`
      : `Click to configure ${p.toUpperCase()} API key`;

    let dotColor = 'background: var(--text-muted); box-shadow: none;';
    if (isConfigured) {
      dotColor = isEnabled ? '' : 'background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5);';
    }

    const labelSuffix = isConfigured && !isEnabled
      ? ' (Paused)'
      : hasPoolInfo
        ? ` ${readyConnections}/${totalConnections}`
        : '';

    badge.innerHTML = `
      <span class="status-dot ${isConfigured && isEnabled ? 'active' : ''}" style="${dotColor}"></span>
      <span class="pill-label">${p.charAt(0).toUpperCase() + p.slice(1)}${labelSuffix}</span>
    `;
    badge.addEventListener('click', () => {
      if (keysModal) keysModal.classList.remove('hidden');
      loadProviderStatus();
    });
    providerBadges.appendChild(badge);

    // Modal Badge with 1-Click Toggle
    const modalBadge = document.getElementById(`badge-${p}`);
    if (modalBadge) {
      if (!isConfigured) {
        modalBadge.className = 'provider-pill unconfigured';
        modalBadge.textContent = '⚠️ Needs Key';
        modalBadge.style.cursor = 'default';
        modalBadge.title = 'Enter your API key below and click Save';
        modalBadge.onclick = null;
      } else if (isEnabled) {
        modalBadge.className = 'provider-pill configured';
        modalBadge.textContent = '✓ Enabled (Click to Pause)';
        modalBadge.style.cursor = 'pointer';
        modalBadge.title = 'Click to disable this provider when credits run out';
        modalBadge.onclick = async () => {
          await fetch('/v1/providers/toggle', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ provider: p, enabled: false }),
          });
          await Promise.all([loadProviderStatus(), loadProviderModels(true)]);
        };
      } else {
        modalBadge.className = 'provider-pill';
        modalBadge.style.background = 'rgba(245, 158, 11, 0.15)';
        modalBadge.style.color = '#f59e0b';
        modalBadge.style.border = '1px solid rgba(245, 158, 11, 0.4)';
        modalBadge.textContent = '⏸️ Paused (Click to Enable)';
        modalBadge.style.cursor = 'pointer';
        modalBadge.title = 'Click to re-enable this provider';
        modalBadge.onclick = async () => {
          await fetch('/v1/providers/toggle', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ provider: p, enabled: true }),
          });
          await Promise.all([loadProviderStatus(), loadProviderModels(true)]);
        };
      }
    }

    // Input placeholder if configured
    const input = document.getElementById(`key-${p}`);
    if (input && info?.maskedKey) {
      input.placeholder = `Configured: ${info.maskedKey}`;
    }
  }

  const alertBadge = document.getElementById('keysAlertBadge');
  if (alertBadge) {
    if (anyConfigured) {
      alertBadge.classList.add('hidden');
    } else {
      alertBadge.classList.remove('hidden');
    }
  }
}

// Local GPU Hardware Status & 1-Click VRAM Purge
const gpuMetricPill = document.getElementById('gpuMetricPill');
const gpuLedDot = document.getElementById('gpuLedDot');
const gpuMetricLabel = document.getElementById('gpuMetricLabel');
const quickUnloadGpuBtn = document.getElementById('quickUnloadGpuBtn');

async function loadGpuStatus() {
  try {
    const res = await fetch('/v1/gpu/status');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.gpu) return;

    const gpu = data.gpu;
    const loaded = data.loadedModels || [];
    const usedGb = (gpu.usedMb / 1024).toFixed(1);
    const totalGb = (gpu.totalMb / 1024).toFixed(1);
    const pct = gpu.totalMb > 0 ? Math.round((gpu.usedMb / gpu.totalMb) * 100) : 0;

    if (gpuMetricLabel) {
      if (gpu.available) {
        const modelNames = loaded.map(m => m.name.split(':')[0]).join(', ');
        const modelTxt = modelNames ? ` · [${modelNames}]` : ' · (Idle)';
        gpuMetricLabel.textContent = `RTX 4060: ${usedGb}/${totalGb}GB (${pct}%)${modelTxt}`;
      } else {
        gpuMetricLabel.textContent = 'GPU: Offline / CPU';
      }
    }

    if (gpuLedDot) {
      gpuLedDot.className = gpu.available ? 'status-dot active' : 'status-dot';
      gpuLedDot.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : '#10b981');
      gpuLedDot.style.boxShadow = pct > 85 ? '0 0 8px #ef4444' : (pct > 60 ? '0 0 8px #f59e0b' : '0 0 8px #10b981');
    }

    if (gpuMetricPill) {
      gpuMetricPill.title = `GPU: ${gpu.name}\nVRAM: ${usedGb} GB / ${totalGb} GB (${pct}%)\nActive Models in VRAM: ${loaded.length > 0 ? loaded.map(m => m.name).join(', ') : 'None'}\nClick ⚡ Unload to free VRAM for PromptForge RTX art.`;
    }
  } catch (err) {}
}

if (quickUnloadGpuBtn) {
  quickUnloadGpuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      quickUnloadGpuBtn.textContent = '⏳ ...';
      const res = await fetch('/v1/gpu/unload', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data.success !== true) {
        throw new Error(data.message || `Unload failed (${res.status})`);
      }
      quickUnloadGpuBtn.textContent = data.unloadedModels?.length ? '✓ Freed!' : '✓ Clear';
      quickUnloadGpuBtn.title = data.message || 'Ollama GPU memory released.';
      await loadGpuStatus();
      setTimeout(() => { if (quickUnloadGpuBtn) quickUnloadGpuBtn.textContent = '⚡ Unload'; }, 2000);
    } catch (err) {
      quickUnloadGpuBtn.textContent = '⚠ Failed';
      quickUnloadGpuBtn.title = err?.message || 'Could not unload Ollama models.';
      setTimeout(() => { if (quickUnloadGpuBtn) quickUnloadGpuBtn.textContent = '⚡ Unload'; }, 2500);
    }
  });
}

// Provider Key Modal open/close
const quickKeysLink = document.getElementById('quickKeysLink');
if (quickKeysLink) {
  quickKeysLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (keysModal) keysModal.classList.remove('hidden');
    loadProviderStatus();
  });
}

if (openKeysModalBtn) {
  openKeysModalBtn.addEventListener('click', () => {
    if (keysModal) keysModal.classList.remove('hidden');
    loadProviderStatus();
  });
}
if (closeKeysModalBtn && keysModal) closeKeysModalBtn.addEventListener('click', () => keysModal.classList.add('hidden'));
if (modalDoneBtn && keysModal) modalDoneBtn.addEventListener('click', () => keysModal.classList.add('hidden'));

// Save single provider key
document.querySelectorAll('.save-key-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const provider = btn.getAttribute('data-provider');
    const input = document.getElementById(`key-${provider}`);
    const keyVal = input ? input.value.trim() : '';

    try {
      const res = await fetch('/v1/keys', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ provider, apiKey: keyVal }),
      });
      if (res.ok) {
        if (modalToast) modalToast.textContent = `✓ ${provider} API key saved & loaded!`;
        if (input) input.value = '';
        await Promise.all([loadProviderStatus(), loadProviderModels(true)]);
        setTimeout(() => { if (modalToast) modalToast.textContent = ''; }, 3000);
      }
    } catch {
      if (modalToast) modalToast.textContent = `Error saving key.`;
    }
  });
});

// Virtual Client Keys Management
async function loadVirtualKeys() {
  try {
    const res = await fetch('/v1/virtual-keys', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderVirtualKeysTable(data.keys || []);
  } catch (err) {
    console.error('Failed to load virtual keys:', err);
  }
}

function renderVirtualKeysTable(keys) {
  if (!virtualKeysTableBody) return;
  virtualKeysTableBody.innerHTML = '';
  if (keys.length === 0) {
    virtualKeysTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 16px;">No virtual keys created yet. Click "+ Create Key" above.</td></tr>';
    return;
  }

  for (const k of keys) {
    const tr = document.createElement('tr');
    const keyDisplay = k.keyMasked || `${k.id.slice(0, 10)}...${k.id.slice(-4)}`;
    tr.innerHTML = `
      <td><strong>${k.name}</strong></td>
      <td>
        <code style="color: var(--accent-cyan); font-size: 11px;">${keyDisplay}</code>
      </td>
      <td>${formatCurrency(k.spentTodayUsd, 4)} / ${formatCurrency(k.dailyBudgetUsd, 2)}</td>
      <td>${formatCurrency(k.totalSpentUsd, 4)}</td>
      <td>${k.rateLimitRpm} RPM</td>
      <td>
        <button class="delete-btn" data-key-id="${k.id}">Revoke</button>
      </td>
    `;
    virtualKeysTableBody.appendChild(tr);
  }

  virtualKeysTableBody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-key-id');
      if (confirm(`Revoke virtual key?`)) {
        await fetch(`/v1/virtual-keys/${id}`, { method: 'DELETE', headers: adminHeaders() });
        await loadVirtualKeys();
      }
    });
  });
}

if (openVirtualKeysBtn && virtualKeysModal) {
  openVirtualKeysBtn.addEventListener('click', () => {
    virtualKeysModal.classList.remove('hidden');
    loadVirtualKeys();
  });
}
if (closeVirtualKeysModalBtn && virtualKeysModal) closeVirtualKeysModalBtn.addEventListener('click', () => virtualKeysModal.classList.add('hidden'));
if (virtualKeysDoneBtn && virtualKeysModal) virtualKeysDoneBtn.addEventListener('click', () => virtualKeysModal.classList.add('hidden'));

if (generateKeyBtn) {
  generateKeyBtn.addEventListener('click', async () => {
    const name = newKeyName ? newKeyName.value.trim() || 'Custom App' : 'Custom App';
    const budget = parseFloat(newKeyBudget ? newKeyBudget.value : '10') || 10.0;
    const rpm = parseInt(newKeyRpm ? newKeyRpm.value : '60', 10) || 60;

    try {
      const res = await fetch('/v1/virtual-keys', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name, dailyBudgetUsd: budget, rateLimitRpm: rpm }),
      });
      if (res.ok) {
        const data = await res.json();
        if (newKeyName) newKeyName.value = '';
        await loadVirtualKeys();
        if (data.key?.rawKey) {
          prompt('🎉 Virtual Key Created Successfully!\n\nCopy and store your secret key now. For security, you will not see it again:', data.key.rawKey);
        }
      }
    } catch (err) {
      alert('Error creating virtual key.');
    }
  });
}

function formatConnectionTime(timestamp) {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatQuota(connection) {
  if (connection.quotaLimit === undefined || connection.quotaLimit === null) return 'Not tracked';
  const decimals = connection.quotaUnit === 'usd' ? 2 : 0;
  const used = Number(connection.quotaUsed || 0).toFixed(decimals);
  const limit = Number(connection.quotaLimit || 0).toFixed(decimals);
  const unit = connection.quotaUnit === 'usd' ? 'USD' : connection.quotaUnit;
  return `${used} / ${limit} ${unit}`;
}

function renderFreeCapacity(data) {
  const connections = Array.isArray(data?.connections) ? data.connections : [];
  const counts = connections.reduce((result, connection) => {
    result.total += 1;
    const status = connection.routingStatus || connection.status;
    if (status === 'ready') result.ready += 1;
    if (status === 'cooldown') result.cooldown += 1;
    if (status === 'exhausted') result.exhausted += 1;
    return result;
  }, { total: 0, ready: 0, cooldown: 0, exhausted: 0 });

  if (capacityReadyBadge) capacityReadyBadge.textContent = String(counts.ready);
  const summaryValues = {
    capacityReadyCount: counts.ready,
    capacityCooldownCount: counts.cooldown,
    capacityExhaustedCount: counts.exhausted,
    capacityTotalCount: counts.total,
  };
  Object.entries(summaryValues).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  });

  if (capacityConnectionsBody) {
    if (connections.length === 0) {
      capacityConnectionsBody.innerHTML = '<tr><td colspan="6" class="capacity-empty">No API connections yet. Add one above or save a primary provider key.</td></tr>';
    } else {
      capacityConnectionsBody.innerHTML = connections.map(connection => {
        const safeId = escapeHtml(connection.id);
        const displayStatus = connection.routingStatus || connection.status;
        const sourceNote = connection.source === 'environment' ? ' · returns from .env after restart' : '';
        const statusDetail = displayStatus === 'cooldown' && connection.cooldownUntil
          ? ` until ${formatConnectionTime(connection.cooldownUntil)}`
          : displayStatus === 'disabled' && connection.providerEnabled === false && connection.enabled
            ? ' · provider paused'
          : '';
        const toggleLabel = connection.enabled ? 'Pause' : 'Resume';
        return `
          <tr>
            <td><strong>${escapeHtml(connection.provider.toUpperCase())}</strong><span class="capacity-cell-note">${escapeHtml(connection.label)}${sourceNote}</span></td>
            <td><code>${escapeHtml(connection.maskedKey)}</code></td>
            <td><span class="connection-status ${displayStatus}">${escapeHtml(displayStatus)}${escapeHtml(statusDetail)}</span>${connection.lastError ? `<span class="capacity-cell-note error-note" title="${escapeHtml(connection.lastError)}">${escapeHtml(connection.lastError)}</span>` : ''}</td>
            <td>${escapeHtml(formatQuota(connection))}<span class="capacity-cell-note">${escapeHtml(connection.resetInterval || 'manual')} reset</span></td>
            <td>${escapeHtml(formatConnectionTime(connection.lastUsedAt))}</td>
            <td class="capacity-actions">
              <button class="action-tag-btn connection-toggle-btn" data-id="${safeId}" data-enabled="${connection.enabled ? 'false' : 'true'}">${toggleLabel}</button>
              <button class="action-tag-btn connection-reset-btn" data-id="${safeId}">Reset</button>
              <button class="action-tag-btn danger connection-delete-btn" data-id="${safeId}">Remove</button>
            </td>
          </tr>`;
      }).join('');
    }
  }

  if (freeTierCatalog) {
    const catalog = Array.isArray(data?.catalog) ? data.catalog : [];
    freeTierCatalog.innerHTML = catalog.map(item => `
      <a class="free-tier-card" href="${escapeHtml(item.signupUrl)}" target="_blank" rel="noopener">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.note)}</span>
        <em>Open provider ↗</em>
      </a>`).join('');
  }
}

async function loadFreeCapacity() {
  try {
    const res = await fetch('/v1/free-capacity', { headers: adminHeaders() });
    if (!res.ok) return;
    renderFreeCapacity(await res.json());
  } catch (err) {
    console.warn('Failed to load provider capacity:', err);
  }
}

async function changeConnectionState(id, body) {
  const res = await fetch(`/v1/provider-connections/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Connection update failed');
  await Promise.all([loadFreeCapacity(), loadProviderStatus(), loadProviderModels(true)]);
}

if (capacityConnectionsBody) {
  capacityConnectionsBody.addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const id = button.dataset.id;
    button.disabled = true;
    try {
      if (button.classList.contains('connection-toggle-btn')) {
        await changeConnectionState(id, { enabled: button.dataset.enabled === 'true' });
      } else if (button.classList.contains('connection-reset-btn')) {
        await changeConnectionState(id, { reset: true });
      } else if (button.classList.contains('connection-delete-btn') && confirm('Remove this provider connection?')) {
        const res = await fetch(`/v1/provider-connections/${encodeURIComponent(id)}`, { method: 'DELETE', headers: adminHeaders() });
        if (!res.ok) throw new Error('Connection removal failed');
        await Promise.all([loadFreeCapacity(), loadProviderStatus(), loadProviderModels(true)]);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

if (addProviderConnectionBtn) {
  addProviderConnectionBtn.addEventListener('click', async () => {
    const provider = document.getElementById('capacityProvider')?.value;
    const label = document.getElementById('capacityLabel')?.value.trim();
    const apiKeyInput = document.getElementById('capacityApiKey');
    const quotaInput = document.getElementById('capacityQuotaLimit');
    const capacityToast = document.getElementById('capacityToast');
    const apiKey = apiKeyInput?.value.trim();
    if (!apiKey) {
      if (capacityToast) capacityToast.textContent = 'Paste an API key or token first.';
      return;
    }
    addProviderConnectionBtn.disabled = true;
    try {
      const res = await fetch('/v1/provider-connections', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          provider,
          label,
          apiKey,
          quotaLimit: quotaInput?.value === '' ? undefined : Number(quotaInput?.value),
          quotaUnit: document.getElementById('capacityQuotaUnit')?.value,
          resetInterval: document.getElementById('capacityResetInterval')?.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not add connection');
      if (apiKeyInput) apiKeyInput.value = '';
      if (quotaInput) quotaInput.value = '';
      if (capacityToast) capacityToast.textContent = '✓ Connection added and ready for routing.';
      await Promise.all([loadFreeCapacity(), loadProviderStatus(), loadProviderModels(true)]);
    } catch (err) {
      if (capacityToast) capacityToast.textContent = `Error: ${err.message}`;
    } finally {
      addProviderConnectionBtn.disabled = false;
    }
  });
}

if (openCapacityModalBtn && capacityModal) openCapacityModalBtn.addEventListener('click', () => {
  capacityModal.classList.remove('hidden');
  loadFreeCapacity();
});
if (closeCapacityModalBtn && capacityModal) closeCapacityModalBtn.addEventListener('click', () => capacityModal.classList.add('hidden'));
if (capacityDoneBtn && capacityModal) capacityDoneBtn.addEventListener('click', () => capacityModal.classList.add('hidden'));

async function loadRouteHistory() {
  try {
    const res = await fetch('/v1/telemetry/routes?limit=20', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const summary = data.summary || {};
    const summaryValues = {
      historySuccessRate: `${Math.round(Number(summary.successRate || 0) * 100)}%`,
      historyP50: `${Number(summary.p50LatencyMs || 0)}ms`,
      historyP95: `${Number(summary.p95LatencyMs || 0)}ms`,
      historyRouteCount: Number(summary.totalRequests || 0),
    };
    Object.entries(summaryValues).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value);
    });
    if (!routeHistoryList) return;
    const routes = Array.isArray(data.routes) ? data.routes : [];
    routeHistoryList.innerHTML = routes.length === 0
      ? '<div class="waterfall-empty">No persisted route decisions yet.</div>'
      : routes.map(route => {
        const attemptCount = Array.isArray(route.attempts) ? route.attempts.length : 0;
        const connection = route.connectionLabel ? ` · ${escapeHtml(route.connectionLabel)}` : '';
        const compression = route.compression?.saved_chars ? ` · saved ${Number(route.compression.saved_chars).toLocaleString()} chars` : '';
        return `<div class="route-history-item ${route.success ? 'success' : 'error'}" title="${escapeHtml((route.decisionReasons || []).join(' · '))}">
          <span class="activity-led ${route.success ? 'connected' : 'error'}"></span>
          <div><strong>${escapeHtml(String(route.provider || '').toUpperCase())}</strong><span>${escapeHtml(route.model || '')}${connection}</span></div>
          <div class="route-history-meta"><strong>${Number(route.latencyMs || 0)}ms</strong><span>${attemptCount} attempt${attemptCount === 1 ? '' : 's'}${compression}</span></div>
        </div>`;
      }).join('');
  } catch (err) {
    console.warn('Failed to load route history:', err);
  }
}

if (refreshRouteHistoryBtn) refreshRouteHistoryBtn.addEventListener('click', loadRouteHistory);

async function loadMcpInfo() {
  if (!mcpStatusLine) return;
  try {
    const res = await fetch('/mcp/info', { headers: adminHeaders() });
    if (!res.ok) throw new Error('unavailable');
    const data = await res.json();
    const protocol = data.protocolVersion || data.protocolVersions?.[0] || 'unknown';
    mcpStatusLine.textContent = `✓ MCP ready · ${Number(data.toolCount || 0)} tools · protocol ${protocol}`;
    mcpStatusLine.classList.add('ready');
  } catch {
    mcpStatusLine.textContent = 'MCP endpoint is not responding.';
    mcpStatusLine.classList.remove('ready');
  }
}

// Connect Apps Modal
if (openConnectModalBtn && connectModal) openConnectModalBtn.addEventListener('click', () => {
  connectModal.classList.remove('hidden');
  loadMcpInfo();
});
if (closeConnectModalBtn && connectModal) closeConnectModalBtn.addEventListener('click', () => connectModal.classList.add('hidden'));
if (connectDoneBtn && connectModal) connectDoneBtn.addEventListener('click', () => connectModal.classList.add('hidden'));

// Workspace Files Modal
const openWorkspaceModalBtn = document.getElementById('openWorkspaceModalBtn');
const closeWorkspaceModalBtn = document.getElementById('closeWorkspaceModalBtn');
const workspaceDoneBtn = document.getElementById('workspaceDoneBtn');
const workspaceModal = document.getElementById('workspaceModal');
const workspaceFilesTableBody = document.getElementById('workspaceFilesTableBody');
const workspacePathLabel = document.getElementById('workspacePathLabel');
const filePreviewContainer = document.getElementById('filePreviewContainer');
const previewFileName = document.getElementById('previewFileName');
const previewFileCode = document.getElementById('previewFileCode');
const openWorkspaceFolderBtn = document.getElementById('openWorkspaceFolderBtn');

async function loadWorkspaceFiles() {
  try {
    const res = await fetch('/v1/workspace/files');
    if (!res.ok) return;
    const data = await res.json();
    if (workspacePathLabel && data.workspacePath) {
      workspacePathLabel.textContent = data.workspacePath;
    }
    renderWorkspaceFilesTable(data.files || []);
  } catch (err) {
    console.error('Failed to load workspace files:', err);
  }
}

function renderWorkspaceFilesTable(files) {
  workspaceFilesTableBody.innerHTML = '';
  if (files.length === 0) {
    workspaceFilesTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-muted); padding: 16px;">No files created yet. Ask the AI with Tools enabled to write a file!</td></tr>';
    return;
  }

  // Group files by category
  const categories = [
    { key: 'code', title: '💻 Projects & Code Files', icon: '💻', color: 'var(--accent-cyan)' },
    { key: 'android', title: '📱 Android App Projects', icon: '📱', color: 'var(--accent-green)' },
    { key: 'windows', title: '🎛️ Windows & Audio Plugins', icon: '🎛️', color: '#c084fc' },
    { key: 'binary', title: '⚡ Executables & Binaries', icon: '⚡', color: '#fbbf24' },
    { key: 'art', title: '🎨 Artwork Gallery (workspace/art/)', icon: '🎨', color: '#f43f5e' },
    { key: 'data', title: '📊 Data & Config Files', icon: '📊', color: '#94a3b8' },
  ];

  for (const cat of categories) {
    const catFiles = files.filter(f => f.category === cat.key && !f.isDirectory);
    if (catFiles.length === 0) continue;

    // Header row for category
    const headerTr = document.createElement('tr');
    headerTr.style.background = 'rgba(255, 255, 255, 0.03)';
    headerTr.innerHTML = `
      <td colspan="4" style="padding: 8px 12px; font-weight: 700; color: ${cat.color}; font-size: 12px; border-top: 1px solid var(--border-color);">
        ${cat.title} <span style="color: var(--text-muted); font-size: 11px; font-weight: 400;">(${catFiles.length} ${catFiles.length === 1 ? 'file' : 'files'})</span>
      </td>
    `;
    workspaceFilesTableBody.appendChild(headerTr);

    for (const f of catFiles) {
      const tr = document.createElement('tr');
      const kb = (f.size / 1024).toFixed(1);
      const dateStr = new Date(f.modifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      let icon = '📄';
      let typeBadge = '';
      if (f.name.endsWith('.vst3')) {
        icon = '🎛️';
        typeBadge = ' <span class="model-badge" style="background: rgba(168,85,247,0.2); color: #c084fc;">VST3 Plugin</span>';
      } else if (f.name.endsWith('.exe')) {
        icon = '⚡';
        typeBadge = ' <span class="model-badge" style="background: rgba(16,185,129,0.2); color: var(--accent-green);">Executable</span>';
      } else if (f.name.startsWith('art/')) {
        icon = '🎨';
        typeBadge = ' <span class="model-badge" style="background: rgba(56,189,248,0.2); color: var(--accent-cyan);">Artwork</span>';
      }

      const isBinary = f.name.endsWith('.vst3') || f.name.endsWith('.exe') || f.name.endsWith('.lib') || f.name.endsWith('.exp') || f.name.startsWith('art/');

      tr.innerHTML = `
        <td style="padding-left: 20px;"><strong>${icon} ${f.name}</strong>${typeBadge}</td>
        <td>${kb} KB</td>
        <td>${dateStr}</td>
        <td style="display: flex; gap: 6px;">
          ${!isBinary ? `<button class="action-tag-btn view-file-btn" data-file="${f.name}">View Code</button>` : ''}
          <button class="action-tag-btn reveal-file-btn" data-file="${f.name}" title="Reveal in Windows Explorer">📂 Reveal</button>
        </td>
      `;
      workspaceFilesTableBody.appendChild(tr);
    }
  }

  workspaceFilesTableBody.querySelectorAll('.view-file-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filename = btn.getAttribute('data-file');
      try {
        const res = await fetch(`/v1/workspace/files/${encodeURIComponent(filename)}`);
        if (res.ok) {
          const data = await res.json();
          previewFileName.textContent = `Preview: ${filename}`;
          previewFileCode.textContent = data.content;
          filePreviewContainer.style.display = 'block';
        }
      } catch (err) {
        alert('Error reading file: ' + err.message);
      }
    });
  });

  workspaceFilesTableBody.querySelectorAll('.reveal-file-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filename = btn.getAttribute('data-file');
      try {
        await fetch('/v1/workspace/open', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ filename }),
        });
      } catch (err) {
        console.error('Failed to open file in Explorer:', err);
      }
    });
  });
}

if (openWorkspaceFolderBtn) {
  openWorkspaceFolderBtn.addEventListener('click', async () => {
    try {
      await fetch('/v1/workspace/open', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
    } catch (err) {
      console.error('Failed to open workspace folder:', err);
    }
  });
}

if (openWorkspaceModalBtn) {
  openWorkspaceModalBtn.addEventListener('click', () => {
    workspaceModal.classList.remove('hidden');
    loadWorkspaceFiles();
  });
}
if (closeWorkspaceModalBtn) closeWorkspaceModalBtn.addEventListener('click', () => workspaceModal.classList.add('hidden'));
const closePreviewBtn = document.getElementById('closePreviewBtn');
if (closePreviewBtn && filePreviewContainer) closePreviewBtn.addEventListener('click', () => { filePreviewContainer.style.display = 'none'; });

snippetTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    snippetTabs.forEach(t => t.classList.remove('active'));
    connectModal?.querySelectorAll('.snippet-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.getAttribute('data-tab');
    document.getElementById(target)?.classList.add('active');
  });
});


// Chat History & Session Management Functions
async function loadSessionsList() {
  try {
    const res = await fetch('/v1/chats');
    if (!res.ok) return;
    const data = await res.json();
    allSessions = data.chats || [];
    renderSessionsList(allSessions);
    if (historyCountBadge) historyCountBadge.textContent = allSessions.length;
  } catch (err) {
    console.warn('Failed to load chat sessions:', err);
  }
}

function renderSessionsList(sessions) {
  if (!chatSessionsList) return;
  chatSessionsList.innerHTML = '';

  const filter = searchChatsInput ? searchChatsInput.value.toLowerCase().trim() : '';
  const filtered = filter ? sessions.filter(s => s.title.toLowerCase().includes(filter)) : sessions;

  if (filtered.length === 0) {
    chatSessionsList.innerHTML = `<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 24px 8px;">${filter ? 'No matching conversations.' : 'No saved conversations yet.'}</div>`;
    return;
  }

  for (const s of filtered) {
    const card = document.createElement('div');
    const isActive = s.id === currentSessionId;
    card.className = `session-card ${isActive ? 'active' : ''}`;
    
    const timeAgo = formatTimeAgo(s.updated_at);

    card.innerHTML = `
      <div class="session-card-header">
        <span class="session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
        <div class="session-actions">
          <button class="session-act-btn rename" title="Rename conversation">✏️</button>
          <button class="session-act-btn delete" title="Delete conversation">🗑️</button>
        </div>
      </div>
      <div class="session-card-meta">
        <span>${timeAgo}</span>
        <span class="session-model-pill">${s.model || 'auto'}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.session-actions')) return;
      loadSession(s.id);
    });

    const renameBtn = card.querySelector('.session-act-btn.rename');
    renameBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newTitle = prompt('Enter new conversation title:', s.title);
      if (newTitle && newTitle.trim()) {
        s.title = newTitle.trim();
        if (s.id === currentSessionId) currentSessionTitle = s.title;
        await fetch('/v1/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id, title: s.title, messages: s.messages || conversationHistory }),
        });
        await loadSessionsList();
      }
    });

    const deleteBtn = card.querySelector('.session-act-btn.delete');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete conversation "${s.title}"?`)) {
        await deleteSession(s.id);
      }
    });

    chatSessionsList.appendChild(card);
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Recently';
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function loadSession(id) {
  try {
    const res = await fetch(`/v1/chats/${id}`);
    if (!res.ok) return;
    const data = await res.json();

    currentSessionId = data.id;
    currentSessionTitle = data.title || 'Conversation';
    activeFileTargets = Array.isArray(data.active_file_targets) ? data.active_file_targets : [];
    localStorage.setItem('nexus_current_session_id', currentSessionId);

    conversationHistory.length = 0;
    chatMessages.innerHTML = '';

    if (data.messages && data.messages.length > 0) {
      for (const m of data.messages) {
        conversationHistory.push(m);
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '');
        appendMessage(m.role, text, m.role === 'assistant' ? (data.model || 'Assistant') : null);
      }
    } else {
      chatMessages.innerHTML = `
        <div class="message assistant">
          <div class="message-meta">
            <span class="sender-tag">NexusRoute Gateway</span>
            <span class="time-tag">Loaded</span>
          </div>
          <div class="message-body">
            Conversation <strong>${escapeHtml(currentSessionTitle)}</strong> loaded.
          </div>
        </div>
      `;
    }

    if (data.model && modelSelect) {
      modelSelect.value = data.model;
    }

    sessionTotalTokens = data.telemetry?.totalTokens || 0;
    sessionTotalCost = data.telemetry?.totalCost || 0.0;
    if (kpiTokens) kpiTokens.textContent = `${sessionTotalTokens.toLocaleString()} tok`;
    if (kpiTokenBreakdown) kpiTokenBreakdown.textContent = `Total: ${sessionTotalTokens.toLocaleString()} tok`;
    if (kpiSessionTokens) kpiSessionTokens.textContent = `${sessionTotalTokens.toLocaleString()} tok`;
    if (kpiSessionCost) kpiSessionCost.textContent = `Total Cost: ${formatCurrency(sessionTotalCost, 5)}`;

    renderSessionsList(allSessions);
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

async function saveCurrentSession() {
  if (conversationHistory.length === 0) return;

  const firstUserMsg = conversationHistory.find(m => m.role === 'user');
  if (currentSessionTitle === 'New Conversation' && firstUserMsg) {
    const raw = typeof firstUserMsg.content === 'string' ? firstUserMsg.content : (Array.isArray(firstUserMsg.content) ? firstUserMsg.content.map(c => c.text || '').join(' ') : '');
    currentSessionTitle = raw.slice(0, 40).trim() || 'New Conversation';
  }

  const sessionData = {
    id: currentSessionId,
    title: currentSessionTitle,
    messages: conversationHistory,
    model: modelSelect ? modelSelect.value : 'auto',
    active_file_targets: activeFileTargets,
    telemetry: {
      totalTokens: sessionTotalTokens,
      totalCost: sessionTotalCost,
    },
  };

  try {
    localStorage.setItem(`nexus_chat_${currentSessionId}`, JSON.stringify(sessionData));
    localStorage.setItem('nexus_current_session_id', currentSessionId);
    await fetch('/v1/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionData),
    });
    await loadSessionsList();
  } catch (err) {
    console.warn('Failed to persist chat session:', err);
  }
}

function createNewSession() {
  currentSessionId = `session_${Date.now()}`;
  currentSessionTitle = 'New Conversation';
  localStorage.setItem('nexus_current_session_id', currentSessionId);
  conversationHistory.length = 0;
  activeFileTargets = [];

  chatMessages.innerHTML = `
    <div class="claude-code-hero" id="claudeCodeHero">
      <div class="cc-box">
        <div class="cc-box-header">
          <span class="cc-box-title">Claude Code v2.1.6</span>
        </div>
        <div class="cc-box-content">
          <div class="cc-left-pane">
            <div class="cc-welcome-text">Welcome back!</div>
            <div class="cc-mascot-wrap">
              <svg class="claude-code-pixel-bot" viewBox="0 0 16 14" width="56" height="49" shape-rendering="crispEdges">
                <rect x="2" y="0" width="2" height="3" fill="#d97757" />
                <rect x="12" y="0" width="2" height="3" fill="#d97757" />
                <rect x="0" y="3" width="16" height="7" fill="#d97757" />
                <rect x="3" y="4" width="2" height="2" fill="#0d0d0d" />
                <rect x="11" y="4" width="2" height="2" fill="#0d0d0d" />
                <rect x="3" y="10" width="2" height="4" fill="#d97757" />
                <rect x="6" y="10" width="2" height="3" fill="#d97757" />
                <rect x="8" y="10" width="2" height="3" fill="#d97757" />
                <rect x="11" y="10" width="2" height="4" fill="#d97757" />
              </svg>
            </div>
            <div class="cc-sub-bar">
              <span>Sonnet 4.5 · Gemini 3.7 · RTX 4060 · PromptForge</span>
            </div>
            <div class="cc-path">~\\Claude Code · NexusRoute</div>
          </div>

          <div class="cc-divider"></div>

          <div class="cc-right-pane">
            <div class="cc-section-title">Tips for getting started</div>
            <div class="cc-section-desc">Ask Claude or Gemini to create an app, build an Android game, or generate PromptForge art</div>

            <div class="cc-section-title cc-margin-top">Recent activity</div>
            <div class="cc-recent-activity">
              <div class="cc-recent-item">⚡ <strong>APB Police Pursuit</strong> · Android Native APK</div>
              <div class="cc-recent-item">🎨 <strong>PromptForge Studio</strong> · SDXL / Local Turbo</div>
            </div>
          </div>
        </div>
      </div>
      <div class="cc-footer-hint">
        <span class="cc-hint-item"><code>/model</code> to try Claude 3.7 Sonnet or Gemini Flash</span>
        <span class="cc-hint-item"><code>?</code> for shortcuts · PromptForge RTX connected</span>
      </div>
    </div>
  `;

  sessionTotalTokens = 0;
  sessionTotalCost = 0.0;
  lastReportedCostUsd = 0.0;
  lastRequestCacheSavingsUsd = 0.0;
  lastRequestCachedTokens = 0;
  lastRequestCacheDiscountUsd = 0.0;
  lastRequestCostSource = 'estimated';
  if (kpiTokens) kpiTokens.textContent = '0 tok';
  if (kpiTokenBreakdown) kpiTokenBreakdown.textContent = 'P: 0 | C: 0 (⚡ 0 tok/s)';
  if (kpiSessionTokens) kpiSessionTokens.textContent = '0 tok';
  if (kpiSessionCost) kpiSessionCost.textContent = 'Total Cost: $0.000000';
  if (kpiLatency) kpiLatency.textContent = '-';
  if (kpiCost) kpiCost.textContent = '$0.000000';
  updateRequestCostDetails();
  waterfallList.innerHTML = '<div class="waterfall-empty">Fresh session started. Send a prompt to inspect.</div>';
  attemptsBadge.textContent = '0 Attempts';

  renderSessionsList(allSessions);
  renderRandomPresets();
}

async function deleteSession(id) {
  try {
    await fetch(`/v1/chats/${id}`, { method: 'DELETE' });
    localStorage.removeItem(`nexus_chat_${id}`);
    if (currentSessionId === id) {
      createNewSession();
    }
    await loadSessionsList();
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
}

// History Toggle & Search Listeners
if (toggleHistoryBtn) {
  toggleHistoryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chatSidebar.classList.toggle('hidden');
    if (!chatSidebar.classList.contains('hidden')) {
      loadSessionsList();
    }
  });
}

if (closeSidebarBtn) {
  closeSidebarBtn.addEventListener('click', () => {
    chatSidebar.classList.add('hidden');
  });
}

// Click away anywhere outside the sidebar to dismiss history
document.addEventListener('click', (e) => {
  if (chatSidebar && !chatSidebar.classList.contains('hidden')) {
    if (!chatSidebar.contains(e.target) && !toggleHistoryBtn.contains(e.target)) {
      chatSidebar.classList.add('hidden');
    }
  }
});

if (sidebarNewChatBtn) {
  sidebarNewChatBtn.addEventListener('click', () => {
    createNewSession();
  });
}

const newChatBtn = document.getElementById('newChatBtn');
if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    createNewSession();
  });
}

if (searchChatsInput) {
  searchChatsInput.addEventListener('input', () => {
    renderSessionsList(allSessions);
  });
}

if (clearAllHistoryBtn) {
  clearAllHistoryBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete ALL saved conversations? This cannot be undone.')) {
      await fetch('/v1/chats', { method: 'DELETE' });
      for (const s of allSessions) {
        localStorage.removeItem(`nexus_chat_${s.id}`);
      }
      createNewSession();
      await loadSessionsList();
    }
  });
}

// =========================================================================
// INFINITE DYNAMIC CONTEXTUAL PRESET PROMPT GENERATOR & IDEA SYNTHESIZER
// =========================================================================

function fisherYatesShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const CURATED_PROMPT_DATABASE = [
  // 🎮 3D, Android & Retro Vector Games
  { category: 'gaming', label: '🎮 1983 Vector Trench Run', prompt: 'Build a complete playable 1983 Atari Star Wars inspired 3D vector trench run game in trench_run.html using Three.js and UnrealBloomPass with wireframe neon canyon, TIE fighter dogfights, proton torpedo exhaust port finale, and procedural Web Audio SFX.' },
  { category: 'gaming', label: '📱 APB Police Pursuit APK', prompt: 'Build a complete high-octane native Android top-down police combat game APK named APBPursuit in apb_pursuit.apk using build_android_apk. Features sirens, touch steering, wanted bounties, EMP shockwave, chopper support, ToneGenerator sound DSP, and auto-launch on emulator!' },
  { category: 'gaming', label: '🎮 Cyberpunk Raycaster 3D', prompt: 'Build a complete Wolfenstein 3D style pseudo-3D raycaster game in raycaster.html with neon textured walls, glowing sprite enemies, minimap, weapon firing animations, and retro sound effects.' },
  { category: 'gaming', label: '🎮 3D Wireframe Asteroids', prompt: 'Create a full 3D vector arcade Asteroids space shooter in asteroids_3d.html with 6DOF ship flight, glowing neon particle explosions, splitting asteroids, hyperspace button, and CRT bloom post-processing.' },
  { category: 'gaming', label: '🎮 Neon Pinball Physics', prompt: 'Build a single-file playable neon pinball game in pinball.html with realistic flipper physics, bumpers, multiball drop targets, particle spark trails, and score combos.' },
  { category: 'gaming', label: '🎮 Matrix Falling Sand Sim', prompt: 'Build an interactive falling sand cellular automata simulation in falling_sand.html with sand, water, fire, gunpowder, acid, glass, and plant elements that react chemically with mouse drawing.' },
  { category: 'gaming', label: '🎮 Tron Lightcycle Duel', prompt: 'Create a 3D Tron Lightcycle arena combat game in lightcycle.html where player and AI steer glowing light trails that leave solid lethal light walls at 60fps.' },
  { category: 'gaming', label: '🎮 Brick Breaker Arcade', prompt: 'Build a complete playable Brick Breaker arcade game in brick_breaker.html with paddle physics, particle explosions, laser power-ups, multiball, and Web Audio SFX.' },
  { category: 'gaming', label: '🎮 Roguelike Dungeon Crawler', prompt: 'Create a complete playable turn-based Roguelike dungeon crawler in dungeon.html with procedural floor generation, fog of war, inventory, loot chests, and turn-based combat.' },
  { category: 'gaming', label: '🎮 3D Missile Command', prompt: 'Build an arcade 3D Missile Command defense game in missile_command.html with incoming ICBM parabolic trajectories, explosive blast radiuses, interceptor batteries, and neon city silhouettes.' },
  { category: 'gaming', label: '🎮 Retro Lunar Lander 3D', prompt: 'Build an Apollo 11 Lunar Lander vector flight sim in lunar_lander.html with realistic gravity thrust physics, fuel management, crater landing pads, and radio telemetry.' },
  { category: 'gaming', label: '🎮 Neon Space Invaders', prompt: 'Create a neon vector Space Invaders arcade game in space_invaders.html with marching alien fleets, destructible shields, UFO bonus ships, and pulsing 4-tone bass sound effects.' },

  // 🎨 Mind-Blowing Studio Art & Visuals (PromptForge SDXL)
  { category: 'art', label: '🎨 Dalek Synthwave 1980s', prompt: 'Generate an award-winning retro 80s synthwave digital masterpiece of a golden Dalek cruising down an infinite glowing neon wireframe highway towards a giant magenta digital sun with palm trees and laser grids.' },
  { category: 'art', label: '🎨 Cyberpunk Neon City', prompt: 'Generate an award-winning cinematic masterpiece of a hyper-detailed cyberpunk metropolis at midnight with flying spinners, holographic neon billboards in torrential rain, reflections on wet asphalt, volumetric fog, and razor-sharp 8k details.' },
  { category: 'art', label: '🎨 Cosmic Moon Fisher', prompt: 'Generate a stunning award-winning digital artwork of a lone astronaut sitting peacefully on a lunar crater ledge fishing into a shimmering cosmic nebula with the glowing blue marble Earth rising in the background, Hasselblad 80mm lens, ray-traced starlight, 8k resolution.' },
  { category: 'art', label: '🎨 Ghibli Floating Island', prompt: 'Create a breathtaking Studio Ghibli inspired watercolor painting of a lush floating island fortress drifting through fluffy golden cumulus clouds at sunrise with ancient windmills, lush waterfalls cascading into open sky, and flock of white birds.' },
  { category: 'art', label: '🎨 Steampunk Chrono-Owl', prompt: 'Create a hyper-realistic macro photograph of an intricate steampunk mechanical owl with polished brass gears, titanium filigree plumage, and glowing blue sapphire lenses, dramatic studio lighting, 8k resolution, depth of field.' },
  { category: 'art', label: '🎨 Retro Sci-Fi 1970s Cover', prompt: 'Design a vintage 1970s sci-fi paperback book cover titled "The Last Starhopper" with Chris Foss style cosmic spaceships, swirling interstellar nebulae, bold retro typography, and vibrant airbrush textures.' },
  { category: 'art', label: '🎨 Synthwave DeLorean Highway', prompt: 'Generate an iconic synthwave digital art piece of a chrome DeLorean speeding down an endless glowing neon grid wireframe highway toward a giant magenta retro sun with palm tree silhouettes and purple laser grids.' },
  { category: 'art', label: '🎨 Deep Sea Leviathan', prompt: 'Generate a cinematic deep-ocean digital painting of an atmospheric research submarine discovering a colossal mythical bioluminescent dragon-leviathan glowing with cyan and violet light in the Mariana Trench.' },
  { category: 'art', label: '🎨 Da Vinci Flying Mech', prompt: 'Create an authentic Renaissance parchment blueprint in the style of Leonardo da Vinci illustrating a fantastical clockwork flying dragon with sepia ink sketches, Italian mirror-writing annotations, and anatomical cross-sections.' },
  { category: 'art', label: '🎨 Eldritch Crystal Cavern', prompt: 'Generate a dark high-fantasy digital painting of an ancient scholar discovering towering glowing purple amethyst monoliths inscribed with alien runes in a subterranean basalt temple.' },
  { category: 'art', label: '🎨 Solarpunk Coastal Ecocity', prompt: 'Generate a luminous solarpunk digital painting of an idyllic coastal white-terrace ecocity with vertical glass greenhouses, cascading waterfalls, solar gliders, and turquoise Mediterranean waters.' },

  // 💻 Creative Web Apps, Audio DSP & Tools
  { category: 'coding', label: '🎵 Sound Forge Spectrum Deck', prompt: 'Create an interactive studio audio DSP spectrum analyzer in spectrum_deck.html with real-time FFT frequency bars, peak VU meters, customizable color gradients, and Web Audio mic/file input.' },
  { category: 'coding', label: '🎹 16-Step Beatbox Synth', prompt: 'Build a sleek 16-step drum machine and chiptune synth in synth_sequencer.html with Web Audio oscillators, kick/snare/hihat synthesis, tempo BPM slider, and pattern saving.' },
  { category: 'coding', label: '🌌 3D N-Body Gravity Sim', prompt: 'Build an interactive 3D N-body orbital gravity simulator in gravity_sim.html where users can click to spawn stars, planets, and black holes with trailing velocity vectors and collision merging.' },
  { category: 'coding', label: '📊 Glassmorphic Kanban Board', prompt: 'Build a clean modern interactive Kanban board web app in kanban.html with drag-and-drop task cards, color labels, search filter, and local storage persistence.' },
  { category: 'coding', label: '🎨 Color Palette Extractor', prompt: 'Build a single-file web tool in palette.html where users can drag and drop any image to extract its dominant 6-color palette, color harmony schemes, and copy HEX/RGB codes.' },
  { category: 'coding', label: '🌀 Fractal Mandelbrot Zoomer', prompt: 'Create a real-time GPU-accelerated Mandelbrot and Julia set fractal explorer in fractal.html with smooth mouse drag-zooming, color palette cycling, and coordinate readout.' },
  { category: 'coding', label: '⏱️ Matrix Cyberpunk Timer', prompt: 'Build a cyberpunk Matrix-themed Pomodoro productivity timer in timer.html with falling green glyphs, work/break interval audio chime, task checklist, and streak counter.' },
  { category: 'coding', label: '📝 Visual Mindmap Graph', prompt: 'Build an interactive visual mindmap and markdown note editor in mindmap.html with force-directed node physics, search, zoom/pan canvas, and export.' },

  // 🧠 Deep Reasoning, Paradoxes & Logic
  { category: 'reasoning', label: '🧠 Fermi Paradox & Dark Forest', prompt: 'Provide a rigorous scientific analysis of the Fermi Paradox: Contrast the Great Filter hypothesis, Rare Earth hypothesis, and Liu Cixin\'s Dark Forest theory, evaluating each against modern exoplanet data.' },
  { category: 'reasoning', label: '🧠 Newcomb\'s Decision Paradox', prompt: 'Explain Newcomb\'s Paradox in decision theory: Contrast Causal Decision Theory (two-boxing) versus Evidential Decision Theory (one-boxing) and explain why superrationality favors one-boxing.' },
  { category: 'reasoning', label: '🧠 Ship of Theseus & AI Weights', prompt: 'Analyze the Ship of Theseus paradox through the lens of modern AI consciousness and gradual neural replacement (Moravec transfer). Where does identity persist if weights and memories are mirrored?' },
  { category: 'reasoning', label: '🧮 3 Incorrect Boxes Puzzle', prompt: 'Solve this logic puzzle step-by-step: Three boxes are labeled Apples, Oranges, and Mixed. Every single label is guaranteed to be wrong. You can pick exactly 1 fruit from 1 box. How do you deduce all correct labels?' },
  { category: 'reasoning', label: '🎲 100 Prisoners Cycle Proof', prompt: 'Explain the 100 Prisoners problem with the closed permutation cycle strategy. Prove mathematically why following the box cycles raises the survival probability from 1/(2^100) to over 31.18%.' },
  { category: 'reasoning', label: '♟️ Iterated Tit-for-Tat Game', prompt: 'Explain the mathematical payoff matrix of the Prisoner\'s Dilemma and prove why Iterated Tit-for-Tat and Generous Tit-for-Tat are evolutionary stable strategies in repeated games.' },

  // 🔬 Science, Space & Quantum Physics
  { category: 'science', label: '🚀 Dyson Swarm Energy Physics', prompt: 'Explain the engineering physics of constructing a Dyson Swarm around the Sun: Address orbital mechanics, statite radiation-pressure levitation, mass requirements from Mercury, and microwave power transmission.' },
  { category: 'science', label: '⚛️ Alcubierre Warp Metric', prompt: 'Explain the physics of the Alcubierre warp drive metric in General Relativity: How does it contract space-time ahead and expand it behind, and what are the exotic matter (negative energy) constraints?' },
  { category: 'science', label: '🧬 CRISPR-dCas9 Epigenetics', prompt: 'Explain how CRISPR-dCas9 (dead Cas9) fusion proteins perform targeted epigenetic silencing and activation without cutting DNA double strands, and its medical implications.' },
  { category: 'science', label: '🌌 Holographic Principle & BH', prompt: 'Explain Hawking radiation, the Black Hole Information Paradox, and how the AdS/CFT correspondence and holographic entanglement entropy propose to resolve the loss of quantum information.' },

  // 🛠️ System, Automation & Real-Time Powers
  { category: 'tools', label: '🌐 Web Search Frontier AI', prompt: 'Search the web for the latest major open-source AI models and release highlights from this month and summarize the top 3.' },
  { category: 'tools', label: '📁 Workspace Audit & Files', prompt: 'List all files currently created in the workspace directory and report their file sizes, categories, and modification dates.' },
  { category: 'tools', label: '💱 £ Compound Growth Calc', prompt: 'Calculate the total accumulated value and interest on £20,000 invested at 8.4% annual return compounded monthly over 15 years using the calculator tool.' },
  { category: 'tools', label: '⚡ Test System & Diagnostics', prompt: 'Run execute_command to verify our TypeScript build compiles with zero errors and test our Android ADB device bridge connection.' }
];

// Procedural Combinatorial Idea Generator Matrices
const PROCEDURAL_MATRICES = {
  games: {
    genres: [
      { name: 'Vector Tank Combat Arena', file: 'vector_tank_arena.html' },
      { name: 'Cyberpunk Neon Raycaster 3D', file: 'neon_raycaster.html' },
      { name: 'Retro Tron Lightcycle Duel', file: 'tron_lightcycle.html' },
      { name: '3D Wireframe Asteroids', file: 'asteroids_3d.html' },
      { name: 'Glow Pinball Physics Sandbox', file: 'glow_pinball.html' },
      { name: 'Matrix Rain Falling Sand Sim', file: 'falling_sand.html' },
      { name: 'Neon Space Invaders with Bloom', file: 'space_invaders_neon.html' },
      { name: '3D Vector Flight Dogfight Sim', file: 'dogfight_3d.html' },
      { name: 'Cyberpunk Drone Descent Maze', file: 'drone_descent.html' },
      { name: 'Retro Wireframe Lunar Lander', file: 'lunar_lander_3d.html' },
      { name: 'Hovercraft Slipstream Racer', file: 'hover_racer.html' },
      { name: 'Arcade Missile Silo Defense', file: 'missile_defense.html' }
    ],
    mechanics: [
      'ricocheting laser beams, destructible cover, and particle spark explosions',
      'smooth 60fps mouse crosshair aiming, dash dodging, and combo score multipliers',
      'procedural labyrinth maze generation, enemy patrol AI, and boss battles',
      'realistic gravity physics, elastic collision impulses, and slow-motion bullet time',
      'power-up pickups, shield regeneration, and high-score local storage saving',
      'boost slipstreams, neon trail collisions, and dynamic camera shake'
    ],
    aesthetics: [
      'Three.js UnrealBloomPass wireframe neon glow with CRT scanline post-processing',
      'HTML5 Canvas 60fps retro green phosphor CRT vector arcade aesthetics',
      'vibrant synthwave magenta/cyan vector wireframe visuals with stars',
      'deep amber retro terminal graphics with high-contrast bloom'
    ],
    audio: [
      'procedural Web Audio chiptune laser synthesizers and noise explosion envelopes',
      '8-bit retro arcade synth SFX and dynamic engine hum pitch shifting',
      'procedural FM synth arpeggiator bassline and retro drum beats',
      'dynamic stereo panning laser pulses and resonant low-pass filter sweeps'
    ]
  },
  apps: {
    types: [
      { name: 'Interactive 3D Planetary Gravity Sim', file: 'gravity_sandbox.html' },
      { name: '16-Step Chiptune Beatbox Sequencer', file: 'step_sequencer.html' },
      { name: 'Glassmorphic Audio Spectrum Deck', file: 'audio_spectrum.html' },
      { name: 'Fractal Chaos Explorer & Zoomer', file: 'fractal_explorer.html' },
      { name: 'Retro ASCII Art Video Camera', file: 'ascii_camera.html' },
      { name: 'Physics Particle Sandbox Playground', file: 'particle_physics.html' },
      { name: 'Interactive Neural Network Visualizer', file: 'nn_visualizer.html' },
      { name: 'Web Audio Synthesizer Keyboard', file: 'poly_synth.html' },
      { name: 'Algorithmic Cellular Music Matrix', file: 'cellular_music.html' }
    ],
    features: [
      'interactive mouse controls, real-time parameter sliders, and smooth 60fps rendering',
      'drag-and-drop file import, preset saving to localStorage, and fullscreen support',
      'reactive audio synthesis, customizable color gradients, and export capabilities',
      'custom envelope ADSR dials, dual oscillators, and stereo chorus FX'
    ]
  },
  art: {
    styles: [
      'hyper-detailed cyberpunk concept art',
      'vintage 1970s Moebius-style sci-fi illustration',
      'dramatic chiaroscuro oil painting in the style of Rembrandt',
      'ethereal Studio Ghibli watercolor landscape',
      'intricate Leonardo da Vinci sepia parchment blueprint',
      'epic dark fantasy digital masterpiece',
      'vibrant 80s synthwave retro outrun digital art',
      'award-winning National Geographic macro wildlife photography'
    ],
    subjects: [
      'a lone cybernetic ronin meditating beneath a glowing holographic cherry blossom tree',
      'an ancient colossal stone golem overgrown with bioluminescent alien moss',
      'a retro-futuristic Victorian observatory situated on the icy rings of Saturn',
      'a deep-sea research submarine discovering a majestic glowing leviathan in the abyss',
      'a bustling neo-Tokyo night market in torrential rain with flying noodle carts and neon umbrellas',
      'a celestial phoenix with liquid gold flame plumage rising from a crystal volcanic caldera',
      'a chrome sports car speeding towards a giant wireframe sun down a neon highway',
      'a metallic scarab beetle perched on moss with a dewdrop reflecting a spiral galaxy'
    ],
    atmospheres: [
      'volumetric god rays, neon puddle reflections, moody cinematic fog, and razor-sharp 8k details',
      'golden hour sunset light with anamorphic lens flares and rich atmospheric haze',
      'dramatic high-contrast rim lighting, cinematic depth of field, and ray-traced starlight',
      'mystical crystal luminescence, floating spore particles, and deep chromatic depth'
    ]
  },
  reasoning: {
    topics: [
      { name: '🧠 Newcomb\'s Paradox', prompt: 'Analyze Newcomb\'s Paradox in decision theory: Compare Causal vs Evidential decision theory and explain why a predictive predictor breaks standard dominance principles.' },
      { name: '🧠 Quantum Zeno Effect', prompt: 'Explain the Quantum Zeno Effect: How does continuous quantum measurement physically freeze the time-evolution of an unstable quantum state?' },
      { name: '🧠 Gödel\'s Incompleteness', prompt: 'Explain the core intuition behind Gödel\'s First and Second Incompleteness Theorems without dense formal jargon, using self-referential arithmetic statements.' },
      { name: '🧠 Prisoner Dilemma Superrationality', prompt: 'Explain Douglas Hofstadter\'s concept of "Superrationality" in the Prisoner\'s Dilemma and explain why two symmetric rational agents will choose cooperation.' },
      { name: '🧠 Boltzmann Brain Paradox', prompt: 'Explain the Boltzmann Brain paradox in statistical thermodynamics and cosmology: Why does standard thermodynamic fluctuation theory imply random brain formation is more probable than an entire universe?' }
    ]
  },
  science: {
    topics: [
      { name: '🚀 Fusion Tokamak Physics', prompt: 'Explain the physics of magnetic confinement fusion in a Tokamak: Detail the roles of toroidal and poloidal magnetic fields in suppressing plasma drift and turbulence.' },
      { name: '🌌 James Webb Deep Fields', prompt: 'Explain how the James Webb Space Telescope uses gravitational lensing to observe primordial galaxies from the first 300 million years after the Big Bang.' },
      { name: '🧬 Synthetic Biology & Xenobots', prompt: 'Explain how synthetic biology and algorithmic morphogenesis are used to design programmable biological organisms (Xenobots) from stem cells.' },
      { name: '⚡ Room-Temp Superconductors', prompt: 'Explain the BCS theory of superconductivity, Cooper pairs, and what physical crystal lattice mechanisms are required for high-temperature or ambient superconductivity.' }
    ]
  }
};

function generateProceduralGameIdea() {
  const g = PROCEDURAL_MATRICES.games.genres[Math.floor(Math.random() * PROCEDURAL_MATRICES.games.genres.length)];
  const m = PROCEDURAL_MATRICES.games.mechanics[Math.floor(Math.random() * PROCEDURAL_MATRICES.games.mechanics.length)];
  const a = PROCEDURAL_MATRICES.games.aesthetics[Math.floor(Math.random() * PROCEDURAL_MATRICES.games.aesthetics.length)];
  const au = PROCEDURAL_MATRICES.games.audio[Math.floor(Math.random() * PROCEDURAL_MATRICES.games.audio.length)];
  return {
    category: 'gaming',
    label: `🎮 ${g.name.split(' ').slice(0, 3).join(' ')}`,
    prompt: `Build a complete playable single-file standalone ${g.name} game in ${g.file} featuring ${m}, ${a}, and ${au}. Save the complete file to the workspace using the write_file tool.`
  };
}

function generateProceduralArtIdea() {
  const s = PROCEDURAL_MATRICES.art.styles[Math.floor(Math.random() * PROCEDURAL_MATRICES.art.styles.length)];
  const subj = PROCEDURAL_MATRICES.art.subjects[Math.floor(Math.random() * PROCEDURAL_MATRICES.art.subjects.length)];
  const atm = PROCEDURAL_MATRICES.art.atmospheres[Math.floor(Math.random() * PROCEDURAL_MATRICES.art.atmospheres.length)];
  const shortSubject = subj.split(' ').slice(1, 4).join(' ');
  return {
    category: 'art',
    label: `🎨 ${shortSubject.charAt(0).toUpperCase() + shortSubject.slice(1)}`,
    prompt: `Generate an award-winning ${s} of ${subj} with ${atm}. Use generate_image.`
  };
}

function generateProceduralAppIdea() {
  const t = PROCEDURAL_MATRICES.apps.types[Math.floor(Math.random() * PROCEDURAL_MATRICES.apps.types.length)];
  const f = PROCEDURAL_MATRICES.apps.features[Math.floor(Math.random() * PROCEDURAL_MATRICES.apps.features.length)];
  return {
    category: 'coding',
    label: `💻 ${t.name.split(' ').slice(0, 3).join(' ')}`,
    prompt: `Build a complete single-file standalone web app for ${t.name} in ${t.file} featuring ${f}. Save to workspace using write_file.`
  };
}

function renderRandomPresets() {
  const container = document.getElementById('presetButtonsContainer');
  if (!container) return;

  // Generate 3 fresh procedural prompts on the fly
  const dynamicGame = generateProceduralGameIdea();
  const dynamicArt = generateProceduralArtIdea();
  const dynamicApp = generateProceduralAppIdea();

  // Pick from shuffled curated library with true Fisher-Yates
  const shuffledCurated = fisherYatesShuffle(CURATED_PROMPT_DATABASE);
  
  // Combine 3 dynamic procedural ideas + top shuffled curated picks
  const candidatePool = [
    dynamicGame,
    dynamicArt,
    dynamicApp,
    ...shuffledCurated
  ];

  // Select 5 unique candidates across varied categories
  const finalFive = [];
  const usedLabels = new Set();
  
  for (const item of fisherYatesShuffle(candidatePool)) {
    if (item && item.label && item.prompt && !usedLabels.has(item.label)) {
      usedLabels.add(item.label);
      finalFive.push(item);
      if (finalFive.length >= 5) break;
    }
  }

  container.innerHTML = '';
  finalFive.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.setAttribute('data-prompt', item.prompt);
    btn.textContent = item.label || item.name;
    btn.title = item.prompt;
    btn.style.animationDelay = `${index * 0.04}s`;

    btn.addEventListener('click', () => {
      if (promptInput) {
        promptInput.disabled = false;
        promptInput.value = item.prompt;
        promptInput.focus();
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
      }
    });
    container.appendChild(btn);
  });
}

const shufflePresetsBtn = document.getElementById('shufflePresetsBtn');
if (shufflePresetsBtn) {
  shufflePresetsBtn.addEventListener('click', () => {
    renderRandomPresets();
    shufflePresetsBtn.style.transform = 'rotate(360deg)';
    setTimeout(() => { shufflePresetsBtn.style.transform = ''; }, 350);
  });
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => {
    renderRandomPresets();
  });
}

// Initial render
renderRandomPresets();

// Endless Forge Art Director Action Controls (Buttons & Dropdown)
const endlessForgeSelect = document.getElementById('endlessForgeSelect');
const endlessForgeBtnGroup = document.getElementById('endlessForgeBtnGroup');

let endlessForgePollTimer = null;
let lastSeenEndlessForgeId = 0;
const displayedEndlessForgeIds = new Set();

function startEndlessForgeWatcher() {
  if (endlessForgePollTimer) clearInterval(endlessForgePollTimer);
  endlessForgePollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/v1/endless-forge/poll?since=${lastSeenEndlessForgeId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.newEntries && Array.isArray(data.newEntries)) {
        for (const entry of data.newEntries) {
          if (!displayedEndlessForgeIds.has(entry.id)) {
            displayedEndlessForgeIds.add(entry.id);
            lastSeenEndlessForgeId = Math.max(lastSeenEndlessForgeId, entry.id);
            if (entry.formattedText) {
              appendMessage('assistant', entry.formattedText, 'Endless Forge RTX');
            }
          }
        }
      }
      updateEndlessForgeUIState(data.state, data.currentProgress, data.maxArtworks, data.isProcessing);
      if (data.state === 'stopped') {
        clearInterval(endlessForgePollTimer);
        endlessForgePollTimer = null;
      }
    } catch {}
  }, 2000);
}

function updateEndlessForgeUIState(state, progress, maxArtworks, isProcessing) {
  const startBtn = document.querySelector('.ef-start');
  if (startBtn) {
    if (state === 'running') {
      startBtn.classList.add('ef-active-pulse');
      startBtn.title = `Endless Forge Running (${progress}/${maxArtworks})${isProcessing ? ' · Synthesizing on GPU...' : ''}`;
    } else {
      startBtn.classList.remove('ef-active-pulse');
      startBtn.title = 'Start continuous generation loop';
    }
  }
}

async function triggerEndlessForgeAction(actionText) {
  if (!actionText) return;
  const themeInput = document.getElementById('efThemeInput');
  const themeVal = themeInput ? themeInput.value.trim() : '';
  const displayMsg = themeVal && actionText.toLowerCase().includes('start')
    ? `${actionText} (Theme: ${themeVal})`
    : actionText;

  appendMessage('user', displayMsg);
  try {
    const res = await fetch('/v1/endless-forge/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionText, theme: themeVal }),
    });
    const data = await res.json();
    if (data.text) {
      if (data.artwork && !displayedEndlessForgeIds.has(data.artwork.id)) {
        displayedEndlessForgeIds.add(data.artwork.id);
        lastSeenEndlessForgeId = Math.max(lastSeenEndlessForgeId, data.artwork.id);
      }
      appendMessage('assistant', data.text, 'Endless Forge RTX');
    }
    if (data.status?.state === 'running') {
      startEndlessForgeWatcher();
    } else if (data.status?.state === 'stopped' || data.status?.state === 'paused') {
      if (endlessForgePollTimer) {
        clearInterval(endlessForgePollTimer);
        endlessForgePollTimer = null;
      }
    }
  } catch (err) {
    appendMessage('assistant', `⚠️ Could not reach Endless Forge backend: ${err.message}`, 'NexusRoute');
  }
}

// Auto-check on page load if a session is currently running
fetch('/v1/endless-forge/status')
  .then((r) => r.json())
  .then((d) => {
    if (d.success) {
      if (d.lastArtwork) {
        lastRenderedArtwork = d.lastArtwork;
      }
      if (d.currentDirection) {
        const themeInput = document.getElementById('efThemeInput');
        if (themeInput && !themeInput.value) themeInput.value = d.currentDirection;
      }
      if (d.state === 'running') {
        lastSeenEndlessForgeId = d.currentProgress || 0;
        startEndlessForgeWatcher();
      }
    }
  })
  .catch(() => {});

// --- Endless Forge Live Fullscreen Slideshow Mode ---
const efSlideshowBtn = document.getElementById('efSlideshowBtn');
const efSlideshowModal = document.getElementById('efSlideshowModal');
const efSlideshowCloseBtn = document.getElementById('efSlideshowCloseBtn');
const efSlideshowBackdrop = document.getElementById('efSlideshowBackdrop');
const efSlideshowImg = document.getElementById('efSlideshowImg');
const efSlideshowSpinner = document.getElementById('efSlideshowSpinner');
const efSlideshowCard = document.getElementById('efSlideshowCard');
const efSlideshowToggleCardBtn = document.getElementById('efSlideshowToggleCardBtn');
const efSsInfoToggleBtn = document.getElementById('efSsInfoToggleBtn');
const efSsExitTopBtn = document.getElementById('efSsExitTopBtn');
const efSlideshowTitle = document.getElementById('efSlideshowTitle');
const efSlideshowIntent = document.getElementById('efSlideshowIntent');
const efSlideshowProgress = document.getElementById('efSlideshowProgress');
const efSlideshowSeed = document.getElementById('efSlideshowSeed');
const efSlideshowSize = document.getElementById('efSlideshowSize');
const efSlideshowLiveBadge = document.getElementById('efSlideshowLiveBadge');
const efSsStartBtn = document.getElementById('efSsStartBtn');
const efSsPauseBtn = document.getElementById('efSsPauseBtn');
const efSsSkipBtn = document.getElementById('efSsSkipBtn');
const efSsEvolveBtn = document.getElementById('efSsEvolveBtn');
const efSsPivotBtn = document.getElementById('efSsPivotBtn');
const efSsDownloadBtn = document.getElementById('efSsDownloadBtn');

let lastRenderedArtwork = null;

function updateSlideshowArtwork(artwork, isProcessing = false) {
  if (!artwork) return;
  lastRenderedArtwork = artwork;

  if (efSlideshowImg && artwork.imageUrl && efSlideshowImg.src !== artwork.imageUrl) {
    efSlideshowImg.style.opacity = '0.3';
    efSlideshowImg.src = artwork.imageUrl;
    efSlideshowImg.onload = () => {
      efSlideshowImg.style.opacity = '1';
    };
  }

  if (efSlideshowTitle) efSlideshowTitle.textContent = artwork.title || 'Untitled';
  if (efSlideshowIntent) efSlideshowIntent.textContent = artwork.creativeIntent || '';
  if (efSlideshowProgress) efSlideshowProgress.textContent = `Piece ${artwork.progress || ''}`;
  if (efSlideshowSeed) efSlideshowSeed.textContent = `Seed: ${artwork.seed || '-'}`;
  if (efSlideshowSize) efSlideshowSize.textContent = `Size: ${artwork.size || '1024x1024'}`;
  if (efSsDownloadBtn && artwork.imageUrl) {
    efSsDownloadBtn.href = artwork.imageUrl;
    efSsDownloadBtn.download = `${(artwork.title || 'endless_forge').replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  }


}

function openEndlessForgeSlideshow() {
  if (!efSlideshowModal) return;
  efSlideshowModal.classList.remove('hidden');

  // Default to clean, un-obscured picture mode
  if (efSlideshowCard) efSlideshowCard.classList.add('minimized');

  // Request browser fullscreen if available
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } catch {}

  // Fetch newest artwork and status immediately
  fetch('/v1/endless-forge/poll?since=0')
    .then((r) => r.json())
    .then((data) => {
      if (data.lastArtwork) {
        updateSlideshowArtwork(data.lastArtwork, data.isProcessing);
      }
      if (data.state === 'running') {
        startEndlessForgeWatcher();
      }
    })
    .catch(() => {
      if (lastRenderedArtwork) {
        updateSlideshowArtwork(lastRenderedArtwork, false);
      }
    });
}

function closeEndlessForgeSlideshow() {
  if (!efSlideshowModal) return;
  efSlideshowModal.classList.add('hidden');
  try {
    if (document.exitFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  } catch {}
}

if (efSlideshowBtn) {
  efSlideshowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openEndlessForgeSlideshow();
  });
}

if (efSlideshowCloseBtn) efSlideshowCloseBtn.addEventListener('click', closeEndlessForgeSlideshow);
if (efSlideshowBackdrop) efSlideshowBackdrop.addEventListener('click', closeEndlessForgeSlideshow);
if (efSsExitTopBtn) efSsExitTopBtn.addEventListener('click', closeEndlessForgeSlideshow);

if (efSlideshowToggleCardBtn && efSlideshowCard) {
  efSlideshowToggleCardBtn.addEventListener('click', () => {
    efSlideshowCard.classList.toggle('minimized');
  });
}

if (efSsInfoToggleBtn && efSlideshowCard) {
  efSsInfoToggleBtn.addEventListener('click', () => {
    efSlideshowCard.classList.toggle('minimized');
  });
}

// Slideshow internal actions
if (efSsStartBtn) efSsStartBtn.addEventListener('click', () => triggerEndlessForgeAction('Start Endless Forge'));
if (efSsPauseBtn) efSsPauseBtn.addEventListener('click', () => triggerEndlessForgeAction('Pause Endless Forge'));
if (efSsSkipBtn) efSsSkipBtn.addEventListener('click', () => triggerEndlessForgeAction('Skip'));
if (efSsEvolveBtn) efSsEvolveBtn.addEventListener('click', () => triggerEndlessForgeAction('Evolve this'));
if (efSsPivotBtn) efSsPivotBtn.addEventListener('click', () => triggerEndlessForgeAction('Hard pivot'));

// Slideshow keyboard hotkeys (Esc, I)
document.addEventListener('keydown', (e) => {
  if (efSlideshowModal && !efSlideshowModal.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEndlessForgeSlideshow();
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      if (efSlideshowCard) efSlideshowCard.classList.toggle('minimized');
    }
  }
});

// Auto-hide topbar controls so picture is 100% clean and unobstructed
const efSlideshowTopBar = document.getElementById('efSlideshowTopBar');
let slideshowTopBarTimer = null;
document.addEventListener('mousemove', (e) => {
  if (efSlideshowModal && !efSlideshowModal.classList.contains('hidden') && efSlideshowTopBar) {
    if (e.clientY < 90 && e.clientX > window.innerWidth - 260) {
      efSlideshowTopBar.classList.add('user-active');
      if (slideshowTopBarTimer) clearTimeout(slideshowTopBarTimer);
      slideshowTopBarTimer = setTimeout(() => {
        efSlideshowTopBar.classList.remove('user-active');
      }, 2000);
    } else {
      efSlideshowTopBar.classList.remove('user-active');
    }
  }
});

// Update watcher to also notify slideshow in real-time
const originalStartWatcher = startEndlessForgeWatcher;
startEndlessForgeWatcher = function () {
  if (endlessForgePollTimer) clearInterval(endlessForgePollTimer);
  endlessForgePollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/v1/endless-forge/poll?since=${lastSeenEndlessForgeId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.newEntries && Array.isArray(data.newEntries)) {
        for (const entry of data.newEntries) {
          if (!displayedEndlessForgeIds.has(entry.id)) {
            displayedEndlessForgeIds.add(entry.id);
            lastSeenEndlessForgeId = Math.max(lastSeenEndlessForgeId, entry.id);
            lastRenderedArtwork = entry;
            if (entry.formattedText) {
              appendMessage('assistant', entry.formattedText, 'Endless Forge RTX');
            }
          }
        }
      }
      if (data.lastArtwork) {
        updateSlideshowArtwork(data.lastArtwork, data.isProcessing);
      }
      updateEndlessForgeUIState(data.state, data.currentProgress, data.maxArtworks, data.isProcessing);
      if (data.state === 'stopped') {
        clearInterval(endlessForgePollTimer);
        endlessForgePollTimer = null;
      }
    } catch {}
  }, 2000);
};

if (endlessForgeSelect) {
  endlessForgeSelect.addEventListener('change', () => {
    const action = endlessForgeSelect.value;
    if (action) {
      triggerEndlessForgeAction(action);
      endlessForgeSelect.selectedIndex = 0; // reset dropdown
    }
  });
}

if (endlessForgeBtnGroup) {
  endlessForgeBtnGroup.querySelectorAll('.ef-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.getAttribute('data-ef-action');
      if (action) {
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => { btn.style.transform = ''; }, 150);
        triggerEndlessForgeAction(action);
      }
    });
  });
}

// Clear Trace
if (clearTraceBtn && waterfallList) {
  clearTraceBtn.addEventListener('click', () => {
    waterfallList.innerHTML = '<div class="waterfall-empty">Traces cleared. Ready for next prompt.</div>';
    if (attemptsBadge) attemptsBadge.textContent = '0 Attempts';
  });
}

// Chaos Mode Toggle
if (chaosMockGpt4o) {
  chaosMockGpt4o.addEventListener('change', async (e) => {
    const shouldFail = e.target.checked;
    try {
      await fetch('/v1/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-gpt-4o', fail: shouldFail }),
      });
      if (chaosStatus) {
        chaosStatus.textContent = shouldFail ? 'Fault: mock-gpt-4o FAILING (429)' : 'Status: Normal';
        chaosStatus.style.color = shouldFail ? 'var(--accent-red)' : 'var(--text-muted)';
      }
    } catch (err) {
      console.error('Failed to set chaos mode:', err);
    }
  });
}

// Multimodal & File Attachment State
let attachedImageDataUrl = null;
const uploadImageBtn = document.getElementById('uploadImageBtn');
const attachImageBtn = document.getElementById('attachImageBtn');
const imageFileInput = document.getElementById('imageFileInput');
const faceLockPickBtn = document.getElementById('faceLockPickBtn');
const faceLockFileInput = document.getElementById('faceLockFileInput');
const faceLockToggle = document.getElementById('faceLockToggle');
const faceStrengthWrapper = document.getElementById('faceStrengthWrapper');
const faceStrengthSlider = document.getElementById('faceStrengthSlider');
const faceStrengthVal = document.getElementById('faceStrengthVal');
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const imagePreviewImg = document.getElementById('imagePreviewImg');
const removeImageBtn = document.getElementById('removeImageBtn');
const stopBtn = document.getElementById('stopBtn');
let currentAbortController = null;
let attachedImageFilename = 'attachment.png';
const MAX_ATTACHMENT_DIMENSION = 2048;
const MAX_ATTACHMENT_DATA_URL_CHARS = 2_000_000;

const attachTriggerBtn = attachImageBtn || uploadImageBtn;
if (attachTriggerBtn && imageFileInput) {
  attachTriggerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    imageFileInput.click();
  });
  imageFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) void handleAttachmentFile(file, false);
  });
}

if (faceLockPickBtn && faceLockFileInput) {
  faceLockPickBtn.addEventListener('click', (e) => {
    e.preventDefault();
    faceLockFileInput.click();
  });
  faceLockFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) void handleAttachmentFile(file, true);
  });
}

if (faceLockToggle) {
  faceLockToggle.addEventListener('change', () => {
    const active = faceLockToggle.checked;
    if (faceStrengthWrapper) faceStrengthWrapper.classList.toggle('hidden', !active);
    const card = imagePreviewImg?.parentElement;
    if (card) card.classList.toggle('face-lock-active', active);
    if (active && artEngineSelect) {
      artEngineSelect.value = 'promptforge';
    }
  });
}

if (faceStrengthSlider && faceStrengthVal) {
  faceStrengthSlider.addEventListener('input', () => {
    faceStrengthVal.textContent = faceStrengthSlider.value;
  });
}

if (removeImageBtn) {
  removeImageBtn.addEventListener('click', () => {
    attachedImageDataUrl = null;
    attachedImageFilename = 'attachment.png';
    if (imagePreviewContainer) imagePreviewContainer.classList.add('hidden');
    if (imageFileInput) imageFileInput.value = '';
    if (faceLockFileInput) faceLockFileInput.value = '';
    if (faceLockToggle) faceLockToggle.checked = false;
    if (faceStrengthWrapper) faceStrengthWrapper.classList.add('hidden');
    const card = imagePreviewImg?.parentElement;
    if (card) card.classList.remove('face-lock-active');
  });
}

// Paste Screenshot from Clipboard (Ctrl+V)
window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) void handleAttachmentFile(file, false);
      break;
    }
  }
});

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String(event.target?.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read the selected file.'));
    reader.readAsDataURL(blob);
  });
}

async function resizeImageForChat(file) {
  const originalDataUrl = await readBlobAsDataUrl(file);
  if (file.size <= 700_000) return originalDataUrl;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // The provider may still understand an image format the browser cannot
    // decode into a canvas, so keep it if it remains within the server limit.
    return originalDataUrl;
  }

  try {
    const firstScale = Math.min(1, MAX_ATTACHMENT_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const attempts = [
      { scale: firstScale, quality: 0.88 },
      { scale: Math.min(firstScale, 1600 / Math.max(bitmap.width, bitmap.height)), quality: 0.8 },
      { scale: Math.min(firstScale, 1280 / Math.max(bitmap.width, bitmap.height)), quality: 0.72 },
    ];

    let smallest = originalDataUrl;
    for (const attempt of attempts) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * attempt.scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * attempt.scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) continue;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const candidate = canvas.toDataURL('image/webp', attempt.quality);
      if (candidate.length < smallest.length) smallest = candidate;
      if (candidate.length <= MAX_ATTACHMENT_DATA_URL_CHARS) return candidate;
    }
    return smallest;
  } finally {
    bitmap.close?.();
  }
}

async function handleAttachmentFile(file, isFaceLock = false) {
  if (file.type.startsWith('image/')) {
    attachedImageFilename = file.name || (isFaceLock ? 'face_ref.png' : 'screenshot.png');
    try {
      attachedImageDataUrl = await resizeImageForChat(file);
      if (imagePreviewImg) imagePreviewImg.src = attachedImageDataUrl;
      const nameEl = document.getElementById('previewFilename');
      if (nameEl) {
        const approximateKb = Math.max(1, Math.round(attachedImageDataUrl.length * 0.75 / 1024));
        const optimized = attachedImageDataUrl.startsWith('data:image/webp') ? ' · optimized' : '';
        nameEl.textContent = `${attachedImageFilename} · ${approximateKb.toLocaleString()} KB${optimized}`;
      }
      if (imagePreviewContainer) imagePreviewContainer.classList.remove('hidden');

      if (isFaceLock && faceLockToggle) {
        faceLockToggle.checked = true;
        if (faceStrengthWrapper) faceStrengthWrapper.classList.remove('hidden');
        const card = imagePreviewImg?.parentElement;
        if (card) card.classList.add('face-lock-active');
        if (artEngineSelect) artEngineSelect.value = 'promptforge';
      }

      if (promptInput) promptInput.focus();
    } catch (err) {
      console.warn('Failed to prepare image attachment:', err);
      attachedImageDataUrl = null;
      if (imagePreviewContainer) imagePreviewContainer.classList.add('hidden');
      alert(`Could not attach this image: ${err.message || 'unknown image error'}`);
    }
  } else {
    // Text or code file: inject code snippet into prompt input
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result;
      if (promptInput && content) {
        const snippet = `### File: ${file.name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        promptInput.value = (promptInput.value ? promptInput.value + '\n\n' : '') + snippet;
        promptInput.focus();
      }
    };
    reader.readAsText(file);
  }
}

if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    setLoading(false);
  });
}

// Voice Speech-to-Text Recognition
const voiceInputBtn = document.getElementById('voiceInputBtn');
const voiceIcon = document.getElementById('voiceIcon');
let recognition = null;
let isRecording = false;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (voiceInputBtn) {
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isRecording = true;
      voiceInputBtn.classList.add('recording');
      if (voiceIcon) voiceIcon.textContent = '🔴';
      voiceInputBtn.title = 'Recording speech... Click to stop';
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript) {
        const prev = promptInput.value.trim();
        promptInput.value = prev ? `${prev} ${finalTranscript}` : finalTranscript;
      }
      promptInput.focus();
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      stopVoiceRecording();
      if (event.error === 'not-allowed') {
        alert('Microphone access was blocked. Please allow microphone permissions in your browser address bar.');
      }
    };

    recognition.onend = () => {
      stopVoiceRecording();
    };

    voiceInputBtn.addEventListener('click', () => {
      if (isRecording) {
        recognition.stop();
      } else {
        try {
          recognition.start();
        } catch {
          recognition.stop();
        }
      }
    });
  } else {
    voiceInputBtn.addEventListener('click', () => {
      alert('Speech Recognition is not supported by your current browser. For vocal speech-to-text dictation, please open NexusRoute in Google Chrome or Microsoft Edge.');
    });
  }
}

function stopVoiceRecording() {
  isRecording = false;
  if (voiceInputBtn) voiceInputBtn.classList.remove('recording');
  if (voiceIcon) voiceIcon.textContent = '🎤';
  if (voiceInputBtn) voiceInputBtn.title = 'Voice Input: Dictate prompt with your microphone (Click to Speak)';
}

// Text-to-Speech (TTS) Voice Synthesis
const ttsToggleBtn = document.getElementById('ttsToggleBtn');
const ttsIcon = document.getElementById('ttsIcon');
let isAutoTtsEnabled = false;

if (ttsToggleBtn) {
  ttsToggleBtn.addEventListener('click', () => {
    isAutoTtsEnabled = !isAutoTtsEnabled;
    if (isAutoTtsEnabled) {
      ttsToggleBtn.classList.add('active');
      if (ttsIcon) ttsIcon.textContent = '🔊';
      ttsToggleBtn.title = 'Auto Read-Aloud: ON (Click to mute)';
      if ('speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance('Voice output activated.');
        window.speechSynthesis.speak(utter);
      }
    } else {
      ttsToggleBtn.classList.remove('active');
      if (ttsIcon) ttsIcon.textContent = '🔈';
      ttsToggleBtn.title = 'Auto Read-Aloud: OFF (Click to enable)';
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }
  });
}

function speakCleanText(rawText) {
  if (!('speechSynthesis' in window) || !rawText) return;
  window.speechSynthesis.cancel();

  // Strip markdown, image tags, code blocks for clean speech
  const clean = rawText
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .replace(/```[\s\S]*?```/g, 'Code block omitted.')
    .replace(/`.*?`/g, '')
    .replace(/[*_~#>-]/g, '')
    .replace(/🛠️.*?\]/g, '')
    .trim();

  if (!clean) return;

  const utter = new SpeechSynthesisUtterance(clean);
  utter.rate = 1.05;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
}

// Enter key submits prompt, Shift+Enter inserts newline
if (promptInput) {
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (chatForm && chatForm.requestSubmit) {
        chatForm.requestSubmit();
      } else if (chatForm) {
        chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  });
}

// Submit prompt
if (chatForm) {
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
  const text = promptInput.value.trim();
  if (!text && !attachedImageDataUrl) return;

  const targetModel = modelSelect.value;
  const isStream = streamToggle.checked;
  const useTools = toolsToggle.checked;
  const artEngine = artEngineSelect ? artEngineSelect.value : 'cloud';

    let userContent;
    const isFaceLockActive = faceLockToggle && faceLockToggle.checked && attachedImageDataUrl;
    const faceStrength = faceStrengthSlider ? Number(faceStrengthSlider.value) : 0.65;

    if (isFaceLockActive) {
      try {
        // Save face reference image to workspace/face_references/
        const saveRes = await fetch('/v1/workspace/save-face-ref', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataUrl: attachedImageDataUrl,
            filename: attachedImageFilename || 'reference_face.png',
          }),
        }).then(r => r.json());

        const savedPath = saveRes.fullPath || `workspace/${saveRes.filename}`;
        const instructionText = `[Face Lock Active: Using reference face photo at "${savedPath}" with strength ${faceStrength} on PromptForge RTX (POST http://127.0.0.1:17861/v1/images/generations)]`;
        const promptWithFace = text ? `${text}\n\n${instructionText}` : `Generate a studio portrait of this person.\n\n${instructionText}`;

        userContent = [
          { type: 'text', text: promptWithFace },
          { type: 'image_url', image_url: { url: attachedImageDataUrl } }
        ];

        appendMessage('user', `${text || 'Generate character portrait.'}\n\n🎭 **Face Lock Active** (Strength: \`${faceStrength}\` | Ref: \`${saveRes.filename || 'face_reference.png'}\`)\n\n![Reference Face](${attachedImageDataUrl})`);
      } catch (err) {
        console.warn('Failed to save face reference to workspace:', err);
        userContent = text || 'Generate portrait with this reference face.';
        appendMessage('user', text);
      }

      attachedImageDataUrl = null;
      imagePreviewContainer.classList.add('hidden');
      if (imageFileInput) imageFileInput.value = '';
      if (faceLockFileInput) faceLockFileInput.value = '';
      if (faceLockToggle) faceLockToggle.checked = false;
      if (faceStrengthWrapper) faceStrengthWrapper.classList.add('hidden');
      const card = imagePreviewImg?.parentElement;
      if (card) card.classList.remove('face-lock-active');
    } else if (attachedImageDataUrl) {
      userContent = [
        { type: 'text', text: text || 'Inspect this screenshot/image.' },
        { type: 'image_url', image_url: { url: attachedImageDataUrl } }
      ];
      appendMessage('user', `${text || 'Inspect this screenshot.'}\n\n![Screenshot](${attachedImageDataUrl})`);
      attachedImageDataUrl = null;
      imagePreviewContainer.classList.add('hidden');
      if (imageFileInput) imageFileInput.value = '';
      if (faceLockFileInput) faceLockFileInput.value = '';
      if (faceLockToggle) faceLockToggle.checked = false;
      if (faceStrengthWrapper) faceStrengthWrapper.classList.add('hidden');
      const card = imagePreviewImg?.parentElement;
      if (card) card.classList.remove('face-lock-active');
    } else {
      userContent = text;
      appendMessage('user', text);
    }

  conversationHistory.push({ role: 'user', content: userContent });
  saveCurrentSession();
  promptInput.value = '';
  setLoading(true);

  const assistantMsgEl = appendMessage('assistant', '', targetModel);
  const bodyEl = assistantMsgEl ? assistantMsgEl.querySelector('.message-body') : null;
  if (bodyEl) bodyEl.innerHTML = '<span style="color: var(--text-muted); font-size: 13px;">⚡ Thinking...</span>';

  // Smart Sliding-Window Context Management (Prevents 28k-32k token overflow cutoffs)
  let messagesToSend = conversationHistory;
  if (conversationHistory.length > 12) {
    const systemMsgs = conversationHistory.filter(m => m.role === 'system');
    const nonSystem = conversationHistory.filter(m => m.role !== 'system');
    const firstUserMsg = nonSystem[0];
    const recentTurns = nonSystem.slice(-10);
    messagesToSend = [...systemMsgs, ...(firstUserMsg && !recentTurns.includes(firstUserMsg) ? [firstUserMsg] : []), ...recentTurns];
  }

  const payload = {
    model: targetModel,
    messages: messagesToSend,
    stream: isStream,
    session_id: currentSessionId,
    openrouter_routing: openRouterRoutingSelect?.value || 'balanced',
    metadata: { active_file_targets: activeFileTargets },
    art_engine: artEngine,
    enable_tools: useTools,
    tools: useTools ? availableTools : [],
  };

  currentAbortController = new AbortController();

  try {
    if (isStream) {
      await handleStreamRequest(payload, bodyEl);
    } else {
      await handleNonStreamRequest(payload, bodyEl);
    }
    await loadCacheStats();
    await saveCurrentSession();
  } catch (err) {
    const failedLed = document.getElementById('kpiModelLed');
    if (failedLed) {
      const aborted = err.name === 'AbortError';
      failedLed.className = `activity-led ${aborted ? 'idle' : 'error'}`;
      failedLed.title = aborted ? 'Model Status: Standby' : `Route failed: ${err.message}`;
    }
    if (bodyEl) {
      if (err.name === 'AbortError') {
        bodyEl.innerHTML += `<div style="color: var(--text-muted); font-size: 12px; margin-top: 8px;">⏹️ Generation stopped.</div>`;
      } else if (err.partialText) {
        // Only claim recovery attempts that actually took place - the old text
        // said this unconditionally, including when nothing was retried.
        const recovery = err.retriesUsed > 0
          ? `after ${err.retriesUsed} recovery attempt${err.retriesUsed === 1 ? '' : 's'}`
          : 'and could not be recovered';
        bodyEl.innerHTML = `${formatMarkdown(err.partialText)}<div style="color: var(--accent-red); font-size: 12px; margin-top: 10px;">⚠️ Connection ended ${recovery}: ${escapeHtml(err.message)}</div>`;
      } else {
        bodyEl.innerHTML = `<span style="color: var(--accent-red); font-family: var(--font-mono);">Error: ${escapeHtml(err.message)}</span>`;
      }
    }
  } finally {
    setLoading(false);
  }
  });
}

// Handle Non-Streaming
async function handleNonStreamRequest(payload, bodyEl) {
  const startTime = Date.now();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(payload),
    signal: currentAbortController?.signal,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Gateway error');
  }

  const durationMs = Date.now() - startTime;
  const content = data.choices?.[0]?.message?.content || '';
  bodyEl.innerHTML = formatMarkdown(content);
  conversationHistory.push({ role: 'assistant', content });

  if (isAutoTtsEnabled && content) {
    speakCleanText(content);
  }

  if (data.route_info?.cached) {
    const meta = bodyEl.parentElement?.querySelector('.message-meta');
    if (meta && !meta.querySelector('.cache-hit-pill')) {
      const pill = document.createElement('span');
      pill.className = 'cache-hit-pill';
      pill.innerHTML = '⚡ 0ms CACHE HIT';
      meta.appendChild(pill);
    }
  }

  let usage = data.usage;
  if (!usage || !usage.total_tokens) {
    const userPrompt = payload.messages?.[payload.messages.length - 1]?.content;
    const promptStr = typeof userPrompt === 'string' ? userPrompt : JSON.stringify(userPrompt || '');
    const promptTok = Math.max(1, Math.round(promptStr.length / 3.8));
    const compTok = Math.max(1, Math.round(content.length / 3.8));
    usage = {
      prompt_tokens: promptTok,
      completion_tokens: compTok,
      total_tokens: promptTok + compTok,
      estimated_cost_usd: usage?.estimated_cost_usd || 0.0,
    };
  }

  const routeInfo = data.route_info || {
    selected_model: payload.model,
    selected_provider: deriveProviderFromModel(payload.model),
    total_latency_ms: durationMs,
  };

  updateTelemetry(routeInfo, usage, durationMs);
}

function updateLiveRouteStatus(routeInfo) {
  if (!routeInfo || routeInfo.route_stage !== 'selected') return;
  if (kpiModel) kpiModel.textContent = routeInfo.selected_model || '-';
  if (kpiProvider) {
    const connection = routeInfo.selected_connection_label ? ` · ${routeInfo.selected_connection_label}` : '';
    kpiProvider.textContent = `${(routeInfo.selected_provider || '-').toUpperCase()}${connection}`;
  }
  if (kpiLatency) kpiLatency.textContent = 'Routing…';
  const led = document.getElementById('kpiModelLed');
  if (led) {
    led.className = 'activity-led standby';
    led.title = `Routing to ${routeInfo.selected_provider}/${routeInfo.selected_model}`;
  }
}

// Handle Streaming SSE
async function handleStreamRequest(payload, bodyEl) {
  const startTime = Date.now();
  let fullText = '';
  let finalRouteInfo = null;
  let finalUsage = null;
  const maxAttempts = 3;
  let completed = false;
  let retriesUsed = 0;

  for (let attempt = 0; attempt < maxAttempts && !completed; attempt++) {
    const retryingAfterPartial = attempt > 0 && fullText.length > 0;
    const attemptPayload = retryingAfterPartial
      ? {
          ...payload,
          enable_tools: false,
          tools: [],
          messages: [
            ...payload.messages,
            { role: 'assistant', content: fullText },
            {
              role: 'user',
              content: 'The previous response stream was interrupted. Continue exactly where it stopped. Do not repeat earlier text and do not repeat any tool or filesystem action.',
            },
          ],
        }
      : payload;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(attemptPayload),
        signal: currentAbortController?.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const httpError = new Error(errData.error?.message || `HTTP ${res.status}`);
        httpError.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        throw httpError;
      }
      if (!res.body) throw new Error('Streaming response had no readable body.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith(':')) {
            if (trimmed.startsWith(': nexus-route keepalive') && bodyEl && !fullText && finalRouteInfo) {
              const provider = escapeHtml((finalRouteInfo.selected_provider || 'provider').toUpperCase());
              const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
              bodyEl.innerHTML = `<span style="color: var(--text-muted); font-size: 13px;">⚡ ${provider} is still working… ${elapsed}s</span>`;
            }
            continue;
          }
          if (trimmed === 'data: [DONE]') {
            sawDone = true;
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let chunk;
          try {
            chunk = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (chunk.error) {
            const streamError = new Error(chunk.error.message || 'Stream error occurred');
            streamError.retryable = chunk.error.retryable !== false;
            throw streamError;
          }

          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            if (bodyEl) bodyEl.innerHTML = formatMarkdown(fullText);
            chatMessages.scrollTop = chatMessages.scrollHeight;

            const liveCompTok = Math.max(1, Math.round(fullText.length / 3.8));
            const livePromptTok = Math.max(1, Math.round(JSON.stringify(payload.messages).length / 3.8));
            const liveTot = livePromptTok + liveCompTok;
            const liveDurSec = Math.max(0.1, (Date.now() - startTime) / 1000);
            const liveSpeed = (liveCompTok / liveDurSec).toFixed(1);
            if (kpiTokens) kpiTokens.textContent = `${liveTot.toLocaleString()} tok`;
            if (kpiTokenBreakdown) kpiTokenBreakdown.textContent = `P: ${livePromptTok} | C: ${liveCompTok} (⚡ ${liveSpeed} tok/s)`;
          }

          if (chunk.route_info) {
            finalRouteInfo = chunk.route_info;
            updateLiveRouteStatus(chunk.route_info);
            if (bodyEl && !fullText && chunk.route_info.route_stage === 'selected') {
              const provider = escapeHtml((chunk.route_info.selected_provider || 'provider').toUpperCase());
              const model = escapeHtml(chunk.route_info.selected_model || payload.model || 'model');
              const failedAttempts = (chunk.route_info.attempts || []).filter(item => item.status === 'failed');
              const prefix = failedAttempts.length > 0 ? '↪ Continuing with fallback' : '⚡ Connected';
              bodyEl.innerHTML = `<span style="color: var(--text-muted); font-size: 13px;">${prefix}: ${provider} · ${model}</span>`;
            }
          }
          if (chunk.usage) finalUsage = chunk.usage;
        }
      }

      if (!sawDone) {
        const incompleteError = new Error('Connection closed before NexusRoute received the stream completion marker.');
        incompleteError.retryable = true;
        throw incompleteError;
      }
      completed = true;
    } catch (err) {
      if (err.name === 'AbortError') {
        err.partialText = fullText;
        throw err;
      }

      // Previously this defaulted to retrying (retryable !== false), so any
      // error that carried no explicit verdict - including ones no amount of
      // retrying could fix - re-ran the whole request, and each re-run drove a
      // fresh server-side cascade at full prompt cost. Retry is now opt-in.
      // A fetch-level TypeError is the one case we classify here: it means the
      // transport dropped, which a retry genuinely can recover.
      if (err.retryable === undefined && err instanceof TypeError) err.retryable = true;
      const canRetry = err.retryable === true && attempt < maxAttempts - 1;
      if (!canRetry) {
        err.partialText = fullText;
        err.retriesUsed = retriesUsed;
        if (fullText) conversationHistory.push({ role: 'assistant', content: fullText });
        throw err;
      }

      retriesUsed = attempt + 1;
      if (bodyEl) {
        bodyEl.innerHTML = `${formatMarkdown(fullText)}<div style="color: var(--accent-cyan); font-size: 12px; margin-top: 8px;">↻ Connection interrupted—reconnecting (${attempt + 1}/${maxAttempts - 1})…</div>`;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  const durationMs = Date.now() - startTime;
  conversationHistory.push({ role: 'assistant', content: fullText });

  if (isAutoTtsEnabled && fullText) {
    speakCleanText(fullText);
  }

  if (finalRouteInfo?.cached) {
    const meta = bodyEl.parentElement?.querySelector('.message-meta');
    if (meta && !meta.querySelector('.cache-hit-pill')) {
      const pill = document.createElement('span');
      pill.className = 'cache-hit-pill';
      pill.innerHTML = '⚡ 0ms CACHE HIT';
      meta.appendChild(pill);
    }
  }

  if (!finalUsage || !finalUsage.total_tokens) {
    const userPrompt = payload.messages?.[payload.messages.length - 1]?.content;
    const promptStr = typeof userPrompt === 'string' ? userPrompt : JSON.stringify(userPrompt || '');
    const promptTok = Math.max(1, Math.round(promptStr.length / 3.8));
    const compTok = Math.max(1, Math.round(fullText.length / 3.8));
    finalUsage = {
      prompt_tokens: promptTok,
      completion_tokens: compTok,
      total_tokens: promptTok + compTok,
      estimated_cost_usd: 0.0,
    };
  }

  const routeInfo = finalRouteInfo || {
    selected_model: payload.model,
    selected_provider: deriveProviderFromModel(payload.model),
    total_latency_ms: durationMs,
  };

  updateTelemetry(routeInfo, finalUsage, durationMs);
}

// Update Telemetry & Route Waterfall
function updateTelemetry(routeInfo, usage, durationMs = 0) {
  if (!routeInfo && !usage) return;

  if (Array.isArray(routeInfo?.files_written) && routeInfo.files_written.length > 0) {
    activeFileTargets = routeInfo.files_written
      .map(file => file?.filename || file?.full_path)
      .filter(Boolean)
      .slice(-10);
  }

  if (kpiModel && routeInfo) kpiModel.textContent = routeInfo.selected_model || '-';
  if (kpiProvider && routeInfo) {
    const connection = routeInfo.selected_connection_label ? ` · ${routeInfo.selected_connection_label}` : '';
    kpiProvider.textContent = `${(routeInfo.selected_provider || '-').toUpperCase()}${connection}`;
  }

  const kpiModelLed = document.getElementById('kpiModelLed');
  if (kpiModelLed) {
    // selected_model is set the moment a candidate is picked, so testing it
    // reported success for routes that went on to fail every attempt. Success
    // means an attempt actually succeeded, or the answer came from cache.
    const ledAttempts = Array.isArray(routeInfo?.attempts) ? routeInfo.attempts : [];
    const isSuccess = !!routeInfo?.cached
      || ledAttempts.some(a => a.status === 'success')
      || (ledAttempts.length === 0 && routeInfo?.route_stage === 'completed');
    kpiModelLed.className = `activity-led ${isSuccess ? 'connected' : 'error'}`;
    kpiModelLed.title = isSuccess ? `Model Connected: ${routeInfo.selected_model}` : 'Model Disconnected / Failed';
  }
  
  const latency = routeInfo?.total_latency_ms || durationMs || 0;
  if (kpiLatency) {
    if (routeInfo?.cached) {
      kpiLatency.innerHTML = '<span style="color: #c084fc;">⚡ 0ms (Cache)</span>';
    } else {
      kpiLatency.textContent = `${latency}ms`;
    }
  }

  const cost = Number(usage?.estimated_cost_usd ?? usage?.cost ?? 0) || 0;
  lastReportedCostUsd = cost;
  lastRequestCacheSavingsUsd = Number(usage?.cache_savings_usd || 0) || 0;
  lastRequestCachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens || 0) || 0;
  lastRequestCacheDiscountUsd = Number(usage?.cache_discount || 0) || 0;
  lastRequestCostSource = usage?.cost_source || (usage?.cost !== undefined ? 'provider' : 'estimated');
  if (kpiCost) kpiCost.textContent = formatCurrency(cost, 6);
  updateRequestCostDetails();

  // Live Token Meter Calculation & Session Usage
  if (usage) {
    const promptTok = usage.prompt_tokens || 0;
    const compTok = usage.completion_tokens || 0;
    const totTok = usage.total_tokens || (promptTok + compTok);

    if (totTok > 0) {
      sessionTotalTokens += totTok;
      sessionTotalCost += cost;

      const durSec = (latency > 0 ? latency : 1000) / 1000;
      const speed = durSec > 0 && compTok > 0 ? (compTok / durSec).toFixed(1) : (totTok / durSec).toFixed(1);

      if (kpiTokens) kpiTokens.textContent = `${totTok.toLocaleString()} tok`;
      const cacheHitRate = promptTok > 0 ? Math.round((lastRequestCachedTokens / promptTok) * 100) : 0;
      const cacheTokens = lastRequestCachedTokens > 0
        ? ` · ♻ ${lastRequestCachedTokens.toLocaleString()} cached (${cacheHitRate}%)`
        : '';
      if (kpiTokenBreakdown) kpiTokenBreakdown.textContent = `P: ${promptTok} | C: ${compTok} (⚡ ${speed} tok/s)${cacheTokens}`;
      if (kpiSessionTokens) kpiSessionTokens.textContent = `${sessionTotalTokens.toLocaleString()} tok`;
      if (kpiSessionCost) kpiSessionCost.textContent = `Total Cost: ${formatCurrency(sessionTotalCost, 5)}`;
    }
  }

  // Also refresh GPU stats after prompt execution
  loadGpuStatus();

  // Classifier Banner
  const cls = routeInfo.classification;
  if (cls) {
    if (intentCategory) intentCategory.textContent = `🎯 ${cls.category}`;
    if (complexityPill) complexityPill.textContent = `Complexity: ${(cls.complexityScore * 100).toFixed(0)}%`;
    if (classifierDesc) classifierDesc.textContent = `${cls.paretoExplanation} Recommended tier: [${cls.recommendedTier}].`;
  }

  // Waterfall Log
  if (waterfallList) {
    waterfallList.innerHTML = '';
    const attempts = routeInfo.attempts || [];
    if (attemptsBadge) attemptsBadge.textContent = `${attempts.length} ${attempts.length === 1 ? 'Attempt' : 'Attempts'}`;

    if (routeInfo.cached) {
      const item = document.createElement('div');
      item.className = 'waterfall-item success';
      item.innerHTML = `
        <div class="waterfall-row">
          <div class="attempt-name">
            <span class="activity-led connected"></span>
            <strong>Response Cache</strong>
            <span class="model-badge" style="background: rgba(168,85,247,0.2); color: #c084fc;">LRU Memory Cache</span>
          </div>
          <div class="attempt-meta">
            <span class="latency-tag">0ms</span>
            <span class="attempt-status-tag success">CACHE HIT</span>
          </div>
        </div>
      `;
      waterfallList.appendChild(item);
    }

    if (Array.isArray(routeInfo.decision_reasons) && routeInfo.decision_reasons.length > 0) {
      const decisionItem = document.createElement('div');
      decisionItem.className = 'waterfall-item decision';
      decisionItem.innerHTML = `
        <div class="waterfall-row">
          <div class="attempt-name"><span class="status-indicator">🧭</span><strong>Routing decision</strong></div>
          <div class="attempt-meta"><span class="attempt-status-tag">EXPLAINED</span></div>
        </div>
        <div class="attempt-error decision-reasons">${routeInfo.decision_reasons.map(reason => escapeHtml(reason)).join(' · ')}</div>`;
      waterfallList.appendChild(decisionItem);
    }

    attempts.forEach((att, idx) => {
      const item = document.createElement('div');
      item.className = `waterfall-item ${att.status}`;

      const ledClass = att.status === 'success' ? 'connected' : 'error';
      item.innerHTML = `
        <div class="waterfall-row">
          <div class="attempt-name">
            <span class="activity-led ${ledClass}"></span>
            <strong>#${idx + 1} ${att.provider.toUpperCase()}</strong>
            <span class="model-badge">${att.model}</span>
            ${att.connection_label ? `<span class="model-badge connection-badge">${escapeHtml(att.connection_label)}</span>` : ''}
          </div>
          <div class="attempt-meta">
            <span class="latency-tag">${att.latency_ms}ms</span>
            <span class="attempt-status-tag ${att.status}">${att.status.toUpperCase()}</span>
          </div>
        </div>
        ${att.error ? `<div class="attempt-error">${escapeHtml(att.error)}</div>` : ''}
      `;
      waterfallList.appendChild(item);
    });

    if (routeInfo.compression?.saved_chars > 0) {
      const compression = routeInfo.compression;
      const charsSaved = compression.saved_chars || 0;
      const rawIds = compression.raw_ids || [];
      const compressionItem = document.createElement('div');
      compressionItem.className = 'waterfall-item success';
      compressionItem.innerHTML = `
        <div class="waterfall-row">
          <div class="attempt-name"><span class="status-indicator">🗜️</span><strong>Recoverable context compression</strong></div>
          <div class="attempt-meta"><span class="attempt-status-tag success">${Number(charsSaved).toLocaleString()} CHARS SAVED</span></div>
        </div>
        <div class="attempt-error">Original tool output retained locally${rawIds.length ? ` as ${rawIds.map(id => `<code>${escapeHtml(id)}</code>`).join(', ')}` : ''}.</div>`;
      waterfallList.appendChild(compressionItem);
    }

    if (routeInfo.tools_executed && routeInfo.tools_executed.length > 0) {
      const toolItem = document.createElement('div');
      toolItem.className = 'waterfall-item success';
      toolItem.innerHTML = `
        <div class="waterfall-row">
          <div class="attempt-name">
            <span class="status-indicator">🛠️</span>
            <strong>Tools Executed</strong>
            <span class="model-badge" style="background: rgba(16,185,129,0.2); color: var(--accent-green);">${routeInfo.tools_executed.join(', ')}</span>
          </div>
          <div class="attempt-meta">
            <span class="attempt-status-tag success">MULTI-TURN SYNTHESIZED</span>
          </div>
        </div>
      `;
      waterfallList.appendChild(toolItem);
    }
  }

  loadRouteHistory();
  loadFreeCapacity();
}

// UI Helpers
function appendMessage(role, text, modelTag = null) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const isAssistant = role === 'assistant';
  const actionsHtml = isAssistant
    ? `<div style="display: flex; gap: 4px; margin-left: auto;">
        <button class="msg-action-btn tts-btn" title="Read Aloud (Voice)">🔊</button>
        <button class="msg-action-btn copy-msg-btn" title="Copy Text">📋</button>
      </div>`
    : '';

  msgDiv.innerHTML = `
    <div class="message-meta" style="display: flex; align-items: center;">
      <span class="sender-tag">${role === 'user' ? 'You' : (modelTag || 'Assistant')}</span>
      <span class="time-tag">${now}</span>
      ${actionsHtml}
    </div>
    <div class="message-body">${formatMarkdown(text)}</div>
  `;

  if (isAssistant) {
    const ttsBtn = msgDiv.querySelector('.tts-btn');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', () => {
        const bodyText = msgDiv.querySelector('.message-body')?.innerText || '';
        if (window.speechSynthesis && window.speechSynthesis.speaking) {
          window.speechSynthesis.cancel();
        } else {
          speakCleanText(bodyText);
        }
      });
    }
    const copyBtn = msgDiv.querySelector('.copy-msg-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const bodyText = msgDiv.querySelector('.message-body')?.innerText || '';
        navigator.clipboard.writeText(bodyText);
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
      });
    }
  }

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msgDiv;
}

function setLoading(isLoading) {
  promptInput.disabled = isLoading;
  if (isLoading) {
    sendBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');
  } else {
    sendBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    currentAbortController = null;
  }
}

function formatMarkdown(str) {
  if (!str) return '';

  // Clean LaTeX math delimiters
  let text = str
    .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\cdot/g, '·');

  let escaped = escapeHtml(text);

  // Deep Reasoning & Thinking Accordeon: <think>...</think>
  escaped = escaped.replace(/&lt;think&gt;([\s\S]*?)&lt;\/think&gt;/gi, (_, thought) => {
    return `<details class="thought-box" style="margin: 8px 0; padding: 8px 12px; background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
      <summary style="cursor: pointer; font-weight: 600; color: #c084fc; user-select: none;">🧠 Deep Reasoning & Chain of Thought (Click to Expand)</summary>
      <div style="margin-top: 8px; line-height: 1.5; white-space: pre-wrap; font-family: monospace; opacity: 0.9;">${thought.trim()}</div>
    </details>`;
  });

  // Active streaming think box (when <think> has started but </think> is not yet received)
  escaped = escaped.replace(/&lt;think&gt;([\s\S]*)$/gi, (_, thought) => {
    return `<details open class="thought-box" style="margin: 8px 0; padding: 8px 12px; background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
      <summary style="cursor: pointer; font-weight: 600; color: #c084fc; user-select: none;">🧠 Deep Reasoning in progress...</summary>
      <div style="margin-top: 8px; line-height: 1.5; white-space: pre-wrap; font-family: monospace; opacity: 0.9;">${thought.trim()}</div>
    </details>`;
  });

  // Code blocks
  escaped = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });
  // Markdown images: ![alt](url)
  escaped = escaped.replace(/!\[(.*?)\]\((.*?)\)/g, (_, alt, src) => {
    let cleanSrc = src.replace(/&amp;/g, '&').trim();
    if (cleanSrc.startsWith('http://') || cleanSrc.startsWith('https://')) {
      cleanSrc = `/v1/image-proxy?url=${encodeURIComponent(cleanSrc)}`;
    }
    const shortAlt = (alt || 'Generated Artwork').replace(/"/g, '&quot;');
    return `<div class="generated-art-card" style="margin: 12px 0; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); padding: 10px; border-radius: 12px; display: inline-block; max-width: 100%;">
      <div style="position: relative; min-height: 180px; background: rgba(0,0,0,0.3); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center;">
        <img src="${cleanSrc}" alt="${shortAlt}" style="max-width: 100%; max-height: 520px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.6); display: block; object-fit: contain;" onerror="let r = parseInt(this.dataset.retries || '0'); if (r < 5) { this.dataset.retries = r + 1; setTimeout(() => { this.src = '${cleanSrc}' + (cleanSrc.includes('?') ? '&' : '?') + 't=' + Date.now(); }, 1200); }">
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 12px; white-space: nowrap;">
        <span style="color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; max-width: 340px; white-space: nowrap;">🎨 ${shortAlt}</span>
        <div style="display: flex; gap: 6px; align-items: center; white-space: nowrap; flex-shrink: 0;">
          <a href="${cleanSrc}" download title="Download Artwork" class="action-tag-btn" style="text-decoration:none; padding: 4px 10px; font-size: 14px; font-weight: bold; white-space: nowrap;">⬇️</a>
          <a href="${cleanSrc}" target="_blank" title="Open Full Resolution in New Tab" class="action-tag-btn" style="text-decoration:none; padding: 4px 10px; font-size: 14px; white-space: nowrap;">🔍</a>
        </div>
      </div>
    </div>`;
  });
  // Markdown links: [text](url)
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    let cleanHref = href.replace(/&amp;/g, '&').trim();
    let isHtmlApp = cleanHref.endsWith('.html') || cleanHref.endsWith('.htm') || cleanHref.includes('.html');
    
    let target = cleanHref;
    if (cleanHref.startsWith('file:///')) {
      const stripped = decodeURIComponent(cleanHref.replace(/^file:\/\/\/?/, ''));
      const match = stripped.match(/workspace[/\\](.+)$/i) || stripped.match(/([^/\\]+\.html)$/i);
      if (match) {
        target = `/v1/workspace/files/${encodeURIComponent(match[1].replace(/\\/g, '/'))}`;
      } else {
        const base = stripped.split(/[/\\]/).pop() || '';
        target = `/v1/workspace/files/${encodeURIComponent(base)}`;
      }
    } else if (cleanHref.startsWith('http://') || cleanHref.startsWith('https://') || cleanHref.startsWith('/v1/')) {
      target = cleanHref;
    } else {
      const rel = cleanHref.replace(/^[/\\]+/, '');
      target = `/v1/workspace/files/${encodeURIComponent(rel.replace(/\\/g, '/'))}`;
    }
    
    if (isHtmlApp) {
      return `<a href="${target}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; background: linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(37, 99, 235, 0.25)); border: 1px solid rgba(56, 189, 248, 0.5); border-radius: 8px; color: #38bdf8; font-weight: 700; font-size: 12px; text-decoration: none; margin: 4px 0; cursor: pointer; transition: all 0.15s ease;">🚀 ${label} <span style="font-size: 10px; opacity: 0.85; font-weight: 500;">(Launch Web App)</span></a>`;
    }
    return `<a href="${target}" target="_blank" rel="noopener noreferrer" style="color: var(--accent-cyan); text-decoration: underline;">${label}</a>`;
  });

  // Auto-detect raw file:/// paths ending in .html
  escaped = escaped.replace(/(?<!["'=/\w])file:\/\/\/?([^\s<>"']+?\.html)(?!["'=/\w])/gi, (_, filePath) => {
    const cleanPath = decodeURIComponent(filePath);
    const match = cleanPath.match(/workspace[/\\](.+)$/i) || cleanPath.match(/([^/\\]+\.html)$/i);
    const fname = match ? match[1].replace(/\\/g, '/') : (cleanPath.split(/[/\\]/).pop() || cleanPath);
    return `<a href="/v1/workspace/files/${encodeURIComponent(fname)}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; background: linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(37, 99, 235, 0.25)); border: 1px solid rgba(56, 189, 248, 0.5); border-radius: 8px; color: #38bdf8; font-weight: 700; font-size: 12px; text-decoration: none; margin: 4px 0;">🚀 ${fname} <span style="font-size: 10px; opacity: 0.85; font-weight: 500;">(Launch Web App)</span></a>`;
  });

  // Inline code
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italics
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Line breaks
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Fullscreen Toggle
const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
if (toggleFullscreenBtn) {
  toggleFullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      document.getElementById('fullscreenIcon').textContent = '🗗';
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
        document.getElementById('fullscreenIcon').textContent = '⛶';
      }
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      document.body.classList.add('fullscreen-mode');
      const icon = document.getElementById('fullscreenIcon');
      if (icon) icon.textContent = '🗗';
    } else {
      document.body.classList.remove('fullscreen-mode');
      const icon = document.getElementById('fullscreenIcon');
      if (icon) icon.textContent = '⛶';
    }
  });
}

// Export Chat to Markdown
const exportChatBtn = document.getElementById('exportChatBtn');
if (exportChatBtn) {
  exportChatBtn.addEventListener('click', () => {
    if (conversationHistory.length === 0) {
      alert('No messages in current conversation to export.');
      return;
    }

    let md = `# NexusRoute Chat Export\n*Generated on: ${new Date().toLocaleString()}*\n\n---\n\n`;
    for (const msg of conversationHistory) {
      const roleName = msg.role === 'user' ? 'User' : 'Assistant (NexusRoute)';
      let textContent = '';
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        textContent = msg.content.map(c => ('text' in c ? c.text : '[Attached Image]')).join('\n');
      }
      md += `### 👤 ${roleName}\n\n${textContent}\n\n---\n\n`;
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexusroute_chat_${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

init();
