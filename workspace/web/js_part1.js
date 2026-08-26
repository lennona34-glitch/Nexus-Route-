<script>
// ============================================================
// NEON SPACE INVADERS // BLOOM PROTOCOL
// Single-file standalone. Canvas 2D with additive glow bloom.
// Procedural labyrinth maze, patrol AI, boss battles.
// Web Audio chiptune laser synths + noise explosion envelopes.
// ============================================================

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

// ---- RESIZE ----
let W, H, DPR;
function resize(){
  DPR = Math.min(window.devicePixelRatio||1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W+'px';
  canvas.style.height = H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
  initStars();
  if(state.running) generateMaze();
}
window.addEventListener('resize', resize);
resize();

// ============================================================
// AUDIO ENGINE - Procedural Web Audio
// ============================================================
class AudioEngine {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.engineHum = null;
  }
  init(){
    if(this.ctx) { this.resume(); return; }
    this.ctx = new (window.AudioContext||window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 8;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
  }
  resume(){ if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); }

  laser(freq, dur, vol){
    if(!this.ctx) return;
    freq = freq||1200; dur = dur||0.18; vol = vol||0.4;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type='square'; osc2.type='sawtooth';
    osc.frequency.setValueAtTime(freq*1.5, t);
    osc.frequency.exponentialRampToValueAtTime(freq*0.35, t+dur);
    osc2.frequency.setValueAtTime(freq*0.75, t);
    osc2.frequency.exponentialRampToValueAtTime(freq*0.2, t+dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t+dur);
    osc.connect(g); osc2.connect(g);
    g.connect(this.master);
    osc.start(t); osc2.start(t);
    osc.stop(t+dur); osc2.stop(t+dur);
  }
  enemyLaser(freq, dur, vol){
    if(!this.ctx) return;
    freq = freq||400; dur = dur||0.15; vol = vol||0.25;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type='sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq*0.5, t+dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t+dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t+dur);
  }
  explosion(size){
    if(!this.ctx) return;
    size = size||1;
    const t = this.ctx.currentTime;
    const dur = 0.4 * Math.max(0.4,size);
    const bufferSize = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i=0;i<bufferSize;i++){
      const env = Math.pow(1-i/bufferSize, 2);
      data[i] = (Math.random()*2-1) * env;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type='lowpass';
    filter.frequency.setValueAtTime(3000*size, t);
    filter.frequency.exponentialRampToValueAtTime(80, t+dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.7*Math.min(size,1.5), t);
    g.gain.exponentialRampToValueAtTime(0.001, t+dur);
    noise.connect(filter); filter.connect(g); g.connect(this.master);
    noise.start(t);
    const osc = this.ctx.createOscillator();
    osc.type='sine';
    osc.frequency.setValueAtTime(120*size, t);
    osc.frequency.exponentialRampToValueAtTime(30, t+dur);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.8, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t+dur);
    osc.connect(g2); g2.connect(this.master);
    osc.start(t); osc.stop(t+dur);
  }
  powerup(){
    if(!this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach(function(f,i){
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type='triangle';
      osc.frequency.value = f;
      const st = t + i*0.06;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.3, st+0.02);
      g.gain.exponentialRampToValueAtTime(0.001, st+0.25);
      osc.connect(g); g.connect(this.master);
      osc.start(st); osc.stop(st+0.3);
    }.bind(this));
  }
  bossHorn(){
    if(!this.ctx) return;
    const t = this.ctx.currentTime;
    [110, 165, 220].forEach(function(f,i){
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type='sawtooth';
      osc.frequency.value = f;
      const st = t + i*0.08;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(0.4, st+0.3);
      g.gain.linearRampToValueAtTime(0.001, st+1.2);
      osc.connect(g); g.connect(this.master);
      osc.start(st); osc.stop(st+1.3);
    }.bind(this));
  }
  startEngineHum(){
    if(!this.ctx || this.engineHum) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type='sawtooth';
    osc2.type='triangle';
    osc.frequency.value = 55;
    osc2.frequency.value = 82.5;
    g.gain.value = 0.04;
    osc.connect(g); osc2.connect(g); g.connect(this.master);
    osc.start(); osc2.start();
    this.engineHum = {osc:osc, osc2:osc2, g:g};
  }
  setEnginePitch(ratio){
    if(!this.engineHum) return;
    const base = 55 * ratio;
    this.engineHum.osc.frequency.setTargetAtTime(base, this.ctx.currentTime, 0.05);
    this.engineHum.osc2.frequency.setTargetAtTime(base*1.5, this.ctx.currentTime, 0.05);
  }
}

const AUDIO = new AudioEngine();

// ============================================================
// STARS (background parallax)
// ============================================================
let stars = [];
function initStars(){
  stars = [];
  const n = 140;
  for(let i=0;i<n;i++){
    stars.push({
      x: Math.random()*W,
      y: Math.random()*H,
      z: Math.random()*3+0.5,
      tw: Math.random()*Math.PI*2
    });
  }
}
initStars();
