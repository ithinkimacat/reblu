// reblu — server-authoritative multiplayer grid game
// one tick = one player's turn: roll D6, spend steps live, then dots advance, then next player
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const SIZE = 25;
const TURN_MS = 8000;      // move-phase window per player
const DOT_STEP_MS = 150;   // animation pacing between dot cell-steps
const OBS_COUNT = 10;
const START = [0, 0];
const FINISH = [24, 24];
const PORT = process.env.PORT || 8000;

const key = (x, y) => x + ',' + y;
const inGrid = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
const manh = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const d6 = () => 1 + Math.floor(Math.random() * 6);

// ---------- game state ----------
let G;
function newGame(keepPlayers) {
  const obs = new Set();
  while (obs.size < OBS_COUNT) {
    const x = Math.floor(Math.random() * SIZE), y = Math.floor(Math.random() * SIZE);
    if ((x === START[0] && y === START[1]) || (x === FINISH[0] && y === FINISH[1])) continue;
    obs.add(key(x, y));
  }
  G = {
    tick: 0,
    phase: 'idle',       // idle | move | dots | over
    winner: null,
    obs,
    players: new Map(),  // id -> {id,name,color,x,y,roll,used,lastDir,rider,dead,wins}
    blues: [],           // {id,x,y,boost}  boost 2=>speed 4 next, 1=>3, 0=>2
    reds: [],            // {id,x,y,px,py}
    lastBlasts: [],
    cfg: { blueEvery: 2, redEvery: 4, blueSpeed: 2, redSpeed: 3 }, // live-tunable via client panel
    turnId: null,
    turnEndsAt: 0,
    nextDotId: 1,
  };
  if (keepPlayers) for (const p of keepPlayers) G.players.set(p.id, p);
  respawnAll();
}

// BFS from start for free spawn cells (no obstacle, no player overlap)
function spawnCells(n, occupied = new Set()) {
  const cells = [], seen = new Set([key(...START)]);
  const q = [[START[0], START[1]]];
  while (q.length && cells.length < n) {
    const [x, y] = q.shift();
    if (!occupied.has(key(x, y))) cells.push([x, y]);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (inGrid(nx, ny) && !G.obs.has(k) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return cells.length ? cells : [[0, 0]];
}

const occupiedCells = () =>
  new Set([...G.players.values()].filter(p => !p.dead).map(p => key(p.x, p.y)));

function respawnAll() {
  const cells = spawnCells(G.players.size);
  [...G.players.values()].forEach((p, i) => {
    const [x, y] = cells[i % cells.length];
    p.x = x; p.y = y; p.dead = false; p.rider = null; p.roll = 0; p.used = 0; p.lastDir = null;
  });
}

function respawnPlayer(p) {
  const [x, y] = spawnCells(1, occupiedCells())[0];
  p.x = x; p.y = y; p.dead = false; p.rider = null;
}

function addPlayer(id, name) {
  const colors = ['#ffd54f','#4dd0e1','#aed581','#f48fb1','#ce93d8','#ffab91','#90a4ae','#fff176'];
  const p = { id, name: (name || 'anon').slice(0, 16), color: colors[id % colors.length],
    x: 0, y: 0, roll: 0, used: 0, lastDir: null, rider: null, dead: false, wins: 0 };
  G.players.set(id, p);
  const [x, y] = spawnCells(1, occupiedCells())[0];
  p.x = x; p.y = y;
  return p;
}

// ---------- pathing (dots): BFS avoiding obstacles ----------
function bfsPath(sx, sy, tx, ty, maxSteps) {
  if (sx === tx && sy === ty) return [];
  const prev = new Map([[key(sx, sy), null]]);
  const q = [[sx, sy]];
  let found = null;
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (!inGrid(nx, ny) || G.obs.has(k) || prev.has(k)) continue;
      prev.set(k, key(x, y));
      if (nx === tx && ny === ty) { found = k; q.length = 0; break; }
      q.push([nx, ny]);
    }
  }
  if (!found) return [];
  const cells = [];
  for (let k = found; k; k = prev.get(k)) cells.unshift(k.split(',').map(Number));
  return cells.slice(0, maxSteps); // includes target, excludes start
}

