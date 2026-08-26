export interface OllamaUnloadResult {
  success: boolean;
  unloadedModels: string[];
  remainingModels: string[];
  errors: string[];
}

interface OllamaProcess {
  name?: string;
  model?: string;
}

async function loadedOllamaModelNames(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/ps`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Ollama process query failed (${response.status})`);
  const payload = (await response.json()) as { models?: OllamaProcess[] };
  return (payload.models || [])
    .map(model => model.name || model.model || '')
    .filter((name): name is string => !!name);
}

export async function unloadOllamaModels(
  baseUrl = process.env.OLLAMA_BASE_URL?.replace(/\/v1\/?$/, '') || 'http://127.0.0.1:11434'
): Promise<OllamaUnloadResult> {
  const errors: string[] = [];
  let before: string[];
  try {
    before = await loadedOllamaModelNames(baseUrl);
  } catch (error: any) {
    return {
      success: false,
      unloadedModels: [],
      remainingModels: [],
      errors: [error?.message || String(error)],
    };
  }

  for (const model of before) {
    try {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0, stream: false }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        errors.push(`${model}: Ollama returned ${response.status}`);
      } else {
        await response.text();
      }
    } catch (error: any) {
      errors.push(`${model}: ${error?.message || String(error)}`);
    }
  }

  let remaining = before;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      remaining = await loadedOllamaModelNames(baseUrl);
    } catch (error: any) {
      errors.push(error?.message || String(error));
      break;
    }
    if (!before.some(model => remaining.includes(model))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  const unloaded = before.filter(model => !remaining.includes(model));
  const stillLoaded = before.filter(model => remaining.includes(model));
  return {
    success: stillLoaded.length === 0,
    unloadedModels: unloaded,
    remainingModels: stillLoaded,
    errors,
  };
}
