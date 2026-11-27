# Vampire Party Game

Vampire is a real-time social deduction game. Create a room, then share its six-character code or invite link. Players use their phones to take private turns and vote. An optional tablet view reads turn prompts and phase changes aloud.

- Everyone who is still alive takes a night turn, including villagers. A player's screen covers their choice after they lock it in.
- The table announcer calls players by name and saves role announcements until the whole night has finished.
- The host configures roles, starts the round, and can skip a turn if someone disconnects.
- A villager can watch one player per round and privately learn whether they used a targeted ability that night.
- Night turns have a 25-second clock. During the day the table has 90 seconds to discuss and vote.

The room creator hosts automatically. To use the table announcer, open the room’s tablet link or enter the same code at `/table`.

## Practice with bots

Check **Practice room** when creating a room. Use **Add bot** for individual seats or **Set up all 8 roles** to deal one of each role and fill the empty seats. **Open window** gives the host that bot’s player screen in a separate window. Bots play automatically when their windows are closed. An open bot window starts in manual control and has an **Auto-play** switch for observing.

## Run locally

Install Node.js 24 and run `npm ci --omit=dev --ignore-scripts`, then `npm run setup-voice` and `npm start`. Open `http://localhost:3000` to play.

The project uses Express and Socket.IO. The server generates speech locally with the [Piper Lessac](https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/lessac/medium/MODEL_CARD) neural voice and [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx). The Render Blueprint installs the model and creates a free web service.
