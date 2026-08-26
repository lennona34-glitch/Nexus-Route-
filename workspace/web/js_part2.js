
// ============================================================
// GAME STATE
// ============================================================
const state = {
  running: false,
  score: 0,
  lives: 3,
  level: 1,
  wave: 1,
  invuln: 0,
  time: 0,
  shake: 0,
  bossActive: false,
  flash: 0,
  combo: 0,
};

const player = {
  x: W/2, y: H-80,
  w: 34, h: 26,
  speed: 320,
  fireRate: 0.16,
  fireTimer: 0,
};

let playerBullets = [];
let enemyBullets = [];
let enemies = [];
let particles = [];
let pickups = [];
let mazeWalls = [];
let floatingTexts = [];

// ============================================================
// PROCEDURAL LABYRINTH MAZE GENERATION
// ============================================================
function generateMaze(){
  mazeWalls = [];
  const cols = 12, rows = 9;
  const cw = W / cols, ch = (H*0.55) / rows;
  const mazeStartY = H*0.12;

  const grid = [];
  for(let r=0;r<rows;r++){
    grid[r]=[];
    for(let c=0;c<cols;c++) grid[r][c]={visited:false, walls:{N:true,S:true,E:true,W:true}};
  }
  const stack = [];
  const start = {r:0,c:0};
  grid[0][0].visited = true;
  stack.push(start);

  const dirs = [[-1,0,'N','S'],[1,0,'S','N'],[0,-1,'W','E'],[0,1,'E','W']];
  while(stack.length){
    const cur = stack[stack.length-1];
    const opts = [];
    for(const [dr,dc,d,opp] of dirs){
      const nr=cur.r+dr, nc=cur.c+dc;
      if(nr>=0&&nr<rows&&nc>=0&&nc<cols&&!grid[nr][nc].visited) opts.push([nr,nc,d,opp]);
    }
    if(opts.length===0){ stack.pop(); continue; }
    const [nr,nc,d,opp] = opts[Math.floor(Math.random()*opts.length)];
    grid[cur.r][cur.c].walls[d]=false;
    grid[nr][nc].walls[opp]=false;
    grid[nr][nc].visited=true;
    stack.push({r:nr,c:nc});
  }

  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const cell = grid[r][c];
      const x0 = c*cw, y0 = mazeStartY + r*ch;
      if(cell.walls.N) mazeWalls.push({x:x0,y:y0,w:cw,h:4});
      if(cell.walls.S) mazeWalls.push({x:x0,y:y0+ch,w:cw,h:4});
      if(cell.walls.W) mazeWalls.push({x:x0,y:y0,w:4,h:ch});
      if(cell.walls.E) mazeWalls.push({x:x0+cw,y:y0,w:4,h:ch});
    }
  }
  mazeWalls.push({x:0,y:mazeStartY-2,w:W,h:4});
  mazeWalls.push({x:0,y:mazeStartY+H*0.55+2,w:W,h:4});
  mazeWalls.push({x:0,y:mazeStartY,w:4,h:H*0.55});
  mazeWalls.push({x:W-4,y:mazeStartY,w:4,h:H*0.55});
  return mazeWalls;
}

// ============================================================
// WAVE CONFIGURATION
// ============================================================
function getWaveConfig(wave){
  return {
    count: Math.min(4 + wave*2, 16),
    speed: 30 + wave*8,
    fireRate: Math.max(1.2 - wave*0.1, 0.5),
    hp: 1 + Math.floor(wave/2),
    type: wave%3===0 ? 'boss' : (wave%2===0 ? 'zigzag' : 'patrol'),
    hasBoss: wave%3===0,
  };
}

function makeEnemy(type, wave){
  const cfg = getWaveConfig(wave);
  const mazeStartY = H*0.12;
  const mazeH = H*0.55;
  return {
    type: type,
    x: Math.random()*(W-80)+40,
    y: mazeStartY + Math.random()*(mazeH-80)+40,
    w: type==='boss'?70:30,
    h: type==='boss'?50:24,
    hp: type==='boss' ? 20+wave*5 : cfg.hp,
    maxHp: type==='boss' ? 20+wave*5 : cfg.hp,
    speed: cfg.speed,
    fireRate: cfg.fireRate,
    fireTimer: Math.random()*cfg.fireRate,
    dir: Math.random()<0.5?-1:1,
    angle: Math.random()*Math.PI*2,
    patrolTarget: null,
    phase: 0,
    color: type==='boss' ? '#f0f' : (type==='zigzag' ? '#ff6' : '#0ff'),
    score: type==='boss' ? 1000 : (type==='zigzag'?100:50),
  };
}

function spawnWave(wave){
  enemies = [];
  playerBullets = [];
  enemyBullets = [];
  pickups = [];
  const cfg = getWaveConfig(wave);
  generateMaze();
  for(let i=0;i<cfg.count;i++){
    const type = (cfg.hasBoss && i===cfg.count-1) ? 'boss' : cfg.type;
    enemies.push(makeEnemy(type, wave));
  }
  state.bossActive = cfg.hasBoss;
  if(cfg.hasBoss) AUDIO.bossHorn();
}

