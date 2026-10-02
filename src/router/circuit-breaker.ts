export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  successCount: number;
}

export class CircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();
  private failureThreshold = 3;
  private cooldownMs = 15000;

  private getKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  isAvailable(provider: string, model: string): boolean {
    const key = this.getKey(provider, model);
    const entry = this.circuits.get(key);
    if (!entry) return true;

    if (entry.state === 'CLOSED') return true;

    if (entry.state === 'OPEN') {
      const now = Date.now();
      if (now - entry.lastFailureTime > this.cooldownMs) {
        entry.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }

    return true; // HALF_OPEN allows a trial request
  }

  recordSuccess(provider: string, model: string) {
    const key = this.getKey(provider, model);
    const entry = this.circuits.get(key);
    if (!entry) return;

    if (entry.state === 'HALF_OPEN') {
      entry.successCount++;
      if (entry.successCount >= 2) {
        entry.state = 'CLOSED';
        entry.failures = 0;
        entry.successCount = 0;
      }
    } else {
      entry.failures = Math.max(0, entry.failures - 1);
    }
  }

  recordFailure(provider: string, model: string) {
    const key = this.getKey(provider, model);
    let entry = this.circuits.get(key);
    if (!entry) {
      entry = { state: 'CLOSED', failures: 0, lastFailureTime: 0, successCount: 0 };
      this.circuits.set(key, entry);
    }

    entry.failures++;
    entry.lastFailureTime = Date.now();

    if (entry.failures >= this.failureThreshold || entry.state === 'HALF_OPEN') {
      entry.state = 'OPEN';
    }
  }

  getStatus() {
    const result: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [key, val] of this.circuits.entries()) {
      result[key] = { state: val.state, failures: val.failures };
    }
    return result;
  }

  resetCircuit(provider: string, model: string) {
    this.circuits.delete(this.getKey(provider, model));
  }

  reset() {
    this.circuits.clear();
  }
}
