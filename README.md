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
- Each turn you roll a D6 — spend that many orthogonal steps before the timer ends.
- Step on a dot: safe passage. **End your move on a dot to ride it.** End on a dot occupied by another player to **push** them 2 cells.
- Blue dots head for the finish. Red dots hunt the nearest reachable blue. Red + Blue = blast (3x3 plus a 2-cell tail). Blasts kill — you respawn near the start.
- Everyone waits in the lobby, tweaks settings, presses Ready; the game starts when all are ready. First to the goal corner wins.

## Deploy (students over the internet)

Game state lives on the server, so GitHub Pages alone won't work — deploy the Node app:

- **Render**: New Web Service → point at this repo → build `npm i`, start `npm start`. Share the URL.
- **Fly.io / Railway**: same, `npm start`, port from `PORT` env.

One server = one room = one world everyone shares.

## Test

```sh
npm test
```
