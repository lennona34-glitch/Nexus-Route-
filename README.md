# ⚡ NexusRoute: Clean AI Model Routing Gateway

A high-performance, modular, zero-bloat AI model routing gateway and observability proxy. Built in TypeScript & Fastify with drop-in OpenAI API compatibility.

---

## 🌟 Key Features

1. **Drop-in OpenAI Compatibility**: Works instantly with existing SDKs (`openai` Python/Node), Cursor, LangChain, or curl by setting base URL to `http://localhost:3000/v1`.
2. **First-Class Provider Adapters**:
   - **OpenAI & Azure** (`/v1/chat/completions`)
   - **Anthropic** (Messages API with system prompt & tool schema extraction)
   - **Google Gemini** (REST API with parts formatting & safety controls)
   - **xAI Grok** (OpenAI-compatible chat, vision, tool calling & live model catalogue)
   - **Local / Ollama / vLLM** (`http://localhost:11434/v1`)
   - **Realistic Mock Engine** (Zero-cost sandbox for instant testing and CI/CD)
3. **Resilient Automatic Failover**:
   - Circuit breakers catch 429 rate limits, 5xx outages, and timeouts in real-time.
   - Cascades automatically to backup models without dropping client connections.
4. **Interactive Live Inspector & Playground**:
   - Built-in Web UI at `http://localhost:3000` with real-time SSE streaming.
   - Routing waterfall inspector showing exact dispatch attempts, latencies, and token costs.
   - Chaos Simulator to test failovers live.

---

## 🚀 Quick Start

### 1. Start the Gateway
```bash
npm run dev
```
The gateway and web dashboard will be live at `http://localhost:3000`.

### 2. Test in the Web Playground
Open your browser to `http://localhost:3000` and send a test prompt!

### 3. Connect via Python OpenAI SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="none"  # Routed locally
)

response = client.chat.completions.create(
    model="auto",  # Or "fast", "reasoning", "coding"
    messages=[{"role": "user", "content": "Explain quantum computing briefly."}]
)

print(response.choices[0].message.content)
```

### 4. Connect via cURL
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello NexusRoute!"}],
    "stream": true
  }'
```

---

## ⚙️ Configuration & Live Keys

To enable live upstream providers, set environment variables:
```bash
$env:OPENAI_API_KEY="sk-..."
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:GEMINI_API_KEY="AIza..."
$env:XAI_API_KEY="<your xAI API key>"
```
Custom routes and virtual aliases can be modified anytime in [`config/routes.json`](file:///C:/Users/adria/.gemini/antigravity/scratch/nexus-route/config/routes.json).
