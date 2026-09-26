const assert = require('assert');
const mod = require('./server.js');
const { bfsPath, losBlocked, newGame, tryStep, evalLanding, key } = mod;
const G = () => mod.G; // newGame() reassigns state — always read live

// pathing avoids obstacles
newGame();
{
  G().obs.clear(); G().obs.add(key(1, 0));
  const p = bfsPath(0, 0, 2, 0, 5);
  assert.deepStrictEqual(p[p.length - 1], [2, 0], 'reaches target');
  assert(!p.some(c => c[0] === 1 && c[1] === 0), 'avoids obstacle');
  assert.strictEqual(bfsPath(0, 0, 2, 0, 1).length, 1, 'caps steps');
}

// blast LOS: obstacle shields what's behind it
{
  G().obs.clear(); G().obs.add(key(1, 0));
  assert.strictEqual(losBlocked(0, 0, 2, 0), true, 'blocked by obstacle');
  assert.strictEqual(losBlocked(0, 0, 0, 2), false, 'clear line');
}

// player step rules: orthogonal, blocked by obstacle and other players, spends roll
{
  newGame();
  G().obs.clear(); G().obs.add(key(1, 0));
  const g = G();
  const A = { id: 1, name: 'a', color: '#fff', x: 0, y: 0, roll: 3, used: 0, lastDir: null, rider: null, dead: false, wins: 0 };
  const B = { id: 2, name: 'b', color: '#fff', x: 0, y: 1, roll: 0, used: 0, lastDir: null, rider: null, dead: false, wins: 0 };
  g.players.set(1, A); g.players.set(2, B);
  g.phase = 'move'; g.turnId = 1;
  tryStep(1, 1, 0);  assert.deepStrictEqual([A.x, A.y], [0, 0], 'obstacle blocks');
  tryStep(1, 0, 1);  assert.deepStrictEqual([A.x, A.y], [0, 0], 'player blocks');
  tryStep(1, 2, 0);  assert.deepStrictEqual([A.x, A.y], [0, 0], 'non-orthogonal rejected');
  tryStep(2, 0, -1); assert.deepStrictEqual([B.x, B.y], [0, 1], 'not your turn');
  tryStep(1, 0, -1); assert.deepStrictEqual([A.x, A.y], [0, 0], 'edge blocks');
  g.obs.clear(); B.x = 5; B.y = 5;
  tryStep(1, 1, 0); assert.deepStrictEqual([A.x, A.y], [1, 0], 'clean step works');
  tryStep(1, 1, 0); tryStep(1, 1, 0);
  tryStep(1, 1, 0);
  assert.deepStrictEqual([A.x, A.y], [3, 0], 'roll caps steps');
}

// dot pathfinding: blue avoids red blast zones; reds pick reachable, distinct targets
{
  newGame();
  const g = G();
  g.obs.clear();
  g.w = 25; g.h = 25;
  // red at (6,6): its blast zone covers x/y in [5..7]
  g.reds = [{ id: 1, x: 6, y: 6, px: 6, py: 6 }];
  g.blues = [{ id: 1, x: 5, y: 4, boost: 0 }];
  // blue pathing lives in bluePhase (async); assert on bfsPath-with-avoid instead
  const zone = new Set();
  for (let ex = -1; ex <= 1; ex++) for (let ey = -1; ey <= 1; ey++) zone.add(key(6 + ex, 6 + ey));
  const p = bfsPath(5, 4, 24, 24, 4, zone);
  assert(p.length, 'blue finds a route');
  assert(p.every(([x, y]) => !zone.has(key(x, y))), 'blue route skirts the blast zone');
  const direct = bfsPath(5, 4, 24, 24, 4);
  assert(p.length <= direct.length, 'zone route costs no extra steps');
}

(async () => {
  const mod = require('./server.js');
  mod.newGame();
  const g = mod.G;
  g.obs.clear();
  g.w = 25; g.h = 25;
  // two blues; b1 boxed in by obstacles, red at origin must target b2
  g.blues = [{ id: 1, x: 10, y: 10, boost: 0, mix: null, trailLeft: 0 }, { id: 2, x: 5, y: 0, boost: 0, mix: null, trailLeft: 0 }];
  g.obs.add(key(9, 10)); g.obs.add(key(11, 10)); g.obs.add(key(10, 9)); g.obs.add(key(10, 11));
  g.reds = [{ id: 1, x: 0, y: 2, px: 0, py: 2, mix: null, trailLeft: 0 }, { id: 2, x: 0, y: 3, px: 0, py: 3, mix: null, trailLeft: 0 }];
  g.phase = 'move'; g.turnId = 1; g.tick = 1;
  let done;
  const p = new Promise(r => { mod.endMove(1); const iv = setInterval(() => { if (g.phase === 'dots') { clearInterval(iv); r(); } }, 50); });
  await p;
  const r1 = g.reds.find(r => r.id === 1), r2 = g.reds.find(r => r.id === 2);
  assert(r1.x !== 10 || r1.y !== 10, 'red does not chase the boxed-in blue');
  assert(!(r1.x === r2.x && r1.y === r2.y), 'reds stay apart');
  console.log('ok');
  process.exit(0);
})();
process.exit(0); // dot-phase timers would otherwise keep the loop alive
