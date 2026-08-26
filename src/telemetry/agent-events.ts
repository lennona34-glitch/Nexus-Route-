import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AgentEventStage =
  | 'request_started'
  | 'route_selected'
  | 'turn_started'
  | 'turn_completed'
  | 'tool_started'
  | 'tool_completed'
  | 'file_verified'
  | 'route_failed'
  | 'request_completed';

export interface AgentEvent {
  timestamp: number;
  requestId: string;
  sessionId?: string;
  stage: AgentEventStage;
  requestedModel?: string;
  provider?: string;
  model?: string;
  connectionLabel?: string;
  turn?: number;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  tool?: string;
  success?: boolean;
  filename?: string;
  bytesWritten?: number;
  error?: string;
  detail?: string;
}

export class AgentEventLog {
  private events: AgentEvent[] = [];
  private storagePath: string | null;
  private maxEvents: number;

  constructor(options: { storagePath?: string | null; maxEvents?: number } = {}) {
    this.storagePath = options.storagePath === undefined
      ? path.join(__dirname, '../../logs/agent-events.jsonl')
      : options.storagePath;
    this.maxEvents = options.maxEvents || 2_000;
    this.load();
  }

  private load(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    try {
      const lines = fs.readFileSync(this.storagePath, 'utf8').split(/\r?\n/).filter(Boolean);
      this.events = lines.slice(-this.maxEvents).map(line => JSON.parse(line) as AgentEvent);
    } catch {
      this.events = [];
    }
  }

  record(event: Omit<AgentEvent, 'timestamp'>): AgentEvent {
    const complete: AgentEvent = {
      ...event,
      timestamp: Date.now(),
      ...(event.error ? { error: event.error.replace(/[\r\n]+/g, ' ').slice(0, 1_000) } : {}),
    };
    this.events.push(complete);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    if (this.storagePath) {
      try {
        fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
        fs.appendFileSync(this.storagePath, `${JSON.stringify(complete)}\n`, 'utf8');
      } catch {}
    }
    return complete;
  }

  list(limit = 100): AgentEvent[] {
    return this.events.slice(-Math.max(1, Math.min(limit, this.maxEvents))).reverse();
  }
}
