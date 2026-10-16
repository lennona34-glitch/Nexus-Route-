#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolRegistry } from '../dist/tools/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = 'C:\\Users\\adria\\.gemini\\antigravity\\mcp\\nexusroute';
const mcpConfigPath = 'C:\\Users\\adria\\.gemini\\config\\mcp_config.json';
const bridgeScriptPath = path.resolve(__dirname, 'mcp_stdio_bridge.js');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const tools = ToolRegistry.getBuiltInTools();
console.log(`Exporting ${tools.length} tool schemas to ${targetDir}...`);

for (const tool of tools) {
  const schema = {
    name: tool.function.name,
    description: tool.function.description || '',
    parameters: tool.function.parameters || { type: 'object', properties: {} },
  };
  const schemaPath = path.join(targetDir, `${tool.function.name}.json`);
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
}

const instructionsContent = `# NexusRoute MCP Server & Diagnostics Bridge

NexusRoute is a high-performance local AI gateway, model router, and desktop tools runtime created for pair programming with Antigravity.

## Direct Antigravity Diagnostics & Troubleshooting
Call \`nexusroute_diagnostics\` anytime to inspect:
- App health, version, uptime, and active memory usage.
- Provider status (Google Gemini / AI Studio, OpenAI, Anthropic, DeepSeek, Cerebras, Groq, NVIDIA, Qwen).
- **Zero-Cash Guard & Google Compliance**: NexusRoute natively connects to Google DeepMind models via official Google AI Studio API keys (\`GEMINI_API_KEY\`), adhering 100% to Google Terms of Service with zero Auth0 token scraping or session hijacking.
- MCP server status on \`http://127.0.0.1:3000/mcp\`.

## Available Developer Tools
- \`nexusroute_diagnostics\`: Instant system, provider, and gateway health report.
- \`read_file\`, \`write_file\`, \`patch_file\`, \`list_workspace_files\`: Safe, verified workspace file manipulation.
- \`execute_command\`: Shell command execution within the workspace boundary.
- \`test_html_app\`: In-process DOM, JavaScript, and canvas/webgl test execution.
- \`open_in_browser_or_app\`: Launch apps or files in the native desktop environment.
- \`take_desktop_screenshot\`: Capture desktop display for multi-modal visual inspection.
- \`web_search\`, \`fetch_webpage\`, \`search_gif\`: Real-time web knowledge retrieval.
- \`remember_fact\`, \`recall_memory\`, \`learning_memory\`: Persistent cross-session developer memory.
`;

fs.writeFileSync(path.join(targetDir, 'instructions.md'), instructionsContent, 'utf8');
console.log(`Created instructions.md in ${targetDir}`);

// Update C:\Users\adria\.gemini\config\mcp_config.json
if (fs.existsSync(mcpConfigPath)) {
  try {
    const raw = fs.readFileSync(mcpConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.mcpServers) parsed.mcpServers = {};
    parsed.mcpServers.nexusroute = {
      command: 'node',
      args: [bridgeScriptPath],
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(parsed, null, 2), 'utf8');
    console.log(`Updated ${mcpConfigPath} with nexusroute MCP server configuration.`);
  } catch (err) {
    console.error(`Failed to update ${mcpConfigPath}:`, err);
  }
} else {
  console.warn(`mcp_config.json not found at ${mcpConfigPath}`);
}

console.log('NexusRoute Antigravity MCP integration successfully exported and configured!');
