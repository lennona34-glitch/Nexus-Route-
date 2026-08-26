#!/usr/bin/env python3
"""Build glow_pinball3.html with fixed audio unlock."""
import os

HTML_PART1 = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Glow Pinball Physics Sandbox - Dr. Dre Drop the Beat</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #000; font-family: 'Courier New', monospace; overflow: hidden; height: 100vh; }
        #gameCanvas { position: absolute; top: 0; left: 0; border: 2px solid #00ff00; box-shadow: 0 0 30px #00ff00; image-rendering: pixelated; }
        .crt { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 10; background: linear-gradient(rgba(0,255,0,0.03) 50%, rgba(0,0,0,0.1) 50%); background-size: 100% 4px; }
        .flicker { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 11; background: rgba(0,255,0,0.02); animation: f 0.15s infinite; }
        @keyframes f { 0%,100% { opacity: 0.97; } 50% { opacity: 1; } }
        .ui { position: absolute; top: 10px; left: 10px; background: rgba(0,20,0,0.9); border: 1px solid #00ff00; padding: 15px; color: #00ff00; font-size: 12px; z-index: 100; box-shadow: 0 0 10px rgba(0,255,0,0.3); }
        .ui h3 { margin-bottom: 10px; font-size: 14px; text-shadow: 0 0 10px #00ff00; }
        .ui .s { margin: 5px 0; padding: 3px 0; border-bottom: 1px solid rgba(0,255,0,0.3); }
        .controls { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); text-align: center; z-index: 100; }
        .btn { background: rgba(0,40,0,0.8); border: 1px solid #00ff00; color: #00ff00; padding: 8px 16px; margin: 5px; cursor: pointer; font-family: inherit; font-size: 12px; transition: all 0.2s; }
        .btn:hover { background: rgba(0,255,0,0.2); box-shadow: 0 0 10px #00ff00; }
        .btn.on { background: rgba(0,255,0,0.3); box-shadow: 0 0 15px #00ff00; }
        .prompt { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,20,0,0.95); border: 2px solid #00ff00; padding: 40px 60px; color: #00ff00; text-align: center; z-index: 200; box-shadow: 0 0 50px rgba(0,255,0,0.7); animation: p 1.5s ease-in-out infinite; cursor: pointer; }
        @keyframes p { 0%,100% { box-shadow: 0 0 50px rgba(0,255,0,0.5); } 50% { box-shadow: 0 0 80px rgba(0,255,0,0.9); } }
        .prompt h2 { font-size: 32px; margin-bottom: 15px; text-shadow: 0 0 20px #00ff00; }
        .prompt p { margin: 10px 0; font-size: 14px; }
        .blink { animation: b 1s infinite; }
        @keyframes b { 0%,50% { opacity: 1; } 51%,100% { opacity: 0.2; } }
        .hidden { display: none !important; }
    </style>
</head>
<body>
    <div class="crt"></div>
    <div class="flicker"></div>

    <div class="prompt" id="audioPrompt">
        <h2>◆ GLOW PINBALL ◆</h2>
        <p style="font-size:18px;">Dr. Dre "Drop the Beat" Edition</p>
        <p style="margin-top:25px; font-size:13px;">[ CLICK TO START THE BEAT ]</p>
        <p style="font-size:11px; opacity:0.7; margin-top:15px;">FM Synth Bass + 808 Drums</p>
    </div>

    <div class="ui">
        <h3>◆ GLOW PINBALL SANDBOX ◆</h3>
        <div class="s">FPS: <span id="fps">60</span></div>
        <div class="s">Particles: <span id="pc">0</span></div>
        <div class="s">Lasers: <span id="lc">0</span></div>
        <div class="s">Balls: <span id="bc">0</span></div>
        <div class="s">Score: <span id="sc">0</span></div>
        <div class="s">Status: <span id="st" style="color:#00ff00">READY</span></div>
    </div>

    <canvas id="gameCanvas"></canvas>

    <div class="controls">
        <button class="btn" id="btnClear">CLEAR</button>
        <button class="btn" id="btnLaser">+ LASER</button>
        <button class="btn" id="btnBall">+ BALL</button>
        <button class="btn" id="btnTarget">+ TARGET</button>
        <button class="btn on" id="audioBtn">AUDIO: ON</button>
    </div>

    <script>
    // ═══ GLOW PINBALL - Dr. Dre Drop the Beat ═══

    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    let lastTime = performance.now();
    let fps = 60, frames = 0, fpsTime = 0;
    let audioEnabled = true;
    let audioStarted = false;

    const gs = { balls: [], lasers: [], particles: [], destructibles: [], score: 0, combo: 0 };

    function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // ═══ BEAT ENGINE - FM SYNTH + 808 DRUMS ═══

    class BeatEngine {
        constructor() { this.ctx = null; this.master = null; this.inited = false; this.sched = null; this.step = 0; }

        init() {
            if (this.inited) return;
            try {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (this.ctx.state === 'suspended') this.ctx.resume();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.4;
                this.master.connect(this.ctx.destination);
                this.inited = true;
                this.startSequencer();
                console.log('🎵 BEAT DROPPED!');
            } catch (e) { console.error('Audio init failed:', e); }
        }

        playFMBass(freq, dur, t) {
            const mod = this.ctx.createOscillator(), modG = this.ctx.createGain();
            const car = this.ctx.createOscillator(), carG = this.ctx.createGain();
            mod.type = 'sine'; mod.frequency.value = freq * 2;
            modG.gain.value = freq * 0.6;
            car.type = 'sine'; car.frequency.value = freq;
            mod.connect(modG); modG.connect(car.frequency);
            car.connect(carG); carG.connect(this.master);
            carG.gain.setValueAtTime(0, t);
            carG.gain.linearRampToValueAtTime(0.35, t + 0.02);
            carG.gain.exponentialRampToValueAtTime(0.01, t + dur);
            mod.start(t); car.start(t); mod.stop(t + dur); car.stop(t + dur);
        }

        playKick(t) {
            const o = this.ctx.createOscillator(), g = this.ctx.createGain();
            o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.15);
            g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
            o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.3);
        }

        playSnare(t) {
            const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.2, this.ctx.sampleRate);
            const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            const n = this.ctx.createBufferSource(); n.buffer = buf;
            const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1000;
            const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
            n.connect(f); f.connect(g); g.connect(this.master); n.start(t); n.stop(t + 0.2);
            const o = this.ctx.createOscillator(), og = this.ctx.createGain();
            o.type = 'triangle'; o.frequency.value = 180;
            og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.05);
            o.connect(og); og.connect(this.master); o.start(t); o.stop(t + 0.1);
        }

        playHat(t) {
            const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.08, this.ctx.sampleRate);
            const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            const n = this.ctx.createBufferSource(); n.buffer = buf;
            const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
            const g = this.ctx.createGain(); g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.06);
            n.connect(f); f.connect(g); g.connect(this.master); n.start(t); n.stop(t + 0.08);
        }

        playZap(t) {
            const o = this.ctx.createOscillator(), g = this.ctx.createGain();
            o.type = 'sawtooth'; o.frequency.setValueAtTime(1200, t); o.frequency.exponentialRampToValueAtTime(100, t + 0.12);
            g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.12);
        }

        playBoom(t) {
            const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.3, this.ctx.sampleRate);
            const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
            const n = this.ctx.createBufferSource(); n.buffer = buf;
            const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
            const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
            n.connect(f); f.connect(g); g.connect(this.master); n.start(t); n.stop(t + 0.3);
        }

        startSequencer() {
            if (!this.inited || !audioEnabled) return;
            const bpm = 90, stepT = 60 / bpm / 4;
            this.step = 0;
            // G-funk bassline
            const bass = [55,0,65.41,73.42, 55,0,82.41,0, 49,0,65.41,73.42, 55,65.41,73.42,82.41];
            const kick = [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0];
            const snare = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,1,0];
            const hat = [1,0,1,1, 1,0,1,1, 1,0,1,1, 1,1,1,1];
            let nextT = this.ctx.currentTime + 0.05;
            const tick = () => {
                if (!this.inited || !audioEnabled) return;
                while (nextT < this.ctx.currentTime + 0.1) {
                    if (bass[this.step] > 0) this.playFMBass(bass[this.step], stepT * 0.9, nextT);
                    if (kick[this.step]) this.playKick(nextT);
                    if (snare[this.step]) this.playSnare(nextT);
                    if (hat[this.step]) this.playHat(nextT);
                    this.step = (this.step + 1) % 16;
                    nextT += stepT;
                }
                this.sched = setTimeout(tick, 25);
            };
            tick();
        }

        stopSequencer() { if (this.sched) { clearTimeout(this.sched); this.sched = null; } }
    }

    const beat = new BeatEngine();

    // ═══ PHYSICS ENGINE ═══

    const physics = {
        gravity: 0.3, friction: 0.995, elasticity: 0.85, maxSpeed: 15,

        update(ball) {
            ball.vy += this.gravity;
            ball.x += ball.vx; ball.y += ball.vy;
            const sp = Math.hypot(ball.vx, ball.vy);
            if (sp > this.maxSpeed) { ball.vx = ball.vx / sp * this.maxSpeed; ball.vy = ball.vy / sp * this.maxSpeed; }
            if (ball.x < ball.radius) { ball.x = ball.radius; ball.vx = -ball.vx * this.elasticity; this.sparks(ball.x, ball.y); }
            if (ball.x > canvas.width - ball.radius) { ball.x = canvas.width - ball.radius; ball.vx = -ball.vx * this.elasticity; this.sparks(ball.x, ball.y); }
            if (ball.y < ball.radius) { ball.y = ball.radius; ball.vy = -ball.vy * this.elasticity; this.sparks(ball.x, ball.y); }
            if (ball.y > canvas.height - ball.radius) { ball.y = canvas.height - ball.radius; ball.vy = -ball.vy * this.elasticity; this.sparks(ball.x, ball.y); }
            ball.vx *= this.friction; ball.vy *= this.friction;
        },

        checkLaser(laser, ball) {
            const d = Math.hypot(ball.x - laser.x, ball.y - laser.y);
            if (d < ball.radius + 5) {
                const a = Math.atan2(ball.y - laser.y, ball.x - laser.x);
                ball.vx += Math.cos(a) * 3; ball.vy += Math.sin(a) * 3;
                explode(ball.x, ball.y, 10, '#00ff00');
                gs.score += 10; gs.combo++;
                if (beat.inited) beat.playZap(beat.ctx.currentTime);
                return true;
            }
            return false;
        },

        checkDest(dest, ball) {
            const d = Math.hypot(ball.x - dest.x, ball.y - dest.y);
            if (d < ball.radius + dest.size / 2) {
                const a = Math.atan2(ball.y - dest.y, ball.x - dest.x);
                ball.vx = Math.cos(a) * Math.abs(ball.vx) * 1.2;
                ball.vy = Math.sin(a) * Math.abs(ball.vy) * 1.2;
                dest.health--; dest.hitFlash = 10;
                explode(ball.x, ball.y, 6, '#00ff00');
                if (dest.health <= 0) {
                    explode(dest.x, dest.y, 35, '#00ff00'); explode(dest.x, dest.y, 20, '#88ff88');
                    gs.score += 50 * Math.max(1, gs.combo); gs.combo = 0; dest.active = false;
                    if (beat.inited) beat.playBoom(beat.ctx.currentTime);
                } else { gs.score += 10; }
                return true;
            }
            return false;
        },

        checkBallBall(b1, b2) {
            const dx = b2.x - b1.x, dy = b2.y - b1.y, d = Math.hypot(dx, dy), md = b1.radius + b2.radius;
            if (d < md && d > 0) {
                const nx = dx / d, ny = dy / d, dvn = (b1.vx - b2.vx) * nx + (b1.vy - b2.vy) * ny;
                if (dvn > 0) {
                    b1.vx -= dvn * nx; b1.vy -= dvn * ny; b2.vx += dvn * nx; b2.vy += dvn * ny;
                    const ov = md - d; b1.x -= nx * ov / 2; b1.y -= ny * ov / 2; b2.x += nx * ov / 2; b2.y += ny * ov / 2;
                    explode((b1.x + b2.x) / 2, (b1.y + b2.y) / 2, 6, '#88ff88');
                }
            }
        },

        sparks(x, y) { if (Math.random() > 0.4) explode(x, y, 3, '#00ff00'); }
    };
