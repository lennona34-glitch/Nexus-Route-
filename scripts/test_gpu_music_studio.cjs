const http = require('http');

async function testGpuMusicEndpoint() {
  console.log('Testing POST /v1/studio/music/generate...');
  const payload = JSON.stringify({
    genre: '80s Synthwave / Dark Cyberpunk',
    bpm: 124,
    key: 'E',
    scale: 'Minor',
    duration: 15,
    shareToLounge: true,
    altPrompt: 'Lead vocal: Male mid-range baritone. Genre: 80s Synthwave. Lead instruments: Analog Synthesizers, LinnDrum, tight driving bassline. Mood: Nostalgic, high-energy. Tempo: 124 BPM. Key: E Minor.',
  });

  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/studio/music/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const startTime = Date.now();
  const resData = await new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Response received in ${elapsedSec}s. Status: ${resData.status}`);
  console.log('Response body:', resData.body);

  if (resData.status !== 200 || !resData.body?.success) {
    throw new Error('GPU Music generation failed: ' + JSON.stringify(resData));
  }

  console.log('PASS: GPU Music generation succeeded!');
  console.log('Filename:', resData.body.filename);
  console.log('Stream URL:', resData.body.streamUrl);
  console.log('Engine:', resData.body.engine, '| Device:', resData.body.device);

  // Check Library
  console.log('\nChecking /v1/studio/audio/library...');
  const libRes = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:3000/v1/studio/audio/library', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  const found = libRes.tracks.find(t => t.fileName === resData.body.filename);
  if (!found) {
    throw new Error(`Generated track ${resData.body.filename} not found in library!`);
  }
  console.log(`PASS: Track found in studio library with title: "${found.title}", BPM: ${found.bpm}, Key: ${found.key}`);
}

testGpuMusicEndpoint().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
