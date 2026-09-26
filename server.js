// reblu — server-authoritative multiplayer grid game
// one tick = one player's turn: roll D6, spend steps live, then dots advance, then next player
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const TURN_MS = 8000;      // move-phase window per player
const DOT_STEP_MS = 150;   // animation pacing between dot cell-steps
const START = [0, 0];
const PORT = process.env.PORT || 8000;

const key = (x, y) => x + ',' + y;
const HATS = ['none', 'crown', 'tophat', 'party', 'halo', 'horns'];
const fin = () => G.goal;
const inGrid = (x, y) => x >= 0 && y >= 0 && x < G.w && y < G.h;
const d6 = () => 1 + Math.floor(Math.random() * 6);

// ---------- game state ----------
// live-tunable settings; persisted across newGame() resets, edited from client panel
const CFG = {
  blueEvery: 2, redEvery: 3, blueSpeed: 3, redSpeed: 4, obs: 20, blueCount: 5, redCount: 3, sizeX: 15, sizeY: 15,
  greenEvery: 0, greenCount: 1, trail: 4,   // green: off by default; trail = cells left behind (0 in greenEvery = dot type off)
  yellowEvery: 0, yellowSpeed: 3, yellowCount: 1,
};
let G;
let worldGen = 0; // bumped by newGame(): async phase chains from a dead world abort on mismatch

function buildObs(count, occupied = new Set()) {
  const obs = new Set();
  while (obs.size < count) {
    const x = Math.floor(Math.random() * G.w), y = Math.floor(Math.random() * G.h);
    const k = key(x, y);
    if (obs.has(k) || (x === START[0] && y === START[1]) || (x === fin()[0] && y === fin()[1]) || occupied.has(k)) continue;
    obs.add(k);
  }
  return obs;
}

function newGame(keepPlayers) {
  worldGen++;
  G = {
    gen: worldGen,
    tick: 0,
    w: CFG.sizeX,
    h: CFG.sizeY,
    goal: [CFG.sizeX - 1, CFG.sizeY - 1],
    goalJump: null,       // {from, to} when a blue dot reaches the goal before any player
    phase: 'lobby',      // lobby | move | dots | over
    winner: null,
    obs: new Set(),
    players: new Map(),  // id -> {id,name,color,x,y,roll,used,lastDir,rider,dead,wins,ready}
    blues: [],           // {id,x,y,boost,mix:'g'|null,trailLeft}  mix 'g' = Gb: green body, blue center
    reds: [],            // {id,x,y,px,py,mix,trailLeft}           mix 'g' = Gr: green body, red center
    greens: [],          // static green dots {id,x,y} — absorb on step: trail effect
    yellows: [],         // {id,x,y,dx,dy} DVD-logo bouncers, eat any dot they cross
    greenTiles: new Map(), // 'x,y' -> turns left on that trail tile
    lastBlasts: [],
    cfg: CFG,
    turnId: null,
    turnEndsAt: 0,
    nextDotId: 1,
  };
  if (keepPlayers) for (const p of keepPlayers) { G.players.set(p.id, p); p.ready = false; }
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
  const clean = String(name || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4);
  const p = { id, name: clean || 'anon', color: colors[id % colors.length],
    x: 0, y: 0, roll: 0, used: 0, lastDir: null, rider: null, dead: false, wins: 0, ready: false, hat: 'none' };
  G.players.set(id, p);
  const [x, y] = spawnCells(1, occupiedCells())[0];
  p.x = x; p.y = y;
  return p;
}

// ---------- pathing (dots): BFS avoiding obstacles ----------
// avoid: optional Set of cell keys treated like obstacles (used for soft routing)
function bfsPath(sx, sy, tx, ty, maxSteps, avoid) {
  if (sx === tx && sy === ty) return [];
  const prev = new Map([[key(sx, sy), null]]);
  const q = [[sx, sy]];
  let found = null;
  while (q.length) {
    const [x, y] = q.shift();
    // down/right first: paths read as heading diagonally toward the bottom-right finish
    for (const [dx, dy] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (!inGrid(nx, ny) || G.obs.has(k) || prev.has(k)) continue;
      if (avoid && avoid.has(k) && !(nx === tx && ny === ty)) continue;
      prev.set(k, key(x, y));
      if (nx === tx && ny === ty) { found = k; q.length = 0; break; }
      q.push([nx, ny]);
    }
  }
  if (!found) return [];
  const cells = [];
  for (let k = found; k; k = prev.get(k)) cells.unshift(k.split(',').map(Number));
  return cells.slice(1, maxSteps + 1); // includes target, excludes start
}

