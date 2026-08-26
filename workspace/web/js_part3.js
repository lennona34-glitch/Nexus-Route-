
  // Enemies
  for(const e of enemies){
    const glow = e.type==='boss' ? 25 : 12;
    drawBloomShape(function(){
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if(e.type==='boss'){
        const cx=e.x, cy=e.y, r=e.w/2;
        for(let i=0;i<8;i++){
          const a = (i/8)*Math.PI*2 + e.phase;
          const px = cx+Math.cos(a)*r;
          const py = cy+Math.sin(a)*r*0.7;
          if(i===0) ctx.moveTo(px,py);
          else ctx.lineTo(px,py);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx,cy,r*0.4,0,Math.PI*2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,0,255,0.2)';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx,cy,4,0,Math.PI*2);
        ctx.fill();
      } else {
        const cx=e.x, cy=e.y, w=e.w/2, h=e.h/2;
        ctx.moveTo(cx-w, cy);
        ctx.lineTo(cx-w*0.6, cy-h);
        ctx.lineTo(cx-w*0.2, cy);
        ctx.lineTo(cx, cy-h);
        ctx.lineTo(cx+w*0.2, cy);
        ctx.lineTo(cx+w*0.6, cy-h);
        ctx.lineTo(cx+w, cy);
        ctx.lineTo(cx+w*0.7, cy+h*0.8);
        ctx.lineTo(cx+w*0.3, cy+h*0.6);
        ctx.lineTo(cx, cy+h);
        ctx.lineTo(cx-w*0.3, cy+h*0.6);
        ctx.lineTo(cx-w*0.7, cy+h*0.8);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = e.color;
        ctx.fillRect(cx-4, cy-2, 3, 3);
        ctx.fillRect(cx+1, cy-2, 3, 3);
      }
    }, e.color, glow);

    if(e.hp < e.maxHp){
      const bw = e.w, bh=3;
      ctx.fillStyle = 'rgba(255,0,0,0.5)';
      ctx.fillRect(e.x-e.w/2, e.y-e.h/2-10, bw, bh);
      ctx.fillStyle = '#0f0';
      ctx.fillRect(e.x-e.w/2, e.y-e.h/2-10, bw*(e.hp/e.maxHp), bh);
    }
  }

  // Player ship
  if(state.invuln<=0 || Math.floor(state.time*10)%2===0){
    const px=player.x, py=player.y;
    const w=player.w, h=player.h;
    drawBloomShape(function(){
      ctx.strokeStyle = '#0ff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(px+w/2, py);
      ctx.lineTo(px, py+h);
      ctx.lineTo(px+w*0.4, py+h-6);
      ctx.lineTo(px+w/2, py+h-2);
      ctx.lineTo(px+w*0.6, py+h-6);
      ctx.lineTo(px+w, py+h);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#f0f';
      ctx.beginPath();
      ctx.arc(px+w/2, py+h*0.4, 4, 0, Math.PI*2);
      ctx.fill();
      const fl = Math.sin(state.time*30)*3+4;
      ctx.strokeStyle = '#f0f';
      ctx.beginPath();
      ctx.moveTo(px+w*0.4, py+h-6);
      ctx.lineTo(px+w/2, py+h+fl);
      ctx.lineTo(px+w*0.6, py+h-6);
      ctx.stroke();
    }, '#0ff', 18);

    if(state.invuln>0){
      ctx.strokeStyle = 'rgba(0,255,255,'+(state.invuln*0.5)+')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px+w/2, py+h/2, 30, 0, Math.PI*2);
      ctx.stroke();
    }
  }

  // Particles
  for(const p of particles){
    const a = p.life/p.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x,p.y,p.r*a,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  // Floating texts
  for(const ft of floatingTexts){
    const a = ft.life/ft.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = ft.color;
    ctx.font = 'bold 16px Courier New';
    ctx.shadowColor = ft.color;
    ctx.shadowBlur = 10;
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  if(state.flash>0){
    ctx.fillStyle = 'rgba(255,255,255,'+(state.flash*0.3)+')';
    ctx.fillRect(0,0,W,H);
  }

  ctx.restore();
}

// ============================================================
// UPDATE
// ============================================================
const keys = {};
window.addEventListener('keydown', function(e){
  keys[e.code]=true;
  if(e.code==='Space'){ e.preventDefault(); if(state.running && state.fireTimer<=0) playerShoot(); }
  if(e.code==='Enter' && !state.running){ startGame(); }
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].indexOf(e.code)>=0) e.preventDefault();
});
window.addEventListener('keyup', function(e){ keys[e.code]=false; });

