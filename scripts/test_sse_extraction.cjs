// scripts/test_sse_extraction.cjs
const assert = require('assert');

async function testSSE() {
  console.log('Testing SSE Stem Extraction on 909-drum-machine-loop.wav...');
  const resp = await fetch('http://127.0.0.1:3000/v1/studio/audio/stems/extract?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ fileName: '909-drum-machine-loop.wav' })
  });

  assert.strictEqual(resp.status, 200, 'SSE endpoint should return 200');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let progressCount = 0;
  let doneResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const msg = JSON.parse(line.slice(6));
        if (msg.type === 'progress') {
          progressCount++;
          console.log(`[Progress ${msg.percent}%] ${msg.stage} (ETA: ${msg.eta || 'N/A'})`);
        } else if (msg.type === 'done' || msg.success) {
          doneResult = msg;
          console.log('✅ [Done] Stems:', Object.keys(msg.stems || {}), 'ZIP:', msg.zipPath);
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }
  }

  assert(progressCount > 0, 'Should have received progress events');
  assert(doneResult, 'Should have received done result');
  assert(doneResult.stems.vocals, 'Should have vocals stem');
  assert(doneResult.stems.drums, 'Should have drums stem');
  assert(doneResult.stems.bass, 'Should have bass stem');
  assert(doneResult.stems.other, 'Should have other stem');
  console.log('✅ SSE Stem Extraction Completed Successfully!');
}

testSSE().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
