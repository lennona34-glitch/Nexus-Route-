# Local Offline Model Workshop & Training Hub

## Custom Modelfiles — `modelfiles/`

All Modelfiles live in `modelfiles/`. They are inputs to `ollama create` only:
nothing in `src/` reads them, so editing one changes nothing until it is rebuilt.

```powershell
ollama create dolphin-roaster -f .\modelfiles\Modelfile.dolphin-roaster
ollama list
```

NexusRoute then reaches it as `local/dolphin-roaster:latest`.

| Modelfile | Base | Persona |
| --- | --- | --- |
| `Modelfile.dolphin-roaster` | dolphin-mistral:7b | Ultimate Universal Roast Master (has a ChatML `TEMPLATE` block) |
| `Modelfile.dolphin-drill-sergeant` | dolphin-mistral:7b | Cynical engineering drill sergeant |
| `Modelfile.dolphin-maverick` | dolphin-mistral:7b | — |
| `Modelfile.wizard-coder` | wizardlm2:7b | — |

### Two things that will catch you out

**Write them without a BOM.** PowerShell's `>` and `Set-Content` add a UTF-8
byte-order mark by default; Ollama reads it as part of the first command and
`ollama create` fails on an otherwise valid `FROM` line. Use
`Out-File -Encoding utf8NoBOM`, or an editor set to "UTF-8 without BOM".

**A Modelfile `SYSTEM` block only applies when tools are off.** With tools
enabled, `ensureAutonomousPrompt` in `src/router/engine.ts` sends its own system
message, which overrides the Modelfile's. Any model whose name contains
`dolphin` or `roaster` additionally gets NexusRoute's built-in Roast Master
prompt instead of the standard engineer one. Tune the Modelfile for tool-less
chat; tune `engine.ts` for agentic runs.

## Planned — not yet present

- QLoRA 4-bit trainer (RTX 4060): `workshop/trainer/`
- Abliteration tool: `workshop/abliterator/`
