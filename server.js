// reblu — server-authoritative multiplayer grid game
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const SIZE = 25;
const TICK_MS = 1800;
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
  // obstacles: 10 random, never on start/finish
  const obs = new Set();
  while (obs.size < OBS_COUNT) {
    const x = Math.floor(Math.random() * SIZE), y = Math.floor(Math.random() * SIZE);
    if ((x === START[0] && y === START[1]) || (x === FINISH[0] && y === FINISH[1])) continue;
    obs.add(key(x, y));
  }
  G = {
    tick: 0,
    phase: 'play',
    winner: null,
    obs,
    players: new Map(), // id -> {id,name,color,x,y,roll,queue:[{dx,dy}],rider,dead,wins}
    blues: [],          // {id,x,y,boost}  boost 2=>next speed 4, 1=>3, 0=>2
    reds: [],           // {id,x,y,px,py}
    nextDotId: 1,
  };
  if (keepPlayers) for (const p of keepPlayers) {
    G.players.set(p.id, p);
  }
  respawnAll();
}

// BFS from start for free spawn cells (players can't overlap, avoid obstacles)
function spawnCells(n) {
  const cells = [], seen = new Set([key(...START)]);
  const q = [[START[0], START[1]]];
  while (q.length && cells.length < n) {
    const [x, y] = q.shift();
    cells.push([x, y]);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (inGrid(nx, ny) && !G.obs.has(k) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return cells.length ? cells : [[0, 0]];
}

function respawnAll() {
  const ps = [...G.players.values()];
  const cells = spawnCells(ps.length);
  ps.forEach((p, i) => {
    const [x, y] = cells[i % cells.length];
    p.x = x; p.y = y; p.dead = false; p.rider = null; p.queue = []; p.roll = 0;
  });
}

function addPlayer(id, name) {
  const colors = ['#ffd54f','#4dd0e1','#aed581','#f48fb1','#ce93d8','#ffab91','#90a4ae','#fff176'];
  const p = { id, name: (name || 'anon').slice(0, 16), color: colors[id % colors.length],
    x: 0, y: 0, roll: 0, queue: [], rider: null, dead: false, wins: 0 };
  G.players.set(id, p);
  const cells = spawnCells(G.players.size);
  const others = new Set([...G.players.values()].filter(q => q !== p).map(q => key(q.x, q.y)));
  for (const [x, y] of cells) if (!others.has(key(x, y)) && !G.obs.has(key(x, y))) { p.x = x; p.y = y; break; }
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
  for (let k = found; k; k = prev.get(k)) { const [x, y] = k.split(',').map(Number); cells.unshift([x, y]); }
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

// ---------- tick phases ----------
function playerPhase() {
  for (const p of G.players.values()) {
    if (p.dead) continue;
    let moved = false, lastDir = null;
    for (const step of p.queue) {
      const nx = p.x + step.dx, ny = p.y + step.dy;
      if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) break;
      if ([...G.players.values()].some(q => q !== p && !q.dead && q.x === nx && q.y === ny)) break;
      p.x = nx; p.y = ny; moved = true; lastDir = step;
    }
    p.queue = [];
    if (p.x === FINISH[0] && p.y === FINISH[1]) { p.wins++; G.phase = 'over'; G.winner = p.name; return; }

    // pushing: landed on dot occupied by another player
    const dot = dotAt(p.x, p.y);
    if (dot) {
      const victim = [...G.players.values()].find(q => q !== p && !q.dead && q.x === p.x && q.y === p.y);
      if (victim && lastDir) {
        for (let i = 0; i < 2; i++) {
          const nx = victim.x + lastDir.dx, ny = victim.y + lastDir.dy;
          if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) break;
          if ([...G.players.values()].some(q => q !== victim && !q.dead && q.x === nx && q.y === ny)) break;
          victim.x = nx; victim.y = ny;
        }
        victim.rider = null; // pushed off the dot
      }
    }
    // riding: end turn on any dot
    p.rider = dot ? dot.ref : null;
  }
}

const dotAt = (x, y) => {
  const b = G.blues.find(b => b.x === x && b.y === y);
  if (b) return { ref: 'b' + b.id, dot: b };
  const r = G.reds.find(r => r.x === x && r.y === y);
  if (r) return { ref: 'r' + r.id, dot: r };
  return null;
};

function moveDot(dot, steps) {
  // target decided by caller via dot._tx/_ty
  const path = bfsPath(dot.x, dot.y, dot._tx, dot._ty, steps);
  for (const [x, y] of path) { dot.x = x; dot.y = y; }
}

function moveRiders(dot, ref) {
  for (const p of G.players.values()) if (p.rider === ref && !p.dead) { p.x = dot.x; p.y = dot.y; }
}

function bluePhase() {
  for (const b of G.blues) {
    b._tx = FINISH[0]; b._ty = FINISH[1];
    const speed = b.boost === 2 ? 4 : b.boost === 1 ? 3 : 2;
    moveDot(b, speed);
    if (b.boost > 0) b.boost--;
    moveRiders(b, 'b' + b.id);
  }
  // merge overlapping blues (riders stick with the surviving dot)
  const byCell = new Map();
  for (const b of G.blues) {
    const k = key(b.x, b.y);
    if (!byCell.has(k)) byCell.set(k, b);
    else {
      const keep = byCell.get(k);
      keep.boost = 2; // speed boost: 4 next tick, 3 after, then 2
      for (const p of G.players.values()) if (p.rider === 'b' + b.id) p.rider = 'b' + keep.id;
      G.blues = G.blues.filter(x => x !== b);
    }
  }
  // spawn every 2 ticks
  if (G.tick % 2 === 0) {
    const c = randomEmptyCell();
    if (c) G.blues.push({ id: G.nextDotId++, x: c[0], y: c[1], boost: 0 });
  }
}

function redPhase() {
  for (const r of G.reds) {
    if (!G.blues.length) break; // no target: idle
    let best = null, bestD = Infinity;
    for (const b of G.blues) {
      const d = manh(r, b);
      if (d < bestD || (d === bestD && Math.random() < 0.5)) { bestD = d; best = b; }
    }
    r.px = r.x; r.py = r.y;
    r._tx = best.x; r._ty = best.y;
    moveDot(r, 3);
    moveRiders(r, 'r' + r.id);
  }
  // reds overlapping other reds annihilate each other (no blast)
  const gone = new Set();
  for (let i = 0; i < G.reds.length; i++) for (let j = i + 1; j < G.reds.length; j++) {
    if (G.reds[i].x === G.reds[j].x && G.reds[i].y === G.reds[j].y) { gone.add(G.reds[i]); gone.add(G.reds[j]); }
  }
  if (gone.size) {
    for (const r of gone) clearRiders('r' + r.id);
    G.reds = G.reds.filter(r => !gone.has(r));
  }
  // spawn every 4 ticks
  if (G.tick % 4 === 0) {
    const c = randomEmptyCell();
    if (c) G.reds.push({ id: G.nextDotId++, x: c[0], y: c[1], px: c[0], py: c[1] });
  }
}

const clearRiders = ref => { for (const p of G.players.values()) if (p.rider === ref) p.rider = null; };

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
    for (let i = 1; i <= 2; i++) cells.push([r.x - dir[0] * i, r.y - dir[1] * i]);
    if (!dir[0] && !dir[1]) cells.length = 9; // zero vector: core only
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

function tick() {
  if (G.phase === 'over') {
    G.overTicks = (G.overTicks || 0) + 1;
    if (G.overTicks >= 3) newGame([...G.players.values()]);
    broadcast();
    return;
  }
  G.tick++;
  playerPhase();
  if (G.phase === 'play') {
    bluePhase();
    redPhase();
    blastPhase();
  }
  // respawn next tick: dead players reappear at start
  const deads = [...G.players.values()].filter(p => p.dead);
  if (deads.length) {
    const cells = spawnCells(G.players.size);
    let i = 0;
    for (const p of deads) {
      const occupied = new Set([...G.players.values()].filter(q => !q.dead).map(q => key(q.x, q.y)));
      for (const [x, y] of cells) if (!occupied.has(key(x, y))) { p.x = x; p.y = y; p.dead = false; i++; break; }
    }
  }
  // roll for next window
  for (const p of G.players.values()) p.roll = p.dead ? 0 : d6();
  broadcast();
}

function snapshot() {
  return JSON.stringify({
    t: 'state', tick: G.tick, phase: G.phase, winner: G.winner,
    tickMs: TICK_MS,
    obs: [...G.obs].map(k => k.split(',').map(Number)),
    blasts: (G.lastBlasts || []).map(b => ({ x: b.x, y: b.y, cells: b.cells })),
    players: [...G.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
      roll: p.roll, queued: p.queue.length, dead: p.dead, wins: p.wins, rider: !!p.rider,
    })),
    blues: G.blues.map(b => ({ x: b.x, y: b.y, boost: b.boost })),
    reds: G.reds.map(r => ({ x: r.x, y: r.y })),
  });
}

const clients = new Map(); // ws -> player id
function broadcast() {
  const s = snapshot();
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(s);
}

// ---------- server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  let f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
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
      const p = addPlayer(id, m.name);
      ws.send(JSON.stringify({ t: 'welcome', id }));
      broadcast();
    } else if (m.t === 'queue') {
      const p = G.players.get(clients.get(ws));
      if (!p || p.dead || G.phase !== 'play') return;
      // client sends absolute queue; server validates orthogonal steps and caps at roll
      const dirs = Array.isArray(m.dirs) ? m.dirs.slice(0, p.roll) : [];
      p.queue = dirs.filter(d => Math.abs(d.dx) + Math.abs(d.dy) === 1)
                    .map(d => ({ dx: Math.sign(d.dx), dy: Math.sign(d.dy) }));
    }
  });
  ws.on('close', () => {
    const id = clients.get(ws);
    clients.delete(ws);
    G.players.delete(id);
    broadcast();
  });
});

newGame();
if (require.main === module) {
  setInterval(tick, TICK_MS);
  srv.listen(PORT, () => console.log(`reblu on http://localhost:${PORT}`));
}

// test hooks
module.exports = { bfsPath, losBlocked, newGame, tick, key, get G() { return G; } };