canvas.addEventListener('mousedown', function(){
  if(state.running && state.fireTimer<=0) playerShoot();
});

function update(dt){
  state.time += dt;
  state.fireTimer -= dt;
  if(state.invuln>0) state.invuln -= dt;
  if(state.shake>0) state.shake *= 0.9;
  if(state.flash>0) state.flash -= dt*2;

  const moveSpeed = player.speed * dt;
  if(keys['ArrowLeft']||keys['KeyA']) player.x -= moveSpeed;
  if(keys['ArrowRight']||keys['KeyD']) player.x += moveSpeed;
  player.x = Math.max(player.w/2+4, Math.min(W-player.w/2-4, player.x));

  // Engine hum pitch follows movement
  const moving = keys['ArrowLeft']||keys['ArrowRight']||keys['KeyA']||keys['KeyD'];
  AUDIO.setEnginePitch(moving ? 1.4 : 1.0);

  // Player bullets
  for(let i=playerBullets.length-1;i>=0;i--){
    const b = playerBullets[i];
    b.y += b.vy*dt;
    if(b.y<-20) playerBullets.splice(i,1);
  }

  // Enemy bullets
  for(let i=enemyBullets.length-1;i>=0;i--){
    const b = enemyBullets[i];
    b.x += b.vx*dt;
    b.y += b.vy*dt;
    if(b.y>H+20||b.y<-20||b.x<-20||b.x>W+20) enemyBullets.splice(i,1);
  }

  // Enemy AI
  for(const e of enemies) updateEnemyAI(e, dt);

  // Bullet-enemy collisions
  for(let i=playerBullets.length-1;i>=0;i--){
    const b = playerBullets[i];
    let hit = false;
    for(let j=enemies.length-1;j>=0;j--){
      const e = enemies[j];
      const ex = e.x, ey = e.y, ew = e.w/2, eh = e.h/2;
      if(b.x>ex-ew && b.x<ex+ew && b.y>ey-eh && b.y<ey+eh){
        e.hp -= 1;
        spawnExplosion(b.x,b.y,'#0ff',5,0.5);
        AUDIO.explosion(0.3);
        playerBullets.splice(i,1);
        hit = true;
        if(e.hp<=0){
          // Enemy destroyed
          const isBoss = e.type==='boss';
          const idx = enemies.indexOf(e);
          if(idx>=0) enemies.splice(idx,1);
          state.score += e.score;
          state.combo += 1;
          addText(e.x, e.y-20, '+'+(e.score * (1+Math.floor(state.combo/5))), isBoss?'#f0f':'#0ff');
          spawnExplosion(e.x,e.y,isBoss?'#f0f':'#0ff',isBoss?50:20,isBoss?2.5:1);
          AUDIO.explosion(isBoss?2:1);
          state.shake = Math.max(state.shake, isBoss?8:3);
          state.flash = Math.max(state.flash, isBoss?0.8:0.3);
          // Drop pickup sometimes
          if(Math.random()<0.15 || isBoss){
            pickups.push({
              x:e.x, y:e.y,
              color: isBoss?'#0ff':'#ff6',
              type: isBoss?'life':'power',
            });
          }
          // Check wave complete
          if(enemies.length===0){
            state.wave++;
            state.level = Math.floor((state.wave-1)/3)+1;
            updateHUD();
            if(state.wave<=9){
              addText(W/2, H/2, 'WAVE '+state.wave+' INITIATED', '#0ff');
              spawnWave(state.wave);
            } else {
              addText(W/2, H/2, 'VICTORY!', '#f0f');
              gameOver(true);
            }
          }
        }
        break;
      }
    }
    if(hit) continue;
  }

  // Enemy bullets hit player
  if(state.invuln<=0){
    for(let i=enemyBullets.length-1;i>=0;i--){
      const b = enemyBullets[i];
      const px=player.x, py=player.y;
      if(b.x>px && b.x<px+player.w && b.y>py && b.y<py+player.h){
        enemyBullets.splice(i,1);
        playerHit();
        break;
      }
    }
  }

  // Pickup collection
  for(let i=pickups.length-1;i>=0;i--){
    const p = pickups[i];
    const px=player.x, py=player.y;
    if(p.x>px-20 && p.x<px+player.w+20 && p.y>py-20 && p.y<py+player.h+20){
      if(p.type==='life' && state.lives<5){ state.lives++; }
      else if(p.type==='power'){ state.score += 250; }
      AUDIO.powerup();
      spawnExplosion(p.x,p.y,p.color,10,0.5);
      pickups.splice(i,1);
    }
  }

  // Update particles
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.x += p.vx*dt;
    p.y += p.vy*dt;
    p.life -= dt;
    if(p.life<=0) particles.splice(i,1);
  }

  // Update floating texts
  for(let i=floatingTexts.length-1;i>=0;i--){
    const ft = floatingTexts[i];
    ft.y -= 30*dt;
    ft.life -= dt;
    if(ft.life<=0) floatingTexts.splice(i,1);
  }

  updateHUD();
}

