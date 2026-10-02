import { describe, expect, it } from 'vitest';
import { LocalGpuArtEngine } from '../src/engine/gpu-art.js';
import fs from 'fs';

describe('NVIDIA DLSS 5 Integration', () => {
  it('should locate the bridge script', () => {
    const bridgePath = LocalGpuArtEngine.getDlssBridgePath();
    expect(fs.existsSync(bridgePath)).toBe(true);
  });

  it('should report DLSS 5 runtime status on NVIDIA RTX GPU', async () => {
    const status = await LocalGpuArtEngine.getDlssStatus();
    expect(status).toBeDefined();
    expect(status.available).toBe(true);
    expect(status.gpu).toBeDefined();
    expect(status.gpu.name).toContain('RTX');
    expect(status.runtime_dir).toContain('dlss5_runtime');
  });
});
