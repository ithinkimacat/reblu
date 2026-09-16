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
console.log('ok');