function randomEmptyCell() {
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(Math.random() * SIZE), y = Math.floor(Math.random() * SIZE);
    const k = key(x, y);
    if (G.obs.has(k)) continue;
    if ((x === START[0] && y === START[1]) || (x === FINISH[0] && y === FINISH[1])) continue;
    if ([...G.players.values()].some(p => !p.dead && p.x === x && p.y === y)) continue;
    if (G.blues.some(b => b.x === x && b.y === y) || G.reds.some(r => r.x === x && r.y === y)) continue;
    return [x, y];
  }
  return null;
}

// ---------- turn phases ----------
function dotAt(x, y) {
  const b = G.blues.find(b => b.x === x && b.y === y);
  if (b) return { ref: 'b' + b.id, dot: b };
  const r = G.reds.find(r => r.x === x && r.y === y);
  if (r) return { ref: 'r' + r.id, dot: r };
  return null;
}
const clearRiders = ref => { for (const p of G.players.values()) if (p.rider === ref) p.rider = null; };

function moveRiders(dot, ref) {
  for (const p of G.players.values()) if (p.rider === ref && !p.dead) { p.x = dot.x; p.y = dot.y; }
}

// called when the active player's move window ends: pushing, then riding
function evalLanding(p) {
  const dot = dotAt(p.x, p.y);
  if (dot) {
    const victim = [...G.players.values()].find(q => q !== p && !q.dead && q.x === p.x && q.y === p.y);
    if (victim && p.lastDir) {
      for (let i = 0; i < 2; i++) {
        const nx = victim.x + p.lastDir.dx, ny = victim.y + p.lastDir.dy;
        if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) break;
        if ([...G.players.values()].some(q => q !== victim && !q.dead && q.x === nx && q.y === ny)) break;
        victim.x = nx; victim.y = ny;
      }
      victim.rider = null; // pushed off the dot
    }
  }
  p.rider = dot ? dot.ref : null;
}

// move all dots one cell along their precomputed path, broadcast per step (client animates)
function animateDotMoves(movers, done) {
  // movers: [{dot, path:[ [x,y]... ], ref}]
  let step = 0;
  const max = Math.max(0, ...movers.map(m => m.path.length));
  function stepFn() {
    for (const m of movers) {
      if (step < m.path.length) {
        [m.dot.x, m.dot.y] = m.path[step];
        moveRiders(m.dot, m.ref);
      }
    }
    G.phase = 'dots';
    broadcast();
    if (++step < max) setTimeout(stepFn, DOT_STEP_MS);
    else setTimeout(done, DOT_STEP_MS);
  }
  if (max === 0) setTimeout(done, DOT_STEP_MS);
  else stepFn();
}

function bluePhase(done) {
  const movers = G.blues.map(b => ({
    dot: b, ref: 'b' + b.id,
    path: bfsPath(b.x, b.y, FINISH[0], FINISH[1], G.cfg.blueSpeed + b.boost),
  }));
  for (const b of G.blues) if (b.boost > 0) b.boost--;
  animateDotMoves(movers, () => {
    // merge overlapping blues (riders stick with surviving dot, merge -> speed boost)
    const byCell = new Map();
    for (const b of G.blues) {
      const k = key(b.x, b.y);
      if (!byCell.has(k)) byCell.set(k, b);
      else {
        const keep = byCell.get(k);
        keep.boost = 2;
        for (const p of G.players.values()) if (p.rider === 'b' + b.id) p.rider = 'b' + keep.id;
        G.blues = G.blues.filter(x => x !== b);
      }
    }
    broadcast();
    done();
  });
}