function playerHit(){
  state.lives--;
  state.invuln = 2;
  state.shake = 10;
  state.flash = 0.6;
  AUDIO.explosion(1.5);
  spawnExplosion(player.x+player.w/2, player.y+player.h/2, '#f0f', 30, 1.5);
  if(state.lives<=0){
    gameOver(false);
  }
}

function updateHUD(){
  document.getElementById('scoreVal').textContent = String(state.score).padStart(6,'0');
  document.getElementById('levelVal').textContent = String(state.level).padStart(2,'0');
  document.getElementById('livesVal').textContent = String(state.lives);
  document.getElementById('waveVal').textContent = String(state.wave);
}

// ============================================================
// GAME START / OVER
// ============================================================
function startGame(){
  AUDIO.init();
  AUDIO.resume();
  AUDIO.startEngineHum();
  overlay.style.display = 'none';
  state.running = true;
  state.score = 0;
  state.lives = 3;
  state.wave = 1;
  state.level = 1;
  state.invuln = 0;
  state.combo = 0;
  player.x = W/2;
  player.y = H-80;
  playerBullets = [];
  enemyBullets = [];
  particles = [];
  pickups = [];
  floatingTexts = [];
  spawnWave(1);
  updateHUD();
}

function gameOver(victory){
  state.running = false;
  overlay.style.display = 'flex';
  const h1 = overlay.querySelector('h1');
  const h2 = overlay.querySelector('h2');
  const p = overlay.querySelectorAll('p');
  h1.textContent = victory ? 'VICTORY' : 'GAME OVER';
  h2.textContent = victory ? '// ALL WAVES CLEARED //' : '// NEON SIGNAL LOST //';
  if(victory){
    p[0].textContent = 'SCORE: '+String(state.score).padStart(6,'0');
    p[1].textContent = 'WAVES SURVIVED: '+state.wave;
    p[2].textContent = 'PRESS ENTER TO PLAY AGAIN';
  } else {
    p[0].textContent = 'FINAL SCORE: '+String(state.score).padStart(6,'0');
    p[1].textContent = 'WAVE REACHED: '+state.wave;
    p[2].textContent = 'PRESS ENTER TO RETRY';
  }
  startBtn.style.display = 'inline-block';
  startBtn.textContent = victory ? 'PLAY AGAIN' : 'RETRY';
}

startBtn.addEventListener('click', startGame);

// ============================================================
// MAIN LOOP
// ============================================================
let lastTime = 0;
function gameLoop(t){
  const dt = Math.min((t-lastTime)/1000, 0.05);
  lastTime = t;
  if(state.running) update(dt);
  render();
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
</script>
</body>
</html>
