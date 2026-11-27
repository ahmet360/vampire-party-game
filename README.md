# Vampire Party Game

Vampire is a real-time social deduction game. Create a room, then share its six-character code or invite link. Players use their phones to make private choices and vote. An optional tablet announcer reads phase changes and public outcomes aloud.

- Most living players choose at the same time. Night 1 lasts 50 seconds so everyone can read their role. Later nights last 30 seconds. Living players can vote for one 15-second extension each night. It passes when at least one third of the starting group votes yes, rounded up. If choices are missing at zero, the shared timer goes negative for up to ten seconds and reminds those players to act. The game fills in any remaining choices when overtime ends. Each player's screen covers their choice as soon as they lock it in. Villagers, Mayors and Jesters pick a name as cover.
- Use **View private role** for private role information and special controls. Mayors choose **Reveal as Mayor** and confirm to reveal publicly and gain a second vote. A Hunter can spend their one shot by day or night.
- The host chooses which roles are dealt. Jesters know each other and earn individual wins when voted out. The town wins when every Vampire is gone. The evil team wins if it reaches parity while a Vampire survives.
- A Thief can steal a role once by targeting another player at night. The target’s night move fizzles, and the role changes at the start of the next night if both players survive. A Silencer can block one night move per match. At night, blocks resolve before thefts, and Transporter swaps affect saves, investigations, shots, and kill votes.
- A Seer privately sees which players have roles and gets one exact guess. A correct guess publicly reveals the Seer and the target’s role. A wrong guess eliminates the Seer. Day guesses resolve immediately. Night guesses resolve at dawn.
- Day discussion is untimed. The host selects **Start voting** to open the 90-second ballot. Tap a name to cast a vote or choose **Abstain**. The host can close voting and count the ballots already submitted. A single vote can decide the outcome. The host can configure a draw if one Vampire, one Jester and one Villager each receive one vote.
- The Fogmaster plays for the evil team and can turn the current day vote into a secret ballot on up to three days. Existing votes carry over. The table hides voting progress and announces the outcome when the ballot closes. Once per match, the Fogmaster can privately add one vote to an eligible player during a secret ballot.
- The Nurse plays for the town. They can spend one save to prevent the Vampire attack for the entire night. The Nurse never learns who was attacked, and the save is spent even if the Vampires skip or tie. It stays available if it is blocked.
- The Lookout wins with the Vampires. On even nights the Lookout gets a dedicated final turn after the other choices are locked. The night stays open until the Lookout watches, skips, or the game submits a watch after overtime. The Lookout learns the attempted target at dawn. If a Doctor protects that target, a successful watch redirects the attack once to a random eligible player outside the Vampire team. Other protection can save the new target. A Nurse cancels the entire attack before it can redirect.
- The Usurper wins individually. They can mark 2 players in groups of 5–6, 3 in groups of 7–8, 4 in groups of 9–10, and so on, based on the starting group. The list locks once per match. They must be alive and vote for one of their marks when the town eliminates that player. The match continues and the Usurper’s result stays private until it ends.

## Optional room rules

The **Accuser’s Oath** starts off. The host can assign it to a random player or a selected faction. Holders privately record the first person who accuses them of being a Vampire. Recording at night replaces their night move and shields the accuser that night. Recording by day shields the accuser the following night. Holders cannot vote against or directly harm that person for the rest of the match. An oath becomes public when its holder dies. A living holder can reveal it once the accuser dies or the room reaches one Vampire with four players, two with six, and so on.

The host can also reveal eliminated roles on the roster and forbid Doctors from choosing themselves. Optional end conditions require the Vampire team to outnumber everyone else or end the game in a draw after three consecutive nights without a death.

The room creator hosts automatically. To use the table announcer, open the room’s tablet link or enter the same code at `/table`.

## Practice with bots

Check **Practice room** when creating a room. Use **Add bot** for individual seats or **Set up all 15 roles** to deal one of each role, fill the empty seats and open the tiled practice board. You can also open the board with **Tile bot views**. Open bot views start in manual mode. Select **Auto-play** on any bot you want to hand over to the game. Bots without an open view play automatically. During an open night, taking control of a bot lets you replace its automatic choice before the shared deadline.

During the day, use **Player discussion** to send text to the room. Automatic practice bots can discuss their suspicions, answer when named, and use those opinions when they vote. To use GPT-6 Luna on Low reasoning for dialogue, configure the OpenAI API key as the server's `OPENAI_API_KEY` environment variable. Only public discussion context goes to the model. The built-in bot replies work without a key and cover errors, timeouts, and server-wide request limits. The server limits Luna to 100 requests per UTC day per running instance and two concurrent requests.

## Defining a role’s win

In `game-room.js`, a role’s alignment determines how the Detective reads it. Its outcome separately specifies a team victory or an individual win event. The Fogmaster, Silencer and Lookout share the Vampires’ victory and count toward their parity. The Jester and Usurper can win individually while everyone else keeps playing.

## Run locally

Install Node.js 24 and run `npm ci --omit=dev --ignore-scripts`, then `npm run setup-voice` and `npm start`. Open `http://localhost:3000` to play.

The project uses Express and Socket.IO. The server generates speech locally with the [Piper Lessac](https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/lessac/medium/MODEL_CARD) neural voice and [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx). The Render Blueprint installs the model and creates a free web service.
