const fs = require('fs');
const path = require('path');

let token = process.env.PROMPTFORGE_TOKEN;
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync('C:\\Users\\adria\\AppData\\Local\\PromptForgeRTX\\config.json', 'utf8'));
    token = cfg.api_token;
  } catch(e){}
}

console.log('Testing PromptForge with token found:', !!token);

async function test() {
  const t0 = Date.now();
  console.log('Submitting generation request to PromptForge...');
  const res = await fetch('http://127.0.0.1:17861/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'current',
      prompt: 'A clockwork mechanical owl with glowing amber eyes perched on a bookshelf in a moonlit Victorian library, 8k resolution, cinematic lighting, masterpiece',
      negative_prompt: 'blurry, low quality, text, watermark, logo, duplicate subjects, malformed anatomy, cropped',
      size: '1024x1024',
      quality: 'quality',
      steps: 28,
      guidance_scale: 6.0,
      seed: -1,
      n: 1,
      async: true
    })
  });

  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Job response:', data);
  const jobId = data.id || data.job_id;
  if (!jobId) throw new Error('No job ID returned: ' + JSON.stringify(data));

  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const jRes = await fetch('http://127.0.0.1:17861/v1/jobs/' + jobId, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const jData = await jRes.json();
    console.log('Job status:', jData.status, 'Progress:', jData.progress);
    if (jData.status === 'completed') {
      const imgUrl = jData.data?.[0]?.url;
      console.log('Fetching image from:', imgUrl);
      const imgRes = await fetch(imgUrl, { headers: { 'Authorization': 'Bearer ' + token } });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const out = path.resolve('workspace/art/test_promptforge_owl.png');
      fs.writeFileSync(out, buf);
      console.log('SUCCESS! Saved', buf.length, 'bytes to', out, 'in', (Date.now() - t0), 'ms');
      break;
    } else if (jData.status === 'failed' || jData.status === 'cancelled') {
      console.error('FAILED:', jData.error || jData.message);
      break;
    }
  }
}
test().catch(console.error);