// cells a red could blast now or next phase: its 3x3 neighborhood
function redBlastZone() {
  const z = new Set();
  for (const r of G.reds) for (let ex = -1; ex <= 1; ex++) for (let ey = -1; ey <= 1; ey++) {
    const x = r.x + ex, y = r.y + ey;
    if (inGrid(x, y)) z.add(key(x, y));
  }
  return z;
}

function randomEmptyCell() {
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(Math.random() * G.w), y = Math.floor(Math.random() * G.h);
    const k = key(x, y);
    if (G.obs.has(k)) continue;
    if ((x === START[0] && y === START[1]) || (x === fin()[0] && y === fin()[1])) continue;
    if ([...G.players.values()].some(p => !p.dead && p.x === x && p.y === y)) continue;
    if (G.blues.some(b => b.x === x && b.y === y) || G.reds.some(r => r.x === x && r.y === y) ||
        G.greens.some(g => g.x === x && g.y === y) || G.yellows.some(yl => yl.x === x && yl.y === y)) continue;
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

// anyone standing on the finish (own steps, pushed, or riding a dot) wins
function checkWin() {
  const p = [...G.players.values()].find(q => !q.dead && q.x === fin()[0] && q.y === fin()[1]);
  if (!p) return false;
  p.wins++; G.phase = 'over'; G.winner = p.name; G.turnId = null;
  clearTimeout(turnTimer);
  broadcast();
  setTimeout(() => { newGame([...G.players.values()]); turnLoop(); }, 3500);
  return true;
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
  const gen = G.gen;
  let step = 0;
  const max = Math.max(0, ...movers.map(m => m.path.length));
  function stepFn() {
    if (G.gen !== gen) return; // world was reset mid-animation
    for (const m of movers) {
      if (step < m.path.length) {
        const [px, py] = [m.dot.x, m.dot.y];
        [m.dot.x, m.dot.y] = m.path[step];
        if (m.dot.mix === 'g' && m.dot.trailLeft > 0) G.greenTiles.set(key(px, py), G.cfg.trail);
        moveRiders(m.dot, m.ref);
        // blue or red crossing a static green dot absorbs it (mix + trail countdown (re)news)
        if ((m.ref[0] === 'b' || m.ref[0] === 'r') && m.dot.mix !== 'g') {
          const gg = G.greens.find(g => g.x === m.dot.x && g.y === m.dot.y);
          if (gg) { m.dot.mix = 'g'; m.dot.trailLeft = G.cfg.trail; m.dot.px = m.dot.x; m.dot.py = m.dot.y; G.greens = G.greens.filter(x => x !== gg); }
        } else if (m.dot.mix === 'g') {
          const gg = G.greens.find(g => g.x === m.dot.x && g.y === m.dot.y);
          if (gg) { m.dot.trailLeft = G.cfg.trail; G.greens = G.greens.filter(x => x !== gg); } // trail countdown renews
        }
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
  const zone = redBlastZone();
  const redCells = new Set(G.reds.map(r => key(r.x, r.y)));
  const movers = G.blues.map(b => {
    const max = G.cfg.blueSpeed + b.boost, [fx, fy] = fin();
    // prefer routes away from red blast zones, then away from reds, then anything goes
    let path = bfsPath(b.x, b.y, fx, fy, max, zone);
    if (!path.length) path = bfsPath(b.x, b.y, fx, fy, max, redCells);
    if (!path.length) path = bfsPath(b.x, b.y, fx, fy, max);
    return { dot: b, ref: 'b' + b.id, path };
  });
  for (const b of G.blues) if (b.boost > 0) b.boost--;
  const gen = G.gen;
  animateDotMoves(movers, () => {
    if (G.gen !== gen) return;
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
    greenMix();
    broadcast();
    // goal teleport: a blue dot arrived before any player did
    const [gx, gy] = fin();
    if (G.blues.some(b => b.x === gx && b.y === gy) &&
        ![...G.players.values()].some(p => !p.dead && p.x === gx && p.y === gy)) {
      const from = [...G.goal];
      G.goal = teleportSpot();
      G.goalJump = { from, to: [...G.goal] };
      broadcast();
    }
    if (checkWin()) return;
    done();
  });
}

// flood from a red: path to the nearest reachable blue (or unclaimed green — reds absorb greens).
// claimed targets are skipped unless allow* — spreads reds across targets.
function redPath(r, claimed, claimedGreens, allowClaimed) {
  const blocked = new Set(G.reds.filter(o => o !== r).map(o => key(o.x, o.y)));
  const prev = new Map([[key(r.x, r.y), null]]);
  const q = [[r.x, r.y]];
  while (q.length) {
    const [x, y] = q.shift(), k = key(x, y);
    const b = (x !== r.x || y !== r.y) && G.blues.find(b => b.x === x && b.y === y && (allowClaimed || !claimed.has(b.id)));
    const gg = (x !== r.x || y !== r.y) && G.greens.find(g => g.x === x && g.y === y && !claimedGreens.has(g.id));
    if (b || gg) {
      const cells = [];
      for (let kk = k; kk; kk = prev.get(kk)) cells.unshift(kk.split(',').map(Number));
      if (gg) claimedGreens.add(gg.id); else claimed.add(b.id);
      return cells.slice(1, G.cfg.redSpeed + 1);
    }
    for (const [dx, dy] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      const nx = x + dx, ny = y + dy, nk = key(nx, ny);
      if (!inGrid(nx, ny) || G.obs.has(nk) || prev.has(nk) || blocked.has(nk)) continue;
      prev.set(nk, k); q.push([nx, ny]);
    }
  }
  return [];
}

function redPhase(done) {
  const claimed = new Set(), claimedGreens = new Set();
  const movers = G.reds.map(r => {
    r.px = r.x; r.py = r.y;
    let path = redPath(r, claimed, claimedGreens, false);
    if (!path.length) path = redPath(r, claimed, claimedGreens, true); // every reachable target taken: gang up anyway
    return path.length ? { dot: r, ref: 'r' + r.id, path } : null;
  }).filter(Boolean);
  const gen = G.gen;
  animateDotMoves(movers, () => {
    if (G.gen !== gen) return;
    // reds overlapping other reds annihilate each other (no blast)
    const gone = new Set();
    for (let i = 0; i < G.reds.length; i++) for (let j = i + 1; j < G.reds.length; j++)
      if (G.reds[i].x === G.reds[j].x && G.reds[i].y === G.reds[j].y) { gone.add(G.reds[i]); gone.add(G.reds[j]); }
    if (gone.size) {
      for (const r of gone) clearRiders('r' + r.id);
      G.reds = G.reds.filter(r => !gone.has(r));
    }
    greenMix();
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

// blast cells: 3x3 around the collision plus a 2-cell tail opposite the red's approach
function blastCells(r) {
  const dx = r.x - r.px, dy = r.y - r.py;
  const dir = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  const cells = [];
  for (let ex = -1; ex <= 1; ex++) for (let ey = -1; ey <= 1; ey++) cells.push([r.x + ex, r.y + ey]);
  if (dir[0] || dir[1]) for (let i = 1; i <= 2; i++) cells.push([r.x - dir[0] * i, r.y - dir[1] * i]);
  return cells.filter(([x, y]) => inGrid(x, y) && !losBlocked(r.x, r.y, x, y));
}

// green spread on mixing: every blast-radius cell becomes trail
function spreadBlast(r) {
  for (const [x, y] of blastCells(r)) G.greenTiles.set(key(x, y), G.cfg.trail);
}

function blastPhase() {
  const blasts = [];
  for (const r of [...G.reds]) {
    const b = G.blues.find(b => b.x === r.x && b.y === r.y);
    if (!b) continue;
    if (r.mix === 'g' || b.mix === 'g') {
      // mixed dots never blast: the opposite type converts the mixed one, green floods the blast radius
      if (b.mix === 'g') { // Gb + R (or Gb + Gr): red center wins -> Gr
        r.mix = 'g'; r.trailLeft = G.cfg.trail; r.px = r.x; r.py = r.y;
        G.blues = G.blues.filter(x => x !== b); clearRiders('b' + b.id);
      } else { // Gr + pure B -> Gb
        b.mix = 'g'; b.trailLeft = G.cfg.trail;
        G.reds = G.reds.filter(x => x !== r); clearRiders('r' + r.id);
      }
      spreadBlast(r);
      continue;
    }
    const cells = blastCells(r);
    blasts.push({ x: r.x, y: r.y, cells });
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

// anything standing on a static green dot absorbs it: mix + trail countdown (re)news
function greenMix() {
  for (const b of G.blues) {
    const g = G.greens.find(g => g.x === b.x && g.y === b.y);
    if (g) { b.mix = 'g'; b.trailLeft = G.cfg.trail; G.greens = G.greens.filter(x => x !== g); clearRiders('g' + g.id); }
  }
  for (const r of G.reds) {
    const g = G.greens.find(g => g.x === r.x && g.y === r.y);
    if (g) { r.mix = 'g'; r.trailLeft = G.cfg.trail; r.px = r.x; r.py = r.y; G.greens = G.greens.filter(x => x !== g); clearRiders('g' + g.id); }
  }
}

// yellow: DVD-logo bounce off walls and obstacles, eats any dot whose cell it crossed
function yellowPath(yl, maxSteps) {
  const path = [];
  if (!yl.dx && !yl.dy) { yl.dx = Math.random() < 0.5 ? 1 : -1; yl.dy = Math.random() < 0.5 ? 1 : -1; }
  let x = yl.x, y = yl.y;
  for (let i = 0; i < maxSteps; i++) {
    let nx = x + yl.dx, ny = y + yl.dy;
    if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) {
      // bounce: flip the axis that has room (DVD-logo style)
      if (inGrid(x - yl.dx, y + yl.dy) && !G.obs.has(key(x - yl.dx, y + yl.dy))) { yl.dx = -yl.dx; nx = x + yl.dx; }
      else if (inGrid(nx, y - yl.dy) && !G.obs.has(key(nx, y - yl.dy))) { yl.dy = -yl.dy; ny = y + yl.dy; }
      else { yl.dx = -yl.dx; yl.dy = -yl.dy; nx = x + yl.dx; ny = y + yl.dy; if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) break; }
    }
    x = nx; y = ny; path.push([x, y]);
  }
  return path;
}

function yellowPhase(done) {
  const movers = G.yellows.map(yl => {
    const path = yellowPath(yl, G.cfg.yellowSpeed);
    return path.length ? { dot: yl, ref: 'y' + yl.id, path } : null;
  }).filter(Boolean);
  const gen = G.gen;
  animateDotMoves(movers, () => {
    if (G.gen !== gen) return;
    const crossed = new Set();
    for (const m of movers) for (const [x, y] of m.path) crossed.add(key(x, y));
    for (const [arr, ref] of [[G.blues, 'b'], [G.reds, 'r'], [G.greens, 'g']]) {
      for (const d of [...arr]) if (crossed.has(key(d.x, d.y))) {
        arr.splice(arr.indexOf(d), 1); clearRiders(ref + d.id);
      }
    }
    for (const yl of [...G.yellows]) {
      const other = movers.find(m => m.dot !== yl && m.path.some(([x, y]) => x === yl.x && y === yl.y));
      if (other) G.yellows = G.yellows.filter(x => x !== yl); // two yellows cross: annihilate
    }
    done();
  });
}

// spawnPhase: spawns + one tick of trail decay + mixed-dot countdowns
function spawnPhase() {
  // green trail tiles fade one turn at a time
  for (const [k, v] of G.greenTiles) { if (v <= 1) G.greenTiles.delete(k); else G.greenTiles.set(k, v - 1); }
  // mixed-dot green effect wears off when its countdown runs out
  for (const b of G.blues) if (b.mix === 'g' && --b.trailLeft <= 0) b.mix = null;
  for (const r of G.reds) if (r.mix === 'g' && --r.trailLeft <= 0) r.mix = null;
  if (G.tick % G.cfg.blueEvery === 0) {
    for (let i = 0; i < G.cfg.blueCount; i++) {
      const c = randomEmptyCell();
      if (c) G.blues.push({ id: G.nextDotId++, x: c[0], y: c[1], boost: 0, mix: null, trailLeft: 0 });
    }
  }
  if (G.tick % G.cfg.redEvery === 0) {
    for (let i = 0; i < G.cfg.redCount; i++) {
      const c = randomEmptyCell();
      if (c) G.reds.push({ id: G.nextDotId++, x: c[0], y: c[1], px: c[0], py: c[1], mix: null, trailLeft: 0 });
    }
  }
  if (G.cfg.greenEvery && G.tick % G.cfg.greenEvery === 0) {
    for (let i = 0; i < G.cfg.greenCount; i++) {
      const c = randomEmptyCell();
      if (c) G.greens.push({ id: G.nextDotId++, x: c[0], y: c[1] });
    }
  }
  if (G.cfg.yellowEvery && G.tick % G.cfg.yellowEvery === 0) {
    for (let i = 0; i < G.cfg.yellowCount; i++) {
      const c = randomEmptyCell();
      if (c) G.yellows.push({ id: G.nextDotId++, x: c[0], y: c[1], dx: 0, dy: 0 });
    }
  }
}

// ---------- turn loop ----------
let turnIdx = 0;
let turnTimer = null;
let turnPauseLeft = 0; // active player's tab hidden: turn timer parks until they return

// Begin pressed by everyone in the lobby: fresh board, first turn
// fresh goal spot for the teleport rule: empty, far from start
function teleportSpot() {
  const [sx, sy] = START, [gx, gy] = fin();
  for (let tries = 0; tries < 300; tries++) {
    const x = Math.floor(Math.random() * G.w), y = Math.floor(Math.random() * G.h);
    if (G.obs.has(key(x, y)) || (x === sx && y === sy) || (x === gx && y === gy)) continue;
    if ([...G.players.values()].some(p => !p.dead && p.x === x && p.y === y)) continue;
    if (G.blues.some(b => b.x === x && b.y === y)) continue;
    if (Math.abs(x - sx) + Math.abs(y - sy) < Math.min(G.w, G.h) / 2) continue;
    return [x, y];
  }
  return [gx ? 0 : G.w - 1, gy ? 0 : G.h - 1]; // fallback: opposite corner
}

function startGame() {
  G.w = CFG.sizeX; G.h = CFG.sizeY;
  G.goal = [G.w - 1, G.h - 1]; G.goalJump = null;
  G.obs = buildObs(CFG.obs);
  G.blues = []; G.reds = []; G.lastBlasts = [];
  G.tick = 0; G.winner = null;
  respawnAll();
  G.phase = 'move';
  turnLoop();
}

function turnLoop() {
  if (G.phase === 'over') { broadcast(); return; } // checkWin owns the restart timer
  if (G.phase === 'lobby') {
    broadcast();
    const ps = [...G.players.values()];
    if (ps.length >= 2 && ps.every(p => p.ready)) return startGame();
    return void setTimeout(turnLoop, 500);
  }
  const ps = [...G.players.values()];
  if (!ps.length) { broadcast(); return void setTimeout(turnLoop, 1000); }
  const p = ps[turnIdx % ps.length];
  turnIdx++;
  G.tick++;
  G.lastBlasts = [];
  G.goalJump = null;
  if (p.dead) respawnPlayer(p); // "respawn at start next tick"
  p.roll = d6(); p.used = 0; p.lastDir = null;
  G.phase = 'move'; G.turnId = p.id; G.turnEndsAt = Date.now() + TURN_MS; G.paused = false; turnPauseLeft = 0;
  broadcast();
  turnTimer = setTimeout(() => endMove(p.id), TURN_MS);
}

function endMove(id) {
  if (G.phase !== 'move' || G.turnId !== id) return;
  clearTimeout(turnTimer);
  G.paused = false; turnPauseLeft = 0;
  const p = G.players.get(id);
  if (p && !p.dead) {
    evalLanding(p);
    if (checkWin()) return; // pushed onto the finish still counts
  }
  const gen = G.gen;
  bluePhase(() => redPhase(() => yellowPhase(() => {
    if (G.gen !== gen) return; // world was reset mid-turn
    blastPhase();
    spawnPhase();
    G.phase = 'dots';
    broadcast();
    setTimeout(turnLoop, DOT_STEP_MS * 3); // let blast play out client-side
  })));
}

function tryStep(id, dx, dy) {
  if (G.phase !== 'move' || G.turnId !== id) return;
  const p = G.players.get(id);
  if (!p || p.dead || p.used >= p.roll) return;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return;
  const nx = p.x + dx, ny = p.y + dy;
  if (!inGrid(nx, ny) || G.obs.has(key(nx, ny))) return;
  if ([...G.players.values()].some(q => q !== p && !q.dead && q.x === nx && q.y === ny)) return;
  if (p.trailLeft > 0) { G.greenTiles.set(key(p.x, p.y), G.cfg.trail); p.trailLeft--; } // green trail behind the player
  p.x = nx; p.y = ny; p.used++; p.lastDir = { dx, dy };
  const g = G.greens.find(g => g.x === nx && g.y === ny);
  if (g) { G.greens = G.greens.filter(x => x !== g); p.trailLeft = G.cfg.trail; } // stepped on green: pick it up
  if (checkWin()) return;
  broadcast();
  if (p.used >= p.roll) setTimeout(() => endMove(id), 500); // spent all steps: short beat, then dots go
}

// ---------- networking ----------
function snapshot() {
  return JSON.stringify({
    t: 'state', tick: G.tick, phase: G.phase, winner: G.winner,
    turnId: G.turnId,
    paused: !!G.paused,
    turnMsLeft: G.phase === 'move' ? Math.max(0, G.turnEndsAt - Date.now()) : 0,
    obs: [...G.obs].map(k => k.split(',').map(Number)),
    blasts: G.lastBlasts,
    goal: G.goal,
    goalJump: G.goalJump,
    cfg: G.cfg,
    w: G.w, h: G.h,
    greens: G.greens.map(g => ({ id: g.id, x: g.x, y: g.y })),
    yellows: G.yellows.map(yl => ({ id: yl.id, x: yl.x, y: yl.y })),
    greenTiles: [...G.greenTiles].map(([k, life]) => { const [x, y] = k.split(',').map(Number); return { x, y, life }; }),
    players: [...G.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
      roll: p.roll, used: p.used, dead: p.dead, wins: p.wins, rider: !!p.rider, ready: !!p.ready, hat: p.hat,
    })),
    blues: G.blues.map(b => ({ id: b.id, x: b.x, y: b.y, boost: b.boost, mix: b.mix || null })),
    reds: G.reds.map(r => ({ id: r.id, x: r.x, y: r.y, mix: r.mix || null })),
  });
}

const clients = new Map(); // ws -> player id
function broadcast() {
  const s = snapshot();
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(s);
}

const srv = http.createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404); return res.end('nope'); }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: srv });
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 30000).unref(); // keep proxies from dropping idle sockets
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
      if (G.phase !== 'lobby') return; // settings are a lobby activity
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
      for (const k of ['blueEvery', 'redEvery']) if (m[k] != null) G.cfg[k] = clamp(m[k], 1, 10);
      for (const k of ['blueSpeed', 'redSpeed']) if (m[k] != null) G.cfg[k] = clamp(m[k], 1, 6);
      if (m.blueCount != null) G.cfg.blueCount = clamp(m.blueCount, 1, 5);
      if (m.redCount != null) G.cfg.redCount = clamp(m.redCount, 1, 5);
      if (m.obs != null) G.cfg.obs = clamp(m.obs, 0, 100);
      if (m.sizeX != null) G.cfg.sizeX = clamp(m.sizeX, 15, 40);
      if (m.sizeY != null) G.cfg.sizeY = clamp(m.sizeY, 15, 40);
      for (const k of ['greenEvery', 'yellowEvery']) if (m[k] != null) G.cfg[k] = clamp(m[k], 0, 10); // 0 = dot type off
      for (const k of ['greenCount', 'yellowCount']) if (m[k] != null) G.cfg[k] = clamp(m[k], 1, 5);
      if (m.trail != null) G.cfg.trail = clamp(m.trail, 1, 10);
      if (m.yellowSpeed != null) G.cfg.yellowSpeed = clamp(m.yellowSpeed, 1, 8);
      broadcast();
    } else if (m.t === 'hat') { // hats are a lobby activity, like settings
      const p = G.players.get(clients.get(ws));
      if (p && G.phase === 'lobby' && HATS.includes(m.hat)) { p.hat = m.hat; broadcast(); }
    } else if (m.t === 'begin') {
      const p = G.players.get(clients.get(ws));
      if (p && G.phase === 'lobby') { p.ready = true; broadcast(); }
    } else if (m.t === 'pause') { // active player's tab went to the background
      const id = clients.get(ws);
      if (G.phase === 'move' && G.turnId === id && turnTimer && !G.paused) {
        clearTimeout(turnTimer);
        turnPauseLeft = Math.max(0, G.turnEndsAt - Date.now());
        G.paused = true;
        // watchdog: if they never come back, the turn still ends
        turnTimer = setTimeout(() => endMove(G.turnId), turnPauseLeft + 60000);
        broadcast();
      }
    } else if (m.t === 'resume') {
      const id = clients.get(ws);
      if (G.phase === 'move' && G.turnId === id && G.paused) {
        G.paused = false;
        G.turnEndsAt = Date.now() + turnPauseLeft;
        turnPauseLeft = 0;
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => endMove(G.turnId), Math.max(0, G.turnEndsAt - Date.now()));
        broadcast();
      }
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
    if (!G.players.size && G.phase !== 'lobby') { clearTimeout(turnTimer); newGame(); } // nobody left: back to lobby
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
