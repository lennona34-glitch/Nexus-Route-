// scripts/test_stems_api.cjs
// Tests the 4-Stem DAW extraction endpoint & streaming delivery in Nexus Route
const assert = require('assert');

async function run() {
  console.log('--- Testing 4-Stem DAW API & Streaming ---');

  // 1. Check Library API
  const libResp = await fetch('http://127.0.0.1:3000/v1/studio/audio/library');
  assert.strictEqual(libResp.status, 200, 'Audio library endpoint should return 200');
  const libData = await libResp.json();
  assert(libData.success, 'Audio library response should have success: true');
  assert(Array.isArray(libData.tracks), 'Audio library should return tracks array');
  console.log(`✅ Audio library returned ${libData.tracks.length} tracks`);

  // Find track with stems
  const stemTrack = libData.tracks.find(t => t.fileName.includes('yue2_80s_synthwave___dark_cyberpunk_1791117304'));
  assert(stemTrack, 'Test track yue2_80s_synthwave___dark_cyberpunk_1791117304 should exist');
  assert(stemTrack.stems, 'Test track should have stems metadata populated');
  console.log('✅ Stems metadata detected on track:', stemTrack.fileName);

  // 2. Test Stem Audio Streaming (Vocals)
  const vocalsUrl = `http://127.0.0.1:3000/v1/studio/audio/stream?file=${encodeURIComponent('stems/yue2_80s_synthwave___dark_cyberpunk_1791117304/yue2_80s_synthwave___dark_cyberpunk_1791117304_Stem_Vocals.wav')}`;
  const streamResp = await fetch(vocalsUrl);
  assert.strictEqual(streamResp.status, 200, 'Stem audio stream should return 200');
  assert.strictEqual(streamResp.headers.get('content-type'), 'audio/wav', 'Content-Type should be audio/wav');
  const buf = await streamResp.arrayBuffer();
  assert(buf.byteLength > 1000000, `Stem audio size should be > 1MB (got ${buf.byteLength})`);
  console.log(`✅ Stem Vocals audio streamed successfully (${(buf.byteLength / (1024 * 1024)).toFixed(2)} MB)`);

  // 3. Test DAW ZIP Stream & Download
  const zipUrl = `http://127.0.0.1:3000/v1/studio/audio/stream?file=${encodeURIComponent('stems/yue2_80s_synthwave___dark_cyberpunk_1791117304/yue2_80s_synthwave___dark_cyberpunk_1791117304_DAW_Stems.zip')}`;
  const zipResp = await fetch(zipUrl);
  assert.strictEqual(zipResp.status, 200, 'DAW zip stream should return 200');
  assert.strictEqual(zipResp.headers.get('content-type'), 'application/zip', 'Content-Type should be application/zip');
  const zipBuf = await zipResp.arrayBuffer();
  assert(zipBuf.byteLength > 1000000, `DAW zip size should be > 1MB (got ${zipBuf.byteLength})`);
  console.log(`✅ DAW ZIP archive streamed successfully (${(zipBuf.byteLength / (1024 * 1024)).toFixed(2)} MB)`);

  // 4. Test Extraction Endpoint validation (missing fileName)
  const badResp = await fetch('http://127.0.0.1:3000/v1/studio/audio/stems/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(badResp.status, 400, 'Missing fileName should return 400');
  console.log('✅ Validation correctly rejected missing fileName with 400');

  console.log('--- All 4-Stem API & Streaming Tests Passed! ---');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