function redPhase(done) {
  const movers = G.reds.map(r => {
    let best = null, bestD = Infinity;
    for (const b of G.blues) {
      const d = manh(r, b);
      if (d < bestD || (d === bestD && Math.random() < 0.5)) { bestD = d; best = b; }
    }
    if (!best) return null;
    r.px = r.x; r.py = r.y;
    return { dot: r, ref: 'r' + r.id, path: bfsPath(r.x, r.y, best.x, best.y, G.cfg.redSpeed) };
  }).filter(Boolean);
  animateDotMoves(movers, () => {
    // reds overlapping other reds annihilate each other (no blast)
    const gone = new Set();
    for (let i = 0; i < G.reds.length; i++) for (let j = i + 1; j < G.reds.length; j++)
      if (G.reds[i].x === G.reds[j].x && G.reds[i].y === G.reds[j].y) { gone.add(G.reds[i]); gone.add(G.reds[j]); }
    if (gone.size) {
      for (const r of gone) clearRiders('r' + r.id);
      G.reds = G.reds.filter(r => !gone.has(r));
    }
    done();
  });
}

// blast LOS: obstacle between collision point and cell shields it.
// ponytail: walks x then y; an obstacle could be bypassed via the other axis. Good enough for 25x25.
function losBlocked(x0, y0, x1, y1) {
  let x = x0, y = y0;
  while (x !== x1 || y !== y1) {
    if (x !== x1) x += Math.sign(x1 - x); else y += Math.sign(y1 - y);
    if (x === x1 && y === y1) break;
    if (G.obs.has(key(x, y))) return true;
  }
  return false;
}

function blastPhase() {
  const blasts = [];
  for (const r of G.reds) {
    const b = G.blues.find(b => b.x === r.x && b.y === r.y);
    if (!b) continue;
    // extension: opposite of red's approach (reverse vector pre-move -> collision)
    const dx = r.x - r.px, dy = r.y - r.py;
    const dir = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
    const cells = [];
    for (let ex = -1; ex <= 1; ex++) for (let ey = -1; ey <= 1; ey++) cells.push([r.x + ex, r.y + ey]);
    if (dir[0] || dir[1]) for (let i = 1; i <= 2; i++) cells.push([r.x - dir[0] * i, r.y - dir[1] * i]);
    blasts.push({ x: r.x, y: r.y, cells: cells.filter(([x, y]) => inGrid(x, y) && !losBlocked(r.x, r.y, x, y)) });
    G.reds = G.reds.filter(x => x !== r);
    G.blues = G.blues.filter(x => x !== b);
    clearRiders('r' + r.id); clearRiders('b' + b.id);
  }
  G.lastBlasts = blasts;
  for (const p of G.players.values()) {
    if (p.dead) continue;
    if (blasts.some(bl => bl.cells.some(([x, y]) => x === p.x && y === p.y))) { p.dead = true; p.rider = null; }
  }
}

// spawns: every cfg.blueEvery / cfg.redEvery ticks (= player turns)
function spawnPhase() {
  if (G.tick % G.cfg.blueEvery === 0) {
    const c = randomEmptyCell();
    if (c) G.blues.push({ id: G.nextDotId++, x: c[0], y: c[1], boost: 0 });
  }
  if (G.tick % G.cfg.redEvery === 0) {
    const c = randomEmptyCell();
    if (c) G.reds.push({ id: G.nextDotId++, x: c[0], y: c[1], px: c[0], py: c[1] });
  }
}

// ---------- turn loop ----------
let turnIdx = 0;
let turnTimer = null;

function turnLoop() {
  if (G.phase === 'over') {
    broadcast();
    return void setTimeout(() => { newGame([...G.players.values()]); turnLoop(); }, 3000);
  }
  const ps = [...G.players.values()];
  if (!ps.length) { broadcast(); return void setTimeout(turnLoop, 1000); }
  const p = ps[turnIdx % ps.length];
  turnIdx++;
  G.tick++;
  G.lastBlasts = [];
  if (p.dead) respawnPlayer(p); // "respawn at start next tick"
  p.roll = d6(); p.used = 0; p.lastDir = null;
  G.phase = 'move'; G.turnId = p.id; G.turnEndsAt = Date.now() + TURN_MS;
  broadcast();
  turnTimer = setTimeout(() => endMove(p.id), TURN_MS);
}

