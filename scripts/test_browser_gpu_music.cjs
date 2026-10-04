const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ARTIFACT_DIR = 'C:\\Users\\adria\\.gemini\\antigravity\\brain\\dd52ccd5-773b-40b2-a2fd-3fb128f98c21';

async function runBrowserGpuMusicTest() {
  console.log('🧪 Starting Browser End-to-End Test for Native GPU Music Generator...');

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profileDir = path.join(os.tmpdir(), 'cdp_gpu_music_' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });

  const port = 9600 + Math.floor(Math.random() * 200);
  const edgeProc = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,900',
  ]);

  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          const data = await res.json();
          wsUrl = data.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }

    if (!wsUrl) throw new Error('Could not connect to Edge DevTools');
    console.log('Connected to Edge DevTools on port', port);

    const newPageRes = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('http://localhost:3000')}`, { method: 'PUT' });
    const target = await newPageRes.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
        function onMessage(e) {
          const data = JSON.parse(e.data);
          if (data.id === id) {
            ws.removeEventListener('message', onMessage);
            resolve(data.result);
          }
        }
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');

    // Wait for page load
    await new Promise(r => setTimeout(r, 2000));

    // Open Nexus Studio
    console.log('Opening Nexus Studio Modal...');
    await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.getElementById('navOpenStudioBtn') || document.getElementById('heroOpenStudioBtn');
        if (btn) btn.click();
        return true;
      })()`
    });
    await new Promise(r => setTimeout(r, 1000));

    // Inspect UI State
    const checkState = await send('Runtime.evaluate', {
      expression: `(() => {
        const modal = document.getElementById('nexusStudioModal');
        const gpuCard = document.getElementById('studioGpuMusicGenCard');
        const genBtn = document.getElementById('btnStudioGenerateMusic');
        const durationSelect = document.getElementById('studioMusicDurationSelect');
        const genreSelect = document.getElementById('studioGenreSelect');
        return {
          modalVisible: modal && !modal.classList.contains('hidden'),
          gpuCardExists: !!gpuCard,
          genBtnExists: !!genBtn,
          genBtnText: genBtn ? genBtn.innerText.trim() : null,
          genre: genreSelect ? genreSelect.value : null
        };
      })()`,
      returnByValue: true
    });
    console.log('Studio Initial State:', checkState.result?.value);

    // Capture initial UI screenshot showing the GPU Music Engine card
    const snap1 = await send('Page.captureScreenshot', { format: 'png' });
    const out1 = path.join(ARTIFACT_DIR, 'gpu_music_studio_ui_preview.png');
    fs.writeFileSync(out1, Buffer.from(snap1.data, 'base64'));
    console.log('Saved initial UI screenshot:', out1);

    // Trigger Generation (15s duration)
    console.log('Clicking "Generate Music on GPU (1-Click)" in UI...');
    await send('Runtime.evaluate', {
      expression: `(() => {
        const dur = document.getElementById('studioMusicDurationSelect');
        if (dur) dur.value = "15";
        const btn = document.getElementById('btnStudioGenerateMusic');
        if (btn) btn.click();
      })()`
    });

    // Check progress
    await new Promise(r => setTimeout(r, 1200));
    const progressState = await send('Runtime.evaluate', {
      expression: `(() => {
        const pBox = document.getElementById('studioMusicProgressBox');
        const stage = document.getElementById('studioMusicProgressStage');
        const pct = document.getElementById('studioMusicProgressPercent');
        return {
          pBoxDisplay: pBox ? pBox.style.display : null,
          stage: stage ? stage.textContent : null,
          percent: pct ? pct.textContent : null
        };
      })()`,
      returnByValue: true
    });
    console.log('Progress State:', progressState.result?.value);

    // Wait for completion (up to 60s)
    let completedTrack = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const resCheck = await send('Runtime.evaluate', {
        expression: `(() => {
          const rBox = document.getElementById('studioMusicResultBox');
          const title = document.getElementById('studioMusicResultTitle');
          const meta = document.getElementById('studioMusicResultMeta');
          const audio = document.getElementById('studioMusicAudioPlayer');
          return {
            visible: rBox && rBox.style.display !== 'none',
            title: title ? title.textContent : null,
            meta: meta ? meta.textContent : null,
            audioSrc: audio ? audio.src : null
          };
        })()`,
        returnByValue: true
      });
      if (resCheck.result?.value?.visible) {
        completedTrack = resCheck.result.value;
        console.log(`GPU Music Generation Completed in UI (${i+1}s)!`, completedTrack);
        break;
      }
    }

    if (!completedTrack) {
      throw new Error('GPU generation did not complete in UI within 60s');
    }

    // Capture completed result screenshot
    const snap2 = await send('Page.captureScreenshot', { format: 'png' });
    const sharedOut = path.resolve(__dirname, '..', 'shared', 'gpu_music_studio_generated_preview.png');
    const out2 = path.join(ARTIFACT_DIR, 'gpu_music_studio_generated_preview.png');
    fs.writeFileSync(sharedOut, Buffer.from(snap2.data, 'base64'));
    try { fs.writeFileSync(out2, Buffer.from(snap2.data, 'base64')); } catch {}
    console.log('Saved completed UI screenshot to:', sharedOut);

    ws.close();
    console.log('🎉 BROWSER END-TO-END TEST PASSED PERFECTLY!');
  } finally {
    edgeProc.kill();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

runBrowserGpuMusicTest().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
