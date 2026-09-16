# reblu

Red chases Blue. Multiplayer grid game about riding dots, dodging blasts, and racing to the finish. Built to demo emergent gameplay.

## Run

```sh
npm i
npm start        # http://localhost:8000
```

Every browser that opens the page joins the same game. Test multiplayer by opening extra tabs (add `?name=yourname` to skip the prompt).

## Play

- Move: **WASD** / **arrow keys** / **Xbox gamepad** (dpad or left stick; **B** clears queue)
- Each tick (~1.8s) you roll a D6 — queue up to that many orthogonal steps before the timer ends. Movement applies when the tick fires.
- Step on a dot: safe passage. **End your move on a dot to ride it.** End on a dot occupied by another player to **push** them 2 cells.
- 🔵 Blue dots crawl toward the finish (2 cells/tick, faster briefly after merging).
- 🔴 Red dots hunt the nearest blue (3 cells/tick). Red + Blue = 💥 blast (3x3 plus a 2-cell tail). Blasts kill — you respawn at start.
- First to reach the 🏁 opposite corner wins.

## Deploy (students over the internet)

Game state lives on the server, so GitHub Pages alone won't work — deploy the Node app:

- **Render**: New Web Service → point at this repo → build `npm i`, start `npm start`. Share the URL.
- **Fly.io / Railway**: same, `npm start`, port from `PORT` env.

One server = one room = one world everyone shares.

## Test

```sh
npm test
```
