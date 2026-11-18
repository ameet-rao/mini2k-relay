# Mini2K relay server

One small Node program (`server.js`, no dependencies) that makes online play work on school wifi:

- **Room codes.** Both screens meet in a room named after the code (replaces ntfy.sh).
- **Game relay.** If the wifi blocks a direct connection, the game itself goes through this server,
  over normal HTTPS (port 443), which schools let through like any web page.
- **The game page.** Opening the server's address loads the online game (`public/index.html`), already
  pointed at the server. Nothing to type in Network settings.

It never reads the messages; it only passes them between the two screens in a room.

## Put it online for free (Render, no card)
1. Put this folder in a GitHub repository (the files `server.js`, `package.json`, `render.yaml` and
   `public/index.html` at the top level).
2. Go to https://render.com, press **Get Started**, sign in with GitHub.
3. **New** > **Web Service** > pick the repository > set **Instance Type: Free** > **Deploy Web Service**.
   (Render reads `render.yaml`: start command `node server.js`, health check `/health`.)
4. After a minute or two it shows an address like `https://mini2k-relay-abcd.onrender.com`.
   Both players open that address and press **Play a friend online**.

The free plan sleeps after 15 minutes with nobody connected. The first visit after that takes about a
minute to wake it; the game says so while it waits.

## Using it from the double-click file instead
Open `mini2k-online.html`, **Play a friend online** > **Network settings** > **Mini2K server address**:
paste the Render address. Both players can do this, or just open the address instead.

## Run it on your own computer (testing)
`node server.js` then open http://localhost:8080 . `PORT=9000 node server.js` for another port.

## Updating the game page
Rebuild with `node tools/build_standalone.mjs --online` and copy `dist/mini2k-online.html` to
`relay/public/index.html`; push, and Render redeploys by itself.

## Limits (in server.js)
4 connections per room, 2 MB per message, 3000 messages per 10 s per connection, 400 connections in all.
Traffic: a full game through the server is a few MB each way, far inside the free plan.