// ============================================================
// PATROL AI
// ============================================================
function updateEnemyAI(e, dt){
  e.phase += dt;
  const mazeStartY = H*0.12;
  const mazeBottom = mazeStartY + H*0.55;

  if(e.type==='boss'){
    e.x += Math.sin(e.phase*0.6) * 60 * dt * 2;
    e.y = mazeStartY + 60 + Math.sin(e.phase*0.4)*30;
    e.x = Math.max(40, Math.min(W-40, e.x));
    if(Math.floor(e.phase*10)%25===0 && e.phase>0.1){
      const burst = 8;
      for(let i=0;i<burst;i++){
        const a = (i/burst)*Math.PI*2 + e.phase;
        enemyBullets.push({x:e.x, y:e.y, vx:Math.cos(a)*140, vy:Math.sin(a)*140, r:5, color:'#f0f'});
      }
      AUDIO.enemyLaser(250,0.3,0.4);
    }
    e.fireTimer -= dt;
    if(e.fireTimer<=0){
      const a = Math.atan2(player.y-e.y, player.x-e.x);
      enemyBullets.push({x:e.x,y:e.y,vx:Math.cos(a)*220,vy:Math.sin(a)*220,r:6,color:'#f0f'});
      AUDIO.enemyLaser(200,0.2,0.4);
      e.fireTimer = 1.0;
    }
    return;
  }

  if(e.type==='zigzag'){
    e.x += e.dir * e.speed * 2 * dt;
    e.y += Math.sin(e.phase*2)*30*dt;
    if(e.x<40){e.dir=1;} if(e.x>W-40){e.dir=-1;}
  } else {
    if(e.patrolTarget===null){
      e.patrolTarget = {x: Math.random()*W, y: mazeStartY+Math.random()*(mazeBottom-mazeStartY-40)};
    }
    const dx = e.patrolTarget.x - e.x;
    const dy = e.patrolTarget.y - e.y;
    const dist = Math.hypot(dx,dy);
    if(dist<10){
      e.patrolTarget = {x: Math.random()*W, y: mazeStartY+Math.random()*(mazeBottom-mazeStartY-40)};
    } else {
      e.x += (dx/dist)*e.speed*0.6*dt;
      e.y += (dy/dist)*e.speed*0.6*dt;
    }
  }

  e.fireTimer -= dt;
  if(e.fireTimer<=0){
    const a = Math.atan2(player.y-e.y, player.x-e.x);
    enemyBullets.push({x:e.x,y:e.y,vx:Math.cos(a)*160,vy:Math.sin(a)*160,r:4,color:'#ff6'});
    AUDIO.enemyLaser(350,0.15,0.2);
    e.fireTimer = e.fireRate;
  }
}

// ============================================================
// PARTICLES / FLOATING TEXT
// ============================================================
function spawnExplosion(x,y,color,count,size){
  count = count||20; size = size||1;
  for(let i=0;i<count;i++){
    const a = Math.random()*Math.PI*2;
    const sp = Math.random()*200*size+30;
    particles.push({
      x:x, y:y,
      vx:Math.cos(a)*sp,
      vy:Math.sin(a)*sp,
      life:Math.random()*0.6+0.3,
      maxLife:0.9,
      r:Math.random()*3*size+1,
      color: color || '#0ff',
    });
  }
}

function addText(x,y,text,color){
  floatingTexts.push({x:x,y:y,text:text,color:color,life:1.2,maxLife:1.2});
}

// ============================================================
// PLAYER SHOOT
// ============================================================
function playerShoot(){
  if(state.fireTimer>0) return;
  state.fireTimer = player.fireRate;
  playerBullets.push({x:player.x+player.w/2, y:player.y, vy:-520, r:3, color:'#0ff', trail:[]});
  playerBullets.push({x:player.x+player.w/2-6, y:player.y+4, vy:-480, r:2, color:'#f0f', trail:[]});
  AUDIO.laser(900, 0.15, 0.3);
  state.shake = Math.max(state.shake, 1);
}

// ============================================================
// BLOOM RENDER
// ============================================================
function drawBloomShape(fn, glowColor, glowSize){
  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = glowSize;
  fn();
  ctx.restore();
}

function render(){
  ctx.fillStyle = '#05010f';
  ctx.fillRect(0,0,W,H);

  ctx.save();
  if(state.shake>0){
    ctx.translate((Math.random()-0.5)*state.shake*3, (Math.random()-0.5)*state.shake*3);
  }

  // Stars
  for(const s of stars){
    s.tw += 0.02;
    const a = 0.3 + Math.sin(s.tw)*0.3;
    const sz = s.z;
    ctx.fillStyle = 'rgba(200,230,255,'+(a*0.5)+')';
    ctx.fillRect(s.x, s.y, sz, sz);
  }

  // Maze walls
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = '#0ff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  for(const w of mazeWalls){
    ctx.moveTo(w.x, w.y);
    ctx.lineTo(w.x+w.w, w.y);
    ctx.lineTo(w.x+w.w, w.y+w.h);
    ctx.lineTo(w.x, w.y+w.h);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Pickups
  for(const p of pickups){
    const pulse = Math.sin(state.time*5+p.x)*0.3+0.7;
    ctx.fillStyle = 'rgba(255,255,255,'+pulse+')';
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(p.x,p.y,6,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Player bullets
  for(const b of playerBullets){
    b.trail.push({x:b.x,y:b.y});
    if(b.trail.length>6) b.trail.shift();
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for(let i=0;i<b.trail.length;i++){
      const t = b.trail[i];
      if(i===0) ctx.moveTo(t.x,t.y);
      else ctx.lineTo(t.x,t.y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Enemy bullets
  for(const b of enemyBullets){
    ctx.fillStyle = b.color;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
