# reblu

Red chases Blue. Multiplayer grid game about riding dots, dodging blasts, and racing to the finish. Built to demo emergent gameplay.

## Run

```sh
npm i
npm start        # http://localhost:8000
```

Every browser that opens the page joins the same game. Test multiplayer by opening extra tabs (add `?name=abcd` to skip the callsign entry).

## Play

- Move: **WASD** / **arrow keys** / **touch d-pad** / **Xbox gamepad** (dpad or left stick; **B** clears queue)
- Each turn you roll a D6 — spend that many orthogonal steps before the timer ends. Backgrounding the tab mid-turn pauses your timer.
- Step on a dot: safe passage. **End your move on a dot to ride it.** End on a dot occupied by another player to **push** them 2 cells.
- Blue dots head for the finish. Red dots hunt the nearest reachable blue (or a green dot). Red + Blue = blast (3x3 plus a 2-cell tail). Blasts kill — you respawn near the start.
- **Green dots** (off by default — enable in the lobby): static. Anything stepping on one absorbs it and trails green for Trail cells. Blue + green = **Gb** (green body, blue center — moves like a blue), red + green = **Gr** (green body, red center — hunts like a red). Mixed dots never blast: Gb + red becomes Gr, Gr + blue becomes Gb, green floods the whole blast radius, and each green intersection renews the trail countdown.
- **Yellow dots** (off by default): DVD-logo bouncers — move N cells per turn off walls and obstacles, eat every dot they cross. Players are untouched.
- Lobby: pick a hat, tweak settings, press Ready; the game starts when **at least 2 players** are present and all are Ready. First to the goal corner wins.

## Deploy (students over the internet)

Game state lives on the server, so GitHub Pages alone won't work — deploy the Node app:

- **Render**: New Web Service → point at this repo → build `npm i`, start `npm start`. Share the URL.
- **Fly.io / Railway**: same, `npm start`, port from `PORT` env.

One server = one room = one world everyone shares.

## Test

```sh
npm test
```
