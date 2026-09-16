const assert = require('assert');
const mod = require('./server.js');
const { bfsPath, losBlocked, newGame, tick, key } = mod;
// newGame() reassigns state — always read it via mod.G
const G = () => mod.G;

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

// full tick runs, blue spawns every 2 ticks, red every 4
{
  G().obs.clear();
  for (let i = 0; i < 4; i++) tick();
  assert(G().blues.length >= 1, 'blue spawned');
  assert(G().reds.length >= 1, 'red spawned');
}

console.log('ok');
