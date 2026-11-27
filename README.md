# Vampire Party Game

Vampire is a real-time social deduction game. Create a room, then share its six-character code or invite link. Players use their phones to make private choices and vote. An optional tablet announcer reads phase changes and public outcomes aloud.

- All living players can choose at the same time during the same 30-second night. Each player's screen covers their choice as soon as they lock it in. Villagers, Mayors and Jesters pick a name as cover.
- Use **Reveal role** for private role information and special controls. A Mayor can reveal any time during play. A Hunter can spend their one shot by day or night.
- The host chooses which roles are dealt. Jesters know each other and earn individual wins when voted out. The town wins when every Vampire is gone. The evil team wins if it reaches parity while a Vampire survives.
- A Thief can steal a role once by targeting another player at night. The target’s night move fizzles, and the role changes at the start of the next night if both players survive. A Silencer can block one night move per match. At night, blocks resolve before thefts, and Transporter swaps affect saves, investigations, shots, and kill votes.
- A Seer privately sees which players have roles and gets one exact guess. A correct guess publicly reveals the Seer and the target’s role. A wrong guess eliminates the Seer. Day guesses resolve immediately. Night guesses resolve at dawn.
- Day discussion is untimed. The host selects **Start voting** to open the ballot and start its 90-second clock. The host can configure a draw if one Vampire, one Jester and one Villager each receive one vote.
- The Fogmaster plays for the evil team and can turn the current day vote into a secret ballot on up to three days. Existing votes carry over. The table hides voting progress and announces the outcome when the ballot closes. Once per match, the Fogmaster can privately add one vote to an eligible player during a secret ballot.

## Optional custom rule

The **Accuser’s Oath** starts off. The host can assign it to a random player or a selected faction. Holders privately record the first person who accuses them of being a Vampire. Recording at night replaces their night move and shields the accuser that night. Recording by day shields the accuser the following night. Holders cannot vote against or directly harm that person for the rest of the match. An oath becomes public when its holder dies. A living holder can reveal it once the accuser dies or the room reaches one Vampire with four players, two with six, and so on.

The room creator hosts automatically. To use the table announcer, open the room’s tablet link or enter the same code at `/table`.

## Practice with bots

Check **Practice room** when creating a room. Use **Add bot** for individual seats or **Set up all 12 roles** to deal one of each role, fill the empty seats and open the tiled practice board. You can also open the board with **Tile bot views**. Open bot views start in manual mode. Select **Auto-play** on any bot you want to hand over to the game. Bots without an open view play automatically. During an open night, taking control of a bot lets you replace its automatic choice before the shared deadline.

## Defining a role’s win

In `game-room.js`, a role’s alignment determines how the Detective reads it. Its outcome separately specifies a team victory or an individual win event. The Fogmaster and Silencer share the Vampires’ victory and count toward their parity. The Jester earns a personal win on being voted out, and the match continues.

## Run locally

Install Node.js 24 and run `npm ci --omit=dev --ignore-scripts`, then `npm run setup-voice` and `npm start`. Open `http://localhost:3000` to play.

The project uses Express and Socket.IO. The server generates speech locally with the [Piper Lessac](https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/lessac/medium/MODEL_CARD) neural voice and [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx). The Render Blueprint installs the model and creates a free web service.