function endMove(id) {
  if (G.phase !== 'move' || G.turnId !== id) return;
  clearTimeout(turnTimer);
  const p = G.players.get(id);
  if (p && !p.dead) evalLanding(p);
  if (G.phase === 'over') return turnLoop(); // win during eval is impossible, but stay safe
  bluePhase(() => redPhase(() => {
    blastPhase();
    spawnPhase();
    G.phase = 'dots';
    broadcast();
    setTimeout(turnLoop, DOT_STEP_MS * 3); // let blast play out client-side
  }));
}

function tryStep(id, dx, dy) {
  if (G.phase !== 'move' || G.turnId !== id) return;
  const p = G.players.get(id);
  if (!p || p.dead || p.used >= p.roll) return;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return;
  const nx = p.x + dx, ny = p.y + dy;
  if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) return;
  if ([...G.players.values()].some(q => q !== p && !q.dead && q.x === nx && q.y === ny)) return;
  p.x = nx; p.y = ny; p.used++; p.lastDir = { dx, dy };
  if (p.x === FINISH[0] && p.y === FINISH[1]) {
    p.wins++; G.phase = 'over'; G.winner = p.name; G.turnId = null;
    clearTimeout(turnTimer);
    broadcast();
    return void setTimeout(() => { newGame([...G.players.values()]); turnLoop(); }, 3500);
  }
  broadcast();
  if (p.used >= p.roll) setTimeout(() => endMove(id), 500); // spent all steps: short beat, then dots go
}

// ---------- networking ----------
function snapshot() {
  return JSON.stringify({
    t: 'state', tick: G.tick, phase: G.phase, winner: G.winner,
    turnId: G.turnId,
    turnMsLeft: G.phase === 'move' ? Math.max(0, G.turnEndsAt - Date.now()) : 0,
    obs: [...G.obs].map(k => k.split(',').map(Number)),
    blasts: G.lastBlasts,
    cfg: G.cfg,
    players: [...G.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
      roll: p.roll, used: p.used, dead: p.dead, wins: p.wins, rider: !!p.rider,
    })),
    blues: G.blues.map(b => ({ id: b.id, x: b.x, y: b.y, boost: b.boost })),
    reds: G.reds.map(r => ({ id: r.id, x: r.x, y: r.y })),
  });
}

const clients = new Map(); // ws -> player id
function broadcast() {
  const s = snapshot();
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(s);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    const MIMEt = MIME[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': MIMEt + (MIMEt.startsWith('text/') ? '; charset=utf-8' : '') });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: srv });
let nextId = 1;
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !clients.has(ws)) {
      const id = nextId++;
      clients.set(ws, id);
      addPlayer(id, m.name);
      ws.send(JSON.stringify({ t: 'welcome', id }));
      broadcast();
    } else if (m.t === 'config') {
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
      for (const k of ['blueEvery', 'redEvery']) if (m[k] != null) G.cfg[k] = clamp(m[k], 1, 10);
      for (const k of ['blueSpeed', 'redSpeed']) if (m[k] != null) G.cfg[k] = clamp(m[k], 1, 6);
      broadcast();
    } else if (m.t === 'step') {
      tryStep(clients.get(ws), m.dx | 0, m.dy | 0);
    } else if (m.t === 'done') {
      endMove(clients.get(ws));
    }
  });
  ws.on('close', () => {
    const id = clients.get(ws);
    clients.delete(ws);
    G.players.delete(id);
    if (G.turnId === id) endMove(id); // active player bailed: move on
    broadcast();
  });
});

newGame();
if (require.main === module) {
  turnLoop();
  srv.listen(PORT, () => console.log(`reblu on http://localhost:${PORT}`));
}

// test hooks
module.exports = { bfsPath, losBlocked, newGame, tryStep, endMove, evalLanding, key,
  get G() { return G; }, set turnIdx(v) { turnIdx = v; } };