'''

HTML_PART2 = '''
    // ═══ GAME OBJECTS ═══

    class Ball {
        constructor(x, y) {
            this.x = x; this.y = y; this.radius = 8 + Math.random() * 6;
            this.vx = (Math.random() - 0.5) * 10; this.vy = (Math.random() - 0.5) * 10;
            this.color = '#00ff00'; this.glow = 15 + Math.random() * 10; this.trail = [];
        }
        update() {
            this.trail.push({ x: this.x, y: this.y });
            if (this.trail.length > 10) this.trail.shift();
            physics.update(this);
        }
        draw() {
            ctx.save();
            for (let i = 0; i < this.trail.length; i++) {
                const t = this.trail[i];
                ctx.globalAlpha = i / this.trail.length * 0.3;
                ctx.fillStyle = this.color;
                ctx.beginPath();
                ctx.arc(t.x, t.y, this.radius * (i / this.trail.length), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            ctx.save();
            ctx.shadowBlur = this.glow; ctx.shadowColor = this.color; ctx.fillStyle = this.color;
            ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 5; ctx.fillStyle = '#88ff88';
            ctx.beginPath(); ctx.arc(this.x - this.radius * 0.3, this.y - this.radius * 0.3, this.radius * 0.3, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }
    }

    class Laser {
        constructor(x, y, angle) {
            this.x = x; this.y = y; this.angle = angle;
            this.length = Math.max(canvas.width, canvas.height) * 1.5;
            this.color = '#00ff00'; this.pulse = Math.random() * Math.PI * 2; this.cool = 0;
        }
        update() { this.pulse += 0.1; if (this.cool > 0) this.cool--; }
        draw() {
            const p = 0.7 + Math.sin(this.pulse) * 0.3;
            const ex = this.x + Math.cos(this.angle) * this.length;
            const ey = this.y + Math.sin(this.angle) * this.length;
            ctx.save();
            ctx.strokeStyle = this.color; ctx.lineWidth = 8; ctx.globalAlpha = 0.15 * p;
            ctx.shadowBlur = 25; ctx.shadowColor = this.color;
            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.lineWidth = 2; ctx.globalAlpha = p;
            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.strokeStyle = '#88ff88'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.fillStyle = this.color; ctx.shadowBlur = 15;
            ctx.beginPath(); ctx.arc(this.x, this.y, 5, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }
    }

    class Particle {
        constructor(x, y, color, vx, vy) {
            this.x = x; this.y = y;
            this.vx = vx || (Math.random() - 0.5) * 8;
            this.vy = vy || (Math.random() - 0.5) * 8;
            this.color = color || '#00ff00';
            this.life = 30 + Math.random() * 30; this.maxLife = this.life;
            this.size = 2 + Math.random() * 3;
        }
        update() { this.x += this.vx; this.y += this.vy; this.vy += 0.1; this.vx *= 0.98; this.vy *= 0.98; this.life--; }
        draw() {
            ctx.save(); ctx.globalAlpha = this.life / this.maxLife;
            ctx.fillStyle = this.color; ctx.shadowBlur = 5; ctx.shadowColor = this.color;
            ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
            ctx.restore();
        }
        alive() { return this.life > 0; }
    }

    class Destructible {
        constructor(x, y, size) {
            this.x = x; this.y = y;
            this.size = size || 40 + Math.random() * 30;
            this.health = 3; this.maxHealth = 3; this.active = true;
            this.color = '#00ff00'; this.pulse = Math.random() * Math.PI * 2; this.hitFlash = 0;
        }
        update() { this.pulse += 0.05; if (this.hitFlash > 0) this.hitFlash--; }
        draw() {
            if (!this.active) return;
            const p = 0.8 + Math.sin(this.pulse) * 0.2, hr = this.health / this.maxHealth;
            ctx.save();
            ctx.strokeStyle = this.hitFlash > 0 ? '#ffffff' : this.color;
            ctx.lineWidth = 2; ctx.shadowBlur = 15 * p; ctx.shadowColor = this.color;
            ctx.setLineDash([8, 4]);
            ctx.strokeRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
            ctx.setLineDash([]);
            const bs = 10; ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(this.x - this.size / 2, this.y - this.size / 2 + bs); ctx.lineTo(this.x - this.size / 2, this.y - this.size / 2); ctx.lineTo(this.x - this.size / 2 + bs, this.y - this.size / 2);
            ctx.moveTo(this.x + this.size / 2 - bs, this.y - this.size / 2); ctx.lineTo(this.x + this.size / 2, this.y - this.size / 2); ctx.lineTo(this.x + this.size / 2, this.y - this.size / 2 + bs);
            ctx.moveTo(this.x + this.size / 2, this.y + this.size / 2 - bs); ctx.lineTo(this.x + this.size / 2, this.y + this.size / 2); ctx.lineTo(this.x + this.size / 2 - bs, this.y + this.size / 2);
            ctx.moveTo(this.x - this.size / 2 + bs, this.y + this.size / 2); ctx.lineTo(this.x - this.size / 2, this.y + this.size / 2); ctx.lineTo(this.x - this.size / 2, this.y + this.size / 2 - bs);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(this.x - this.size / 2, this.y + this.size / 2 + 5, this.size, 4);
            ctx.fillStyle = this.color;
            ctx.fillRect(this.x - this.size / 2, this.y + this.size / 2 + 5, this.size * hr, 4);
            ctx.restore();
        }
    }

    // ═══ HELPERS ═══

    function explode(x, y, count, color) {
        for (let i = 0; i < count; i++) {
            const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
            const s = 2 + Math.random() * 5;
            gs.particles.push(new Particle(x, y, color, Math.cos(a) * s, Math.sin(a) * s));
        }
    }

    function addBall(x, y) { gs.balls.push(new Ball(x || Math.random() * canvas.width, y || Math.random() * canvas.height / 2)); }
    function addLaser(x, y) { gs.lasers.push(new Laser(x || Math.random() * canvas.width, y || Math.random() * canvas.height, Math.random() * Math.PI * 2)); }
    function addTarget(x, y) { gs.destructibles.push(new Destructible(x || Math.random() * canvas.width, y || Math.random() * canvas.height)); }
    function clearLevel() { gs.balls = []; gs.lasers = []; gs.particles = []; gs.destructibles = []; gs.score = 0; gs.combo = 0; }
'''

HTML_PART3 = '''
    // ═══ AUDIO UNLOCK - THE KEY FIX ═══

    function startAudio() {
        if (!audioStarted && audioEnabled) {
            beat.init();
            audioStarted = true;
            document.getElementById('audioPrompt').classList.add('hidden');
            document.getElementById('st').textContent = 'DROPPING';
            document.getElementById('st').style.color = '#88ff88';
        }
    }

    function toggleAudio() {
        audioEnabled = !audioEnabled;
        const btn = document.getElementById('audioBtn');
        btn.textContent = 'AUDIO: ' + (audioEnabled ? 'ON' : 'OFF');
        btn.classList.toggle('on', audioEnabled);
        if (audioEnabled && audioStarted) beat.startSequencer();
        else if (!audioEnabled) beat.stopSequencer();
    }

    // Wire up audio prompt click
    document.getElementById('audioPrompt').addEventListener('click', startAudio);

    // Wire up buttons - ALL start audio on click
    document.getElementById('btnClear').addEventListener('click', () => { startAudio(); clearLevel(); });
    document.getElementById('btnLaser').addEventListener('click', () => { startAudio(); addLaser(); });
    document.getElementById('btnBall').addEventListener('click', () => { startAudio(); addBall(); });
    document.getElementById('btnTarget').addEventListener('click', () => { startAudio(); addTarget(); });
    document.getElementById('audioBtn').addEventListener('click', () => { startAudio(); toggleAudio(); });

    // Canvas interactions
    canvas.addEventListener('click', (e) => {
        startAudio(); // THIS unlocks audio!
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        if (e.shiftKey) addBall(x, y);
        else addLaser(x, y);
    });

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        startAudio();
        const r = canvas.getBoundingClientRect();
        addTarget(e.clientX - r.left, e.clientY - r.top);
    });

    // ═══ GAME LOOP ═══

    function gameLoop(t) {
        const dt = (t - lastTime) / 16.67;
        lastTime = t;
        frames++;
        if (t - fpsTime > 1000) { fps = frames; frames = 0; fpsTime = t; }

        // Update
        gs.balls.forEach(b => b.update());
        gs.lasers.forEach(l => l.update());
        gs.destructibles.forEach(d => d.update());
        gs.particles.forEach(p => p.update());
        gs.particles = gs.particles.filter(p => p.alive());

        // Collisions
        gs.balls.forEach(b => {
            gs.lasers.forEach(l => { if (l.cool === 0 && physics.checkLaser(l, b)) l.cool = 5; });
            gs.destructibles.forEach(d => { if (d.active) physics.checkDest(d, b); });
        });
        for (let i = 0; i < gs.balls.length; i++)
            for (let j = i + 1; j < gs.balls.length; j++)
                physics.checkBallBall(gs.balls[i], gs.balls[j]);
        gs.destructibles = gs.destructibles.filter(d => d.active);

        // Render
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid
        ctx.save();
        ctx.strokeStyle = 'rgba(0,255,0,0.05)'; ctx.lineWidth = 1;
        for (let x = 0; x < canvas.width; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
        for (let y = 0; y < canvas.height; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
        ctx.restore();

        gs.particles.forEach(p => p.draw());
        gs.destructibles.forEach(d => d.draw());
        gs.lasers.forEach(l => l.draw());
        gs.balls.forEach(b => b.draw());

        // UI
        document.getElementById('fps').textContent = fps;
        document.getElementById('pc').textContent = gs.particles.length;
        document.getElementById('lc').textContent = gs.lasers.length;
        document.getElementById('bc').textContent = gs.balls.length;
        document.getElementById('sc').textContent = gs.score;

        requestAnimationFrame(gameLoop);
    }

    // ═══ INIT ═══

    // Spawn initial objects
    addBall(); addBall(); addBall();
    addLaser(); addLaser(); addLaser();
    addTarget(); addTarget();

    // Start game loop
    requestAnimationFrame(gameLoop);
    </script>
</body>
</html>
'''

def build():
    output_path = "C:\\Users\\adria\\.gemini\\antigravity\\scratch\\nexus-route\\workspace\\glow_pinball3.html"
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(HTML_PART1)
        f.write(HTML_PART2)
        f.write(HTML_PART3)
    print(f"✓ Written: {output_path}")
    print(f"✓ Size: {os.path.getsize(output_path):,} bytes")

if __name__ == "__main__":
    build()
