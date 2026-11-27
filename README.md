# Vampire Party Game

Vampire is a real-time social deduction game for a group around the same table. Players use their phones to take private turns and vote. An optional tablet view reads turn prompts and phase changes aloud.

- Everyone who is still alive takes a night turn, including villagers. A player's screen covers their choice after they lock it in.
- The table announcer calls players by name and saves role announcements until the whole night has finished.
- The host configures roles, starts the round, and can skip a turn if someone disconnects.

The hosted demo has one shared lobby. The friend group can play together when a host starts a round. The table announcer is available at `/table`.

## Run locally

Install Node.js 24, run `npm ci --omit=dev --ignore-scripts`, set `HOST_CODE` in your environment, then run `npm start`. Open `http://localhost:3000` to play.

The project uses Express and Socket.IO. The table voice is generated with [eSpeak NG](https://github.com/espeak-ng/espeak-ng). The Render Blueprint creates a free web service and generates a host code in its environment.
