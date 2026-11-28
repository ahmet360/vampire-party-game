const assert = require("node:assert/strict");
const test = require("node:test");
const { createRoom } = require("../game-room");
const { createGeminiBot } = require("../gemini-bot");
const FIRST_NIGHT = 20800;

function cast(send, player, targetId, ballotKey = player.state.ballotKey) {
  let result;
  const choice = targetId === null ? { abstain: true } : { targetId };
  send(player, "vote", { ...choice, ballotKey }, (error) => { result = error; });
  return result;
}

function roomFixture(t, practice = true, hostAi = null) {
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to: (id) => ({ emit: (...args) => sockets.get(id)?.emit(...args) }),
  };
  const room = createRoom(io, "SAMPLE", "host-session", { night: 800, day: 1200 }, practice, hostAi);
  t.after(() => room.dispose());

  function newSocket(id) {
    const socket = { id, data: {}, received: 0, emit(event, data) { this[event] = data; this.received += 1; } };
    sockets.set(id, socket);
    return socket;
  }

  const host = newSocket("host");
  room.join(host, "host-session", "Tester");
  return { room, host, newSocket, send: (socket, event, ...args) => room.handlers[event](socket, ...args) };
}

function gameFixture(t, roles, rules = {}) {
  const { room, host, newSocket, send } = roomFixture(t, false);
  const players = [host];
  for (let index = 1; index < roles.length; index += 1) {
    const player = newSocket(`player-${index}`);
    room.join(player, `session-${index}`, `Player ${index}`);
    players.push(player);
  }
  const counts = new Map();
  for (const role of roles) counts.set(role, (counts.get(role) || 0) + 1);
  for (const [role, count] of counts) send(host, "updateConfig", { role, enabled: true, count });
  send(host, "updateConfig", { vampireCanSkip: true, ...rules });
  send(host, "startGame");
  assert.equal(host.state.phase, "night");
  const find = (role) => players.find((player) => player.state.me.role === role);
  return { room, host, players, find, newSocket, send };
}

function id(player) {
  return player.state.me.id;
}

function startVoting(send, host) {
  send(host, "startVoting", host.state.dayNumber);
  assert.equal(host.state.votingOpen, true);
}

function pick(send, player, payload, expected = null) {
  let result;
  send(player, "nightAction", { nightKey: player.state.nightKey, ...payload }, (error) => { result = error; });
  if (expected) assert.match(result, expected);
  else assert.equal(result, null);
}

function guess(send, player, target, role, expected = null) {
  let result;
  send(player, "seerGuess", { targetId: id(target), guess: role, nightKey: player.state.nightKey }, (error) => { result = error; });
  if (expected) assert.match(result, expected);
  else assert.equal(result, null);
}

test("only the practice host receives bot access and a bot gets its own role", (t) => {
  const { room, host, newSocket, send } = roomFixture(t);
  const guest = newSocket("guest");
  room.join(guest, "guest-session", "Friend");
  send(guest, "addBot");
  assert.equal(host.state.bots.length, 0);
  assert.equal(guest.state.bots, undefined);

  send(host, "addBot");
  const removed = host.state.bots[0];
  send(host, "removeBot", removed.id);
  assert.equal(room.joinBot(newSocket("removed"), removed.token), false);

  send(host, "setUpAllRoles");
  const roleCount = host.state.roleOrder.length;
  assert.equal(host.state.playerCount, roleCount);
  assert.equal(host.state.bots.length, roleCount - 2);
  assert.equal(host.state.selectedRoleCount, roleCount);
  const bot = host.state.bots[0];
  const botWindow = newSocket("bot");
  assert.equal(room.joinBot(botWindow, bot.id), false);
  assert.equal(room.joinBot(botWindow, bot.token), true);
  const hostId = host.state.me.id;
  const tiled = newSocket("tile");
  assert.equal(room.joinBot(tiled, host.state.bots[1].token), true);
  assert.equal(tiled.state.me.botAuto, false);
  assert.equal(botWindow.state.me.botAuto, false);
  send(host, "startGame");

  const dealt = [host.state.me.role, guest.state.me.role, ...host.state.bots.map(({ role }) => role)];
  assert.deepEqual(dealt.sort(), [...host.state.roleOrder].sort());
  assert.equal(botWindow.state.me.id, bot.id);
  assert.equal(botWindow.state.me.role, host.state.bots.find(({ id }) => id === bot.id).role);
  assert.equal(botWindow.state.bots, undefined);
  assert.equal(guest.state.bots, undefined);
  assert.ok(guest.state.players.every(({ role }) => role === null));
  assert.equal(host.state.me.id, hostId);

  room.leave(host, true);
  assert.equal(guest.state.me.isHost, true);
  assert.match(botWindow.roomLeft, /access changed/);
  assert.equal(room.joinBot(newSocket("old-token"), bot.token), false);
  assert.equal(room.joinBot(newSocket("new-token"), guest.state.bots[0].token), true);
});

test("manual bots can sit out while attached and resume automatic choices on disconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = roomFixture(t);
  for (let i = 0; i < 3; i += 1) send(host, "addBot");
  send(host, "updateConfig", { vampireCanSkip: true });
  send(host, "startGame");

  const vampire = host.state.bots.find(({ role }) => role === "Vampire");
  const vampireWindow = vampire ? newSocket("vampire") : host;
  if (vampire) assert.equal(room.joinBot(vampireWindow, vampire.token), true);
  const villager = host.state.bots.find(({ role }) => role === "Villager");
  const botWindow = newSocket("villager");
  assert.equal(room.joinBot(botWindow, villager.token), true);

  pick(send, vampireWindow, { skip: true });
  const hostEvents = host.received;
  t.mock.timers.tick(4000);
  assert.equal(botWindow.state.me.nightComplete, false);
  assert.equal(host.received, hostEvents);
  room.leave(botWindow, false);
  assert.equal(host.state.bots.find(({ id }) => id === villager.id).automatic, true);
  t.mock.timers.tick(4000);

  const reopened = newSocket("reopened");
  assert.equal(room.joinBot(reopened, villager.token), true);
  assert.equal(reopened.state.me.nightComplete, false);
  assert.equal(reopened.state.me.botAuto, false);
  assert.deepEqual(reopened.state.me.privateMessages, []);
  assert.equal(host.state.phase, "night");
  if (host !== vampireWindow) pick(send, host, { skip: true });
  pick(send, reopened, { skip: true });
  t.mock.timers.tick(FIRST_NIGHT - 8000);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.aliveCount, 4);

  send(vampireWindow, "setBotAuto", true);
  send(reopened, "setBotAuto", true);
  t.mock.timers.tick(2000);
  assert.equal(host.state.votesCast, 0);
  assert.equal(host.state.clock, null);
  startVoting(send, host);
  t.mock.timers.tick(600);
  assert.equal(host.state.votesCast, 3);
  cast(send, host, villager.id);
  assert.notEqual(host.state.phase, "day");
});

test("a regular room cannot add bots", (t) => {
  const { room, host, newSocket, send } = roomFixture(t, false);
  send(host, "addBot");
  send(host, "setUpAllRoles");
  assert.equal(host.state.bots, undefined);
  assert.equal(host.state.playerCount, 1);
  assert.equal(room.joinBot(newSocket("bot"), "00000000-0000-0000-0000-000000000000"), false);
});

test("taking over during night replaces automatic choices without changing the shared clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = roomFixture(t);
  for (let i = 0; i < 3; i += 1) send(host, "addBot");
  send(host, "updateConfig", { vampireCanSkip: true });
  const [first, second] = host.state.bots;
  const firstTile = newSocket("first-tile");
  const secondTile = newSocket("second-tile");
  assert.equal(room.joinBot(firstTile, first.token), true);
  assert.equal(room.joinBot(secondTile, second.token), true);
  send(firstTile, "setBotAuto", true);
  send(secondTile, "setBotAuto", true);
  send(host, "startGame");
  const sharedClock = host.state.clock;
  t.mock.timers.tick(4000);
  assert.equal(host.state.me.nightComplete, false);
  assert.equal(firstTile.state.me.nightComplete, true);
  assert.equal(secondTile.state.me.nightComplete, true);

  send(firstTile, "setBotAuto", false);
  const secondWindow = newSocket("second-window");
  assert.equal(room.joinBot(secondWindow, second.token), true);
  assert.equal(secondWindow.state.me.botAuto, true);
  assert.equal(secondWindow.state.me.nightComplete, true);
  send(secondWindow, "setBotAuto", false);
  assert.equal(firstTile.state.me.nightComplete, false);
  assert.equal(secondWindow.state.me.nightComplete, false);
  assert.equal(firstTile.state.clock, sharedClock);
  assert.equal(secondWindow.state.clock, sharedClock);

  pick(send, secondWindow, { skip: true });
  pick(send, firstTile, { skip: true });
  assert.equal(host.state.me.nightComplete, false);
  assert.equal(secondWindow.state.me.nightComplete, true);
  send(firstTile, "setBotAuto", true);
  send(firstTile, "setBotAuto", false);
  assert.equal(firstTile.state.me.nightComplete, true);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(FIRST_NIGHT - 4000 + 10000);
  assert.equal(host.state.phase, "day");
});

test("every open practice tile stays manual across automatic bot timing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = roomFixture(t);
  send(host, "setUpAllRoles");
  send(host, "updateConfig", { vampireCanSkip: true });
  const tiles = host.state.bots.map(({ token }, index) => {
    const tile = newSocket(`tile-${index}`);
    assert.equal(room.joinBot(tile, token), true);
    return tile;
  });
  send(host, "startGame");
  pick(send, tiles[0], { skip: true });
  t.mock.timers.tick(FIRST_NIGHT - 80);
  assert.equal(tiles[0].state.me.nightComplete, true);
  for (const actor of [host, ...tiles.slice(1)]) {
    assert.equal(actor.state.me.botAuto, false);
    assert.equal(actor.state.me.nightComplete, false);
    assert.equal(actor.state.clock, host.state.clock);
  }
  pick(send, tiles[1], { skip: true });
  pick(send, tiles[2], { skip: true });
  assert.equal(tiles[3].state.me.nightComplete, false);
  t.mock.timers.tick(80);
  assert.equal(host.state.phase, "night");
  assert.ok(host.state.clock.overtimeUntil);
  for (const actor of [host, ...tiles.slice(3)]) pick(send, actor, { skip: true });
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.clock, null);
});

test("discussion stays open for an hour and only the host can start voting once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, players, find, send } = gameFixture(t, ["Vampire", "Mayor", "Villager", "Villager", "Villager"]);
  const mayor = find("Mayor");
  const villager = find("Villager");
  const vampire = find("Vampire");
  send(host, "startVoting", 0);
  assert.equal(host.state.phase, "night");
  for (const player of players) pick(send, player, { skip: true });
  t.mock.timers.tick(FIRST_NIGHT);
  assert.equal(host.state.votingOpen, false);
  assert.equal(room.buildTableState().clock, null);
  send(players[1], "startVoting", 1);
  send(host, "startVoting", 0);
  send(host, "resolveVotes");
  cast(send, villager, id(vampire));
  assert.equal(villager.state.me.dayVoteTarget, null);
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(host.state.dayNumber, 1);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.clock, null);
  assert.equal(room.buildTableState().votingOpen, false);
  assert.equal(host.state.votesCast, 0);
  send(mayor, "revealMayor");
  assert.equal(mayor.state.me.mayorRevealed, true);

  const startedAt = Date.now();
  startVoting(send, host);
  const clock = host.state.clock;
  assert.equal(clock.deadline, startedAt + 1200);
  assert.equal(room.buildTableState().clock, clock);
  t.mock.timers.tick(100);
  startVoting(send, host);
  assert.equal(host.state.clock, clock);
  assert.equal(room.buildTableState().cues.filter(({ text }) => text.startsWith("Voting is open")).length, 1);
  cast(send, villager, id(vampire));
  t.mock.timers.tick(1100);
  assert.equal(host.state.gameOver.winner, "Villagers");
});

test("a replacement host can open discussion voting, and voting can be skipped", (t) => {
  const { room, host, players, send } = gameFixture(t, ["Vampire", "Villager", "Villager", "Villager"]);
  send(host, "resolveNight");
  const replacement = players[1];
  room.leave(host, true);
  assert.equal(replacement.state.me.isHost, true);
  send(host, "startVoting", 1);
  assert.equal(replacement.state.votingOpen, false);
  send(replacement, "forceSleep");
  assert.equal(replacement.state.phase, "night");
  send(replacement, "resolveNight");
  assert.equal(replacement.state.dayNumber, 2);
  send(replacement, "startVoting", 1);
  assert.equal(replacement.state.votingOpen, false);
  startVoting(send, replacement);
  send(replacement, "resolveVotes");
  assert.equal(replacement.state.phase, "night");
  assert.equal(replacement.state.votingOpen, false);
});

test("night choices share one deadline and stay private until they resolve", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, players, find, send } = gameFixture(t, ["Vampire", "Doctor", "Mayor", "Villager", "Detective"]);
  const vampire = find("Vampire");
  const doctor = find("Doctor");
  const mayor = find("Mayor");
  const villager = find("Villager");
  const detective = find("Detective");
  assert.ok(players.every(({ state }) => state.nightKey === host.state.nightKey && state.clock.deadline === 1000 + FIRST_NIGHT));
  const board = room.buildTableState();
  assert.equal(board.cues.length, 1);
  assert.match(board.cues[0].text, /read your role/);
  assert.equal(board.nightTurn, undefined);

  const outsiderEvents = mayor.received;
  pick(send, detective, { targetId: id(vampire) });
  pick(send, villager, { targetId: id(vampire) });
  pick(send, vampire, { targetId: id(villager), nightKey: "stale" }, /closed/);
  pick(send, vampire, { targetId: id(villager) });
  pick(send, doctor, { targetId: id(villager) });
  pick(send, doctor, { targetId: id(mayor) }, /already locked/);
  assert.equal(mayor.received, outsiderEvents);
  assert.deepEqual(room.buildTableState().cues, board.cues);
  send(mayor, "revealMayor");
  pick(send, mayor, { targetId: id(vampire) });
  assert.ok(host.state.players.find(({ id: playerId }) => playerId === id(mayor)).mayorRevealed);
  t.mock.timers.tick(FIRST_NIGHT - 1);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(1);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.aliveCount, players.length);
  assert.deepEqual(villager.state.me.privateMessages, []);
  assert.match(detective.state.me.privateMessages[0].text, /seems suspicious/);
  pick(send, vampire, { targetId: id(villager) }, /closed/);
});

test("the Silencer resets a blocked Doctor’s consecutive-save restriction", (t) => {
  const { host, find, send } = gameFixture(t, ["Vampire", "Silencer", "Doctor", "Villager", "Villager", "Villager"]);
  const doctor = find("Doctor");
  const silencer = find("Silencer");
  const vampire = find("Vampire");
  assert.deepEqual(vampire.state.me.knownPlayers, [{ name: silencer.state.me.name, role: "Silencer" }]);
  assert.deepEqual(silencer.state.me.knownPlayers, []);
  pick(send, doctor, { targetId: id(doctor) });
  pick(send, vampire, { targetId: id(doctor) });
  send(host, "resolveNight");
  assert.ok(doctor.state.me.alive);

  send(host, "forceSleep");
  assert.equal(doctor.state.me.doctorLastSave, id(doctor));
  pick(send, doctor, { targetId: id(doctor) }, /available/);
  pick(send, doctor, { targetId: id(vampire) });
  pick(send, silencer, { targetId: id(doctor) });
  send(host, "resolveNight");
  assert.match(doctor.state.me.privateMessages.at(-1).text, /blocked/);
  assert.ok(silencer.state.me.abilityUsed);
  send(host, "forceSleep");
  assert.equal(doctor.state.me.doctorLastSave, null);
  pick(send, doctor, { targetId: id(doctor) });
});

test("a Thief fizzles the old ability and takes the role the following night", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Thief", "Thief", "Villager", "Villager", "Villager"]);
  const [thief, otherThief] = players.filter(({ state }) => state.me.role === "Thief");
  const vampire = find("Vampire");
  const villager = find("Villager");
  send(host, "resolveNight");
  send(host, "forceSleep");
  pick(send, thief, { targetId: id(vampire) });
  pick(send, otherThief, { targetId: id(villager) });
  pick(send, vampire, { targetId: id(thief) });
  send(host, "resolveNight");
  assert.equal(host.state.aliveCount, players.length);
  assert.equal(vampire.state.me.role, "Vampire");
  assert.equal(thief.state.me.role, "Thief");
  assert.deepEqual(thief.state.me.privateMessages, []);
  send(host, "forceSleep");
  assert.equal(vampire.state.me.role, "Villager");
  assert.equal(thief.state.me.role, "Vampire");
  assert.equal(otherThief.state.me.role, "Villager");
  assert.match(vampire.state.me.privateMessages.at(-1).text, /now a Villager/);
  assert.match(thief.state.me.privateMessages.at(-1).text, /new role is Vampire/);
  assert.match(otherThief.state.me.privateMessages.at(-1).text, /new role is Villager/);
});

test("Jesters know each other but each earns their own win", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Jester", "Jester", "Villager", "Villager", "Villager"]);
  const [first, second] = players.filter(({ state }) => state.me.role === "Jester");
  const vampire = find("Vampire");
  const villager = find("Villager");
  assert.deepEqual(first.state.me.knownPlayers, [{ name: second.state.me.name, role: "Jester" }]);
  assert.deepEqual(vampire.state.me.knownPlayers, []);
  send(host, "resolveNight");
  const eliminateWithVotes = (target) => {
    startVoting(send, host);
    for (const player of players.filter(({ state }) => state.me.alive)) {
      cast(send, player, id(player === target ? villager : target));
    }
  };
  eliminateWithVotes(first);
  assert.equal(host.state.phase, "night");
  assert.equal(host.state.players.find((player) => player.id === id(first)).personalWin, "Jester");
  assert.equal(host.state.players.find((player) => player.id === id(second)).personalWin, null);
  send(host, "resolveNight");
  eliminateWithVotes(second);
  send(host, "resolveNight");
  eliminateWithVotes(vampire);
  assert.equal(host.state.gameOver.winner, "Villagers");
  assert.equal(host.state.gameOver.finalRoles.filter(({ role, won }) => role === "Jester" && won).length, 2);
});

test("Vampire allies share the team victory and only successful Jesters win alongside them", (t) => {
  const { host, players, find, send } = gameFixture(t,
    ["Vampire", "Silencer", "Fogmaster", "Jester", "Jester", "Villager", "Villager", "Villager"]);
  const [winningJester, otherJester] = players.filter(({ state }) => state.me.role === "Jester");
  const vampire = find("Vampire");
  const villager = find("Villager");
  assert.equal(host.state.roleWinGoals.Fogmaster, "Wins with Vampires");
  assert.equal(host.state.roleWinGoals.Jester, "Personal goal");
  send(host, "resolveNight");
  startVoting(send, host);
  for (const player of players) cast(send, player, id(player === winningJester ? villager : winningJester));
  pick(send, vampire, { targetId: id(villager) });
  send(host, "resolveNight");
  assert.equal(host.state.gameOver.winner, "Vampires");
  const results = host.state.gameOver.finalRoles;
  assert.equal(results.find(({ name }) => name === winningJester.state.me.name).won, true);
  assert.equal(results.find(({ name }) => name === otherJester.state.me.name).won, false);
  assert.deepEqual(results.filter(({ won, role }) => won && role !== "Jester").map(({ role }) => role).sort(),
    ["Fogmaster", "Silencer", "Vampire"]);
});

for (const deadlockDraw of [true, false]) {
  test(`the three-way deadlock follows the room setting (${deadlockDraw})`, (t) => {
    const { host, find, send } = gameFixture(t, ["Vampire", "Jester", "Villager"], { deadlockDraw });
    const vampire = find("Vampire");
    const jester = find("Jester");
    const villager = find("Villager");
    send(host, "resolveNight");
    startVoting(send, host);
    cast(send, vampire, id(villager));
    cast(send, jester, id(vampire));
    cast(send, villager, id(jester));
    assert.equal(host.state.phase, deadlockDraw ? "gameover" : "night");
    assert.equal(host.state.gameOver?.winner, deadlockDraw ? "Draw" : undefined);
  });
}

test("daytime Hunter shots use the same charge as night shots", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Vampire", "Hunter", "Villager", "Villager", "Villager", "Villager"]);
  const hunter = find("Hunter");
  const [first, second] = players.filter(({ state }) => state.me.role === "Vampire");
  send(host, "resolveNight");
  send(hunter, "hunterShot", id(first));
  assert.ok(hunter.state.me.alive && hunter.state.me.abilityUsed);
  assert.equal(first.state.me.alive, false);
  send(hunter, "hunterShot", id(second));
  assert.equal(second.state.me.alive, true);
  send(host, "forceSleep");
  pick(send, hunter, { targetId: id(second) });
  send(host, "resolveNight");
  assert.equal(second.state.me.alive, true);
});

test("the Oath binds the accuser, shields them and unlocks public reveal after their death", (t) => {
  const { host, find, players, send } = gameFixture(t,
    ["Vampire", "Jester", "Hunter", "Villager", "Villager", "Villager", "Villager"], { oathMode: "random-town" });
  const holder = players.find(({ state }) => state.me.oath);
  const vampire = find("Vampire");
  const hunter = find("Hunter");
  const accuser = players.find((player) => player !== holder && player.state.me.role === "Villager");
  assert.equal(holder.state.roleAlignments[holder.state.me.role], "Town");
  assert.equal(holder.state.me.oath.canReveal, false);
  pick(send, holder, { oath: true, targetId: id(accuser) });
  pick(send, vampire, { targetId: id(accuser) });
  send(host, "resolveNight");
  assert.ok(accuser.state.me.alive);
  startVoting(send, host);
  cast(send, holder, id(accuser));
  assert.equal(holder.state.me.dayVoteTarget, null);
  if (holder !== hunter) {
    send(hunter, "hunterShot", id(accuser));
  } else {
    for (const player of players.filter((player) => player !== holder && player !== accuser)) {
      cast(send, player, id(accuser));
    }
    send(host, "resolveVotes");
  }
  assert.equal(accuser.state.me.alive, false);
  assert.equal(holder.state.me.oath.canReveal, true);
  send(holder, "revealOath");
  assert.match(host.state.messages.at(-1).text, /vowed to protect/);
});

test("the Oath reveal unlocks at the requested living-player gap", (t) => {
  const { host, find, players, send } = gameFixture(t,
    ["Vampire", "Vampire", "Villager", "Villager", "Villager", "Villager", "Villager"], { oathMode: "town" });
  const vampire = find("Vampire");
  const [target, holder] = players.filter(({ state }) => state.me.role === "Villager");
  assert.equal(holder.state.me.oath.canReveal, false);
  pick(send, vampire, { targetId: id(target) });
  send(host, "resolveNight");
  assert.equal(holder.state.aliveCount, 6);
  assert.equal(holder.state.me.oath.canReveal, true);
});

test("Seer indicators stay private, exact guesses reveal once, and a wrong guess kills", (t) => {
  const { room, host, players, find, send } = gameFixture(t,
    ["Vampire", "Doctor", "Silencer", "Seer", "Seer", "Villager", "Villager", "Villager"]);
  const [first, second] = players.filter(({ state }) => state.me.role === "Seer");
  const vampire = find("Vampire");
  const villager = find("Villager");
  const doctor = find("Doctor");
  assert.ok(first.state.me.seerTargets.includes(id(vampire)));
  assert.ok(first.state.me.seerTargets.includes(id(doctor)));
  assert.ok(!first.state.me.seerTargets.includes(id(villager)));
  assert.deepEqual(villager.state.me.seerTargets, []);
  assert.ok(first.state.players.every(({ role }) => role === null));
  send(host, "resolveNight");
  guess(send, first, villager, "Doctor", /highlighted/);
  guess(send, first, vampire, "Vampire");
  assert.equal(villager.state.players.find((player) => player.id === id(vampire)).publicRole, "Vampire");
  assert.equal(villager.state.players.find((player) => player.id === id(first)).publicRole, "Seer");
  assert.match(first.state.me.privateMessages.at(-1).text, /You cannot say these players have a role/);
  assert.ok(first.state.me.privateMessages.at(-1).text.includes(doctor.state.me.name));
  assert.ok(room.buildTableState().cues.some(({ text }) => text.includes("is the Seer")));
  guess(send, first, doctor, "Doctor", /no longer available/);
  guess(send, second, doctor, "Vampire");
  assert.equal(second.state.me.alive, false);
  assert.equal(villager.state.players.find((player) => player.id === id(second)).publicRole, null);
});

test("night Seer guesses wait until dawn and can be blocked", (t) => {
  const { host, find, send } = gameFixture(t, ["Vampire", "Seer", "Silencer", "Villager", "Villager", "Villager"]);
  const seer = find("Seer");
  const silencer = find("Silencer");
  const vampire = find("Vampire");
  guess(send, seer, vampire, "Vampire");
  assert.equal(seer.state.me.seerGuessPending, true);
  assert.ok(host.state.players.every(({ publicRole }) => publicRole === null));
  pick(send, silencer, { targetId: id(seer) });
  send(host, "resolveNight");
  assert.equal(seer.state.me.abilityUsed, false);
  assert.match(seer.state.me.privateMessages.at(-1).text, /blocked/);
  send(host, "forceSleep");
  guess(send, seer, vampire, "Silencer");
  send(host, "resolveNight");
  assert.equal(seer.state.me.alive, false);
});

function useFog(send, player, event, payload = {}) {
  let result;
  send(player, event, { dayNumber: player.state.dayNumber, ...payload }, (error) => { result = error; });
  return result;
}

test("the Fogmaster can open three secret ballots and use one private boost per match", (t) => {
  const { room, host, find, send } = gameFixture(t, ["Vampire", "Fogmaster", "Villager", "Villager", "Villager"]);
  const fog = find("Fogmaster");
  const vampire = find("Vampire");
  const villager = find("Villager");
  assert.equal(fog.state.roleAlignments.Fogmaster, "Evil");
  assert.ok(vampire.state.me.knownPlayers.some(({ role }) => role === "Fogmaster"));
  assert.match(useFog(send, fog, "openSecretBallot"), /unavailable/);

  send(host, "resolveNight");
  assert.match(useFog(send, fog, "openSecretBallot"), /unavailable/);
  startVoting(send, host);
  cast(send, villager, id(vampire));
  assert.equal(room.buildTableState().votesCast, 1);
  assert.match(useFog(send, villager, "openSecretBallot"), /unavailable/);
  assert.match(useFog(send, fog, "openSecretBallot", { dayNumber: 0 }), /unavailable/);
  assert.match(useFog(send, fog, "boostFogVote", { targetId: id(vampire) }), /during a secret ballot/);
  assert.equal(useFog(send, fog, "openSecretBallot"), null);
  assert.equal(fog.state.me.fogmaster.ballotsLeft, 2);
  assert.equal(villager.state.me.dayVoteTarget, id(vampire));
  assert.equal(villager.state.me.fogmaster, null);
  assert.equal(villager.state.votesCast, null);
  assert.equal(room.buildTableState().votesCast, null);
  assert.match(room.buildTableState().cues.at(-1).text, /^A secret ballot is open/);
  assert.match(useFog(send, fog, "openSecretBallot"), /already open/);

  const received = villager.received;
  cast(send, vampire, id(fog));
  assert.equal(villager.received, received);
  assert.match(useFog(send, fog, "boostFogVote", { targetId: id(fog) }), /available player/);
  assert.equal(useFog(send, fog, "boostFogVote", { targetId: id(vampire) }), null);
  assert.equal(fog.state.me.fogmaster.boostTargetId, id(vampire));
  assert.equal(villager.received, received);
  assert.match(useFog(send, fog, "boostFogVote", { targetId: id(villager) }), /already used/);

  for (let day = 2; day <= 3; day += 1) {
    send(host, "forceSleep");
    send(host, "resolveNight");
    startVoting(send, host);
    assert.equal(useFog(send, fog, "openSecretBallot"), null);
    assert.equal(fog.state.me.fogmaster.ballotsLeft, 3 - day);
    assert.equal(fog.state.me.fogmaster.boostTargetId, null);
    assert.match(useFog(send, fog, "boostFogVote", { targetId: id(villager) }), /already used/);
  }
  send(host, "forceSleep");
  send(host, "resolveNight");
  assert.equal(room.buildTableState().secretBallot, false);
  startVoting(send, host);
  assert.match(useFog(send, fog, "openSecretBallot"), /all three/);
  send(host, "resetGame");
  send(host, "startGame");
  assert.deepEqual(find("Fogmaster").state.me.fogmaster, { ballotsLeft: 3, boostUsed: false, boostTargetId: null });
});

test("a secret ballot stays open until the deadline and the Fogmaster’s bonus breaks a tie", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { host, players, find, send } = gameFixture(t,
    ["Vampire", "Fogmaster", "Villager", "Villager", "Villager", "Villager"]);
  const vampire = find("Vampire");
  const fog = find("Fogmaster");
  const [first, second, third, fourth] = players.filter(({ state }) => state.me.role === "Villager");
  send(host, "resolveNight");
  startVoting(send, host);
  assert.equal(useFog(send, fog, "openSecretBallot"), null);
  for (const player of [vampire, fog, second]) cast(send, player, id(first));
  for (const player of [first, third, fourth]) cast(send, player, id(vampire));
  assert.equal(host.state.phase, "day");
  assert.equal(useFog(send, fog, "boostFogVote", { targetId: id(vampire) }), null);
  t.mock.timers.tick(1199);
  assert.equal(host.state.phase, "day");
  t.mock.timers.tick(1);
  assert.equal(vampire.state.me.alive, false);
  assert.equal(first.state.me.alive, true);
  assert.equal(host.state.gameOver.winner, "Villagers");
  assert.ok(host.state.messages.every(({ text }) => !text.includes("+1") && !text.includes("Fogmaster")));
});

test("a Thief inherits the Fogmaster’s remaining charges", (t) => {
  const { host, find, send } = gameFixture(t,
    ["Vampire", "Fogmaster", "Thief", "Villager", "Villager", "Villager"]);
  const fog = find("Fogmaster");
  const thief = find("Thief");
  send(host, "resolveNight");
  startVoting(send, host);
  assert.equal(useFog(send, fog, "openSecretBallot"), null);
  assert.equal(useFog(send, fog, "boostFogVote", { targetId: id(thief) }), null);
  send(host, "forceSleep");
  pick(send, thief, { targetId: id(fog) });
  send(host, "resolveNight");
  send(host, "forceSleep");
  assert.equal(thief.state.me.role, "Fogmaster");
  assert.deepEqual(thief.state.me.fogmaster, { ballotsLeft: 2, boostUsed: true, boostTargetId: null });
  assert.equal(fog.state.me.fogmaster, null);
});

test("a third of the starting table can extend a night once without unlocking actions", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, players, newSocket, send } = gameFixture(t, ["Vampire", ...Array(6).fill("Villager")]);
  const original = host.state.clock;
  const firstNight = host.state.nightKey;
  assert.equal(original.duration, FIRST_NIGHT);
  assert.equal(host.state.me.nightExtension.required, 3);
  pick(send, host, { skip: true });
  send(host, "voteNightExtension", "previous-night");
  assert.equal(host.state.me.nightExtension.votes, 0);
  send(host, "voteNightExtension", firstNight);
  send(host, "voteNightExtension", firstNight);
  send(players[1], "voteNightExtension", firstNight);
  room.leave(players[1], false);
  const rejoined = newSocket("rejoined");
  room.join(rejoined, "session-1", "Player 1");
  assert.equal(rejoined.state.me.nightExtension.voted, true);
  assert.equal(rejoined.state.me.nightExtension.votes, 2);
  assert.equal(host.state.clock, original);

  t.mock.timers.tick(FIRST_NIGHT - 1);
  send(players[2], "voteNightExtension", firstNight);
  const extended = host.state.clock;
  assert.equal(extended.deadline, original.deadline + 15000);
  assert.equal(extended.duration, original.duration + 15000);
  assert.deepEqual(room.buildTableState().clock, extended);
  assert.ok(host.state.me.nightComplete);
  assert.ok(!players[2].state.me.nightComplete);
  for (const player of [rejoined, ...players.slice(2)]) pick(send, player, { skip: true });
  send(players[3], "voteNightExtension", firstNight);
  assert.equal(host.state.clock, extended);
  assert.equal(room.buildTableState().cues.filter(({ text }) => text.includes("added 15 seconds")).length, 1);
  t.mock.timers.tick(15000);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(1);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.clock, null);
  send(host, "forceSleep");
  assert.equal(host.state.clock.duration, 800);
  send(host, "voteNightExtension", firstNight);
  assert.equal(host.state.me.nightExtension.votes, 0);
  send(host, "voteNightExtension", host.state.nightKey);
  assert.equal(host.state.me.nightExtension.votes, 1);
});

test("the Lookout can redirect a Doctor-saved attack once on an even night", (t) => {
  const { room, host, players, find, send } = gameFixture(t,
    ["Vampire", "Lookout", "Doctor", "Villager", "Villager", "Villager"]);
  const vampire = find("Vampire");
  const lookout = find("Lookout");
  const doctor = find("Doctor");
  const original = find("Villager");
  assert.equal(lookout.state.roleWinGoals.Lookout, "Wins with Vampires");
  assert.equal(lookout.state.me.nightAbility, null);
  pick(send, lookout, { ability: true }, /unavailable/);
  send(host, "resolveNight");
  send(host, "forceSleep");
  assert.equal(lookout.state.me.nightAbility, "Lookout");
  pick(send, lookout, { ability: true }, /Wait for the other players/);
  pick(send, vampire, { targetId: id(original) });
  pick(send, doctor, { targetId: id(original) });
  send(host, "resolveNight");
  assert.equal(host.state.nightStage, "lookout");
  send(host, "resolveNight");
  assert.equal(host.state.phase, "night");
  pick(send, lookout, { ability: true });

  const dead = players.filter(({ state }) => !state.me.alive);
  assert.equal(dead.length, 1);
  const [backup] = dead;
  assert.ok(![vampire, lookout, original].includes(backup));
  const report = lookout.state.me.privateMessages.at(-1).text;
  assert.ok(report.includes(`targeted ${original.state.me.name}.`));
  assert.ok(report.includes(`shifted to ${backup.state.me.name}.`));
  assert.ok(!room.buildTableState().cues.some(({ text }) => text.includes("shifted")));
  assert.ok(!vampire.state.me.privateMessages.some(({ text }) => text.includes("shifted")));
  send(host, "forceSleep");
  assert.equal(lookout.state.me.nightAbility, null);
});

test("the Nurse saves anonymously, prevents a redirect, and spends the charge", (t) => {
  const { room, host, players, find, send } = gameFixture(t,
    ["Vampire", "Lookout", "Doctor", "Nurse", "Villager", "Villager", "Villager"]);
  const vampire = find("Vampire");
  const nurse = find("Nurse");
  const doctor = find("Doctor");
  const lookout = find("Lookout");
  const target = find("Villager");
  send(host, "resolveNight");
  send(host, "forceSleep");
  pick(send, vampire, { targetId: id(target) });
  pick(send, doctor, { targetId: id(target) });
  pick(send, nurse, { ability: true });
  send(host, "resolveNight");
  pick(send, lookout, { ability: true });

  assert.ok(players.every(({ state }) => state.me.alive));
  assert.equal(nurse.state.me.abilityUsed, true);
  const note = nurse.state.me.privateMessages.at(-1).text;
  assert.match(note, /could not kill anyone/);
  assert.ok(!players.some(({ state }) => note.includes(state.me.name)));
  assert.equal(lookout.state.me.privateMessages.at(-1).text, `The Vampires targeted ${target.state.me.name}.`);
  assert.ok(!room.buildTableState().cues.some(({ text }) => text.includes("Nurse")));

  send(host, "forceSleep");
  assert.equal(nurse.state.me.nightAbility, null);
  pick(send, nurse, { ability: true }, /unavailable/);
  pick(send, vampire, { targetId: id(target) });
  send(host, "resolveNight");
  assert.equal(target.state.me.alive, false);
});

test("a blocked Nurse keeps the save, which can be spent on a night with no attack", (t) => {
  const { host, find, send } = gameFixture(t, ["Vampire", "Silencer", "Nurse", ...Array(3).fill("Villager")]);
  const nurse = find("Nurse");
  pick(send, nurse, { ability: true });
  pick(send, find("Silencer"), { targetId: id(nurse) });
  send(host, "resolveNight");
  assert.equal(nurse.state.me.abilityUsed, false);
  assert.match(nurse.state.me.privateMessages.at(-1).text, /blocked/);
  send(host, "forceSleep");
  pick(send, nurse, { ability: true });
  send(host, "resolveNight");
  assert.equal(nurse.state.me.abilityUsed, true);
});

test("the Nurse blocks Vampire kills while an unrelated Hunter shot still resolves", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Nurse", "Hunter", ...Array(3).fill("Villager")]);
  const [bitten, shot] = players.filter(({ state }) => state.me.role === "Villager");
  const hunter = find("Hunter");
  pick(send, find("Nurse"), { ability: true });
  pick(send, find("Vampire"), { targetId: id(bitten) });
  pick(send, hunter, { targetId: id(shot) });
  send(host, "resolveNight");
  assert.ok(bitten.state.me.alive);
  assert.ok(!shot.state.me.alive);
  assert.ok(!hunter.state.me.alive);
});

test("the Usurper requires at least five players", (t) => {
  const { room, host, newSocket, send } = roomFixture(t, false);
  room.join(newSocket("guest"), "guest-session", "Guest");
  send(host, "updateConfig", { role: "Usurper", enabled: true, count: 1 });
  send(host, "startGame");
  assert.equal(host.state.phase, "lobby");
  assert.match(host.errorMessage, /at least 5 players/);
});

test("Usurper mark counts follow the starting group and require unique private targets", (t) => {
  const counts = [[5, 2], [6, 2], [7, 3], [8, 3], [9, 4], [10, 4]];
  for (const [group, expected] of counts) {
    const { host, players, find, send } = gameFixture(t, ["Vampire", "Usurper", ...Array(group - 2).fill("Villager")]);
    const usurper = find("Usurper");
    const others = players.filter((player) => player !== usurper);
    assert.equal(usurper.state.me.nightPickCount, expected);
    const marks = others.slice(0, expected).map(id);
    pick(send, usurper, { targetIds: marks.slice(1) }, /different living/);
    pick(send, usurper, { targetIds: Array(expected).fill(marks[0]) }, /different living/);
    pick(send, usurper, { targetIds: [id(usurper), ...marks.slice(1)] }, /different living/);
    pick(send, usurper, { targetIds: marks });
    send(host, "resolveNight");
    assert.deepEqual(usurper.state.me.usurperMarks, marks);
    assert.ok(others.every(({ state }) => state.me.usurperMarks === undefined));
    send(host, "forceSleep");
    assert.equal(usurper.state.me.nightPickCount, 1);
  }
});

test("the Usurper must be alive and vote for the exiled mark to earn a personal win", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Usurper", ...Array(5).fill("Villager")]);
  const vampire = find("Vampire");
  const usurper = find("Usurper");
  const [first, second, third] = players.filter(({ state }) => state.me.role === "Villager");
  pick(send, usurper, { targetIds: [first, second, third].map(id) });
  send(host, "resolveNight");
  startVoting(send, host);
  cast(send, vampire, id(first));
  send(host, "resolveVotes");
  assert.ok(!first.state.me.alive);
  assert.doesNotMatch(usurper.state.me.privateMessages.at(-1).text, /earned/);
  pick(send, vampire, { targetId: id(second) });
  send(host, "resolveNight");
  assert.ok(!second.state.me.alive);
  assert.doesNotMatch(usurper.state.me.privateMessages.at(-1).text, /earned/);

  startVoting(send, host);
  cast(send, usurper, id(third));
  send(host, "resolveVotes");
  assert.match(usurper.state.me.privateMessages.at(-1).text, /earned your Usurper win/);
  assert.equal(host.state.players.find(({ id: playerId }) => playerId === id(usurper)).personalWin, null);
  assert.equal(host.state.phase, "night");
  send(host, "endGame");
  assert.equal(host.state.gameOver.finalRoles.find(({ role }) => role === "Usurper").won, true);
});

test("optional restrictions reveal eliminated roles and require a Vampire majority", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Doctor", "Villager", "Villager"], {
    rules: { doctorNoSelfSave: true, revealOnDeath: true, strictVampireMajority: true },
  });
  const doctor = find("Doctor");
  const vampire = find("Vampire");
  const villagers = players.filter(({ state }) => state.me.role === "Villager");
  assert.ok(!doctor.state.me.nightTargetIds.includes(id(doctor)));
  pick(send, doctor, { targetId: id(doctor) }, /available player/);
  for (const villager of villagers) {
    pick(send, vampire, { targetId: id(villager) });
    send(host, "resolveNight");
    assert.equal(host.state.phase, "day");
    assert.equal(host.state.players.find(({ id: playerId }) => playerId === id(villager)).publicRole, "Villager");
    send(host, "forceSleep");
  }
  pick(send, vampire, { targetId: id(doctor) });
  send(host, "resolveNight");
  assert.equal(host.state.gameOver.winner, "Vampires");
  assert.match(host.state.gameOver.reason, /outnumbers/);
});

test("a death resets the optional three-quiet-night draw counter", (t) => {
  const { host, find, send } = gameFixture(t, ["Vampire", ...Array(4).fill("Villager")], { rules: { quietNightDraw: true } });
  const vampire = find("Vampire");
  const runNight = () => {
    send(host, "resolveNight");
    if (host.state.phase === "day") send(host, "forceSleep");
  };
  runNight();
  runNight();
  pick(send, vampire, { targetId: id(find("Villager")) });
  runNight();
  runNight();
  runNight();
  assert.equal(host.state.phase, "night");
  runNight();
  assert.equal(host.state.gameOver.winner, "Draw");
  assert.match(host.state.gameOver.reason, /Three nights/);
});

test("one confirmed vote counts when the rest of the players abstain", (t) => {
  const { host, players, find, send } = gameFixture(t, ["Vampire", "Mayor", "Villager", "Villager"]);
  const vampire = find("Vampire");
  const mayor = find("Mayor");
  send(host, "resolveNight");
  assert.match(cast(send, mayor, id(vampire)), /closed/);
  startVoting(send, host);
  assert.match(cast(send, mayor, id(vampire), "last-ballot"), /closed/);
  assert.match(cast(send, mayor, id(mayor)), /eligible/);
  assert.equal(cast(send, mayor, id(vampire)), null);
  assert.equal(mayor.state.me.dayVoteTarget, id(vampire));
  for (const player of players.filter((candidate) => candidate !== mayor)) assert.equal(cast(send, player, null), null);
  assert.equal(host.state.gameOver.winner, "Villagers");
});

test("skipping and automatic voting never reveal a Mayor", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = roomFixture(t);
  for (let index = 0; index < 4; index++) send(host, "addBot");
  send(host, "updateConfig", { role: "Mayor", enabled: true, count: 4 });
  send(host, "startGame");
  const token = host.state.bots.find(({ role }) => role === "Mayor").token;
  const mayor = newSocket("manual-mayor");
  assert.equal(room.joinBot(mayor, token), true);
  pick(send, mayor, { skip: true });
  assert.equal(mayor.state.me.mayorRevealed, false);
  send(host, "resolveNight");
  send(mayor, "setBotAuto", true);
  startVoting(send, host);
  t.mock.timers.tick(600);
  assert.ok(mayor.state.me.dayVoteTarget);
  assert.ok(host.state.players.every(({ mayorRevealed }) => !mayorRevealed));
  send(mayor, "setBotAuto", false);
  send(mayor, "revealMayor");
  assert.equal(mayor.state.me.mayorRevealed, true);
  assert.equal(room.buildTableState().cues.filter(({ text }) => text.includes("revealed as Mayor")).length, 1);
});

test("practice bots stay silent without a key and still vote", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = roomFixture(t);
  const guest = newSocket("spectating-chat");
  room.join(guest, "guest-session", "Friend");
  for (let index = 0; index < 3; index++) send(host, "addBot");
  send(host, "configureBotAi", { key: "mock-key-for-tests-only", remember: true }, (error) => assert.match(error, /own instance/));
  assert.equal(host.state.me.hostAi, null);
  send(host, "startGame");
  send(host, "resolveNight");
  send(guest, "discuss", { dayNumber: host.state.dayNumber, text: "Bot 1, whom do you suspect?" }, (error) => assert.equal(error, null));
  t.mock.timers.tick(5000);
  assert.equal(host.discussionUpdate.messages.length, 1);
  assert.equal(room.buildTableState().discussion, undefined);
  startVoting(send, host);
  t.mock.timers.tick(600);
  assert.equal(host.state.votesCast, 3);
  assert.equal(host.state.geminiDiscussion, false);
});

test("AI bots answer a named player using aliases and use the model vote", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const requests = [];
  const { room, host, newSocket, send } = roomFixture(t, true, {
    allowed: () => true,
    create: () => ({ available: true, close() {}, async decide(context) {
      requests.push(context);
      return { voteTarget: context.replyTo, line: `Why do you suspect me, ${context.replyTo}?` };
    } }),
  });
  const guest = newSocket("discussion-guest");
  room.join(guest, "discussion-session", "Alex");
  for (let index = 1; index <= 3; index++) {
    send(host, "addBot");
    assert.equal(room.joinBot(newSocket(`discussion-bot-${index}`), host.state.bots.at(-1).token), true);
  }
  const bot = newSocket("named-bot");
  assert.equal(room.joinBot(bot, host.state.bots[0].token), true);
  const { name } = bot.state.me;
  send(host, "configureBotAi", { key: "mock-key-for-tests-only" }, (error) => assert.equal(error, null));
  assert.equal(host.state.me.hostAi.configured, true);
  assert.equal(guest.state.me.hostAi, null);
  send(host, "startGame");
  send(host, "resolveNight");
  let acknowledgement;
  const note = (player, text) => send(player, "discuss", { dayNumber: host.state.dayNumber, text }, (error) => { acknowledgement = error; });
  note(guest, `I suspect ${name}. Private text never leaves the server.`);
  assert.equal(acknowledgement, null);
  note(guest, "Too soon.");
  assert.match(acknowledgement, /moment/);
  t.mock.timers.tick(1800);
  assert.equal(host.discussionUpdate.messages.length, 1);
  send(bot, "setBotAuto", true);
  t.mock.timers.tick(1800);
  await Promise.resolve();
  const reply = host.discussionUpdate.messages.at(-1);
  assert.equal(reply.name, name);
  assert.equal(reply.automated, true);
  assert.match(reply.text, /Why do you suspect me, Alex/);
  assert.equal(requests[0].challenged, true);
  assert.doesNotMatch(JSON.stringify(requests[0]), /Private text|Alex|Bot 1|mock-key/);
  assert.deepEqual(guest.discussionUpdate.messages.at(-1), reply);
  assert.equal(room.buildTableState().discussion, undefined);
  assert.ok(requests[0].eligible.some(({ player }) => player === requests[0].replyTo));
  startVoting(send, host);
  t.mock.timers.tick(600);
  assert.equal(bot.state.me.dayVoteTarget, id(guest));
  send(host, "forceSleep");
  note(guest, "Night message");
  assert.match(acknowledgement, /during the day/);
  t.mock.timers.tick(1800);
  assert.equal(host.discussionUpdate.messages.at(-1).id, reply.id);
});

test("host keys are room-scoped and survive a reload only when remembered", (t) => {
  let created = 0;
  let closed = 0;
  const { room, host, newSocket, send } = roomFixture(t, true, {
    allowed: (socket) => Boolean(socket && socket.id !== "unsafe"),
    create: () => { created++; return { available: true, close() { closed++; } }; },
  });
  const guest = newSocket("guest");
  room.join(guest, "guest-session", "Guest");
  const key = "private-test-key-not-for-logs";
  send(guest, "configureBotAi", { key }, (error) => assert.match(error, /own instance/));
  assert.equal(created, 0);
  send(host, "configureBotAi", { key, remember: false }, (error) => assert.equal(error, null));
  assert.doesNotMatch(JSON.stringify([host.state, guest.state, room.buildTableState()]), /private-test-key/);
  room.leave(host, false);
  assert.equal(closed, 1);
  const reloaded = newSocket("reloaded");
  room.join(reloaded, "host-session", "Tester");
  assert.equal(reloaded.state.me.hostAi.configured, false);
  send(reloaded, "configureBotAi", { key, remember: true }, (error) => assert.equal(error, null));
  room.leave(reloaded, false);
  assert.equal(guest.state.geminiDiscussion, false);
  const unsafe = newSocket("unsafe");
  room.join(unsafe, "host-session", "Tester");
  assert.equal(unsafe.state.me.hostAi, null);
  assert.equal(guest.state.geminiDiscussion, false);
  const remembered = newSocket("remembered");
  room.join(remembered, "host-session", "Tester");
  assert.equal(remembered.state.me.hostAi.remember, true);
  assert.equal(guest.state.geminiDiscussion, true);
  room.leave(remembered, true);
  assert.equal(closed, 2);
  assert.equal(guest.state.me.isHost, true);
  assert.equal(guest.state.me.hostAi.configured, false);
  send(guest, "configureBotAi", { key, remember: true }, (error) => assert.equal(error, null));
  send(guest, "configureBotAi", { clear: true }, (error) => assert.equal(error, null));
  assert.equal(closed, 3);
  assert.equal(guest.state.me.hostAi.configured, false);
});

test("an idle Vampire gets negative overtime and an automatic choice", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, players, find, send } = gameFixture(t, ["Vampire", "Villager", "Villager", "Villager"]);
  const vampire = find("Vampire");
  for (const player of players.filter((candidate) => candidate !== vampire)) pick(send, player, { skip: true });
  const deadline = host.state.clock.deadline;
  t.mock.timers.tick(FIRST_NIGHT);
  assert.equal(host.state.clock.deadline, deadline);
  assert.equal(host.state.clock.overtimeUntil, deadline + 10000);
  assert.equal(room.buildTableState().clock.overtimeUntil, deadline + 10000);
  assert.equal(vampire.state.me.nightComplete, false);
  t.mock.timers.tick(9999);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(1);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.aliveCount, 3);
  assert.match(vampire.state.me.privateMessages.at(-1).text, /submitted your night move automatically/);
});

test("the Lookout waits for every other choice and gets its own overtime", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { host, players, find, send } = gameFixture(t,
    ["Vampire", "Lookout", "Doctor", "Villager", "Villager", "Villager"]);
  const vampire = find("Vampire");
  const lookout = find("Lookout");
  const doctor = find("Doctor");
  const target = find("Villager");
  send(host, "resolveNight");
  send(host, "forceSleep");
  pick(send, vampire, { targetId: id(target) });
  for (const player of players.filter((candidate) => ![vampire, lookout, doctor].includes(candidate))) pick(send, player, { skip: true });
  t.mock.timers.tick(800);
  assert.equal(lookout.state.me.nightCanChoose, false);
  assert.ok(host.state.clock.overtimeUntil);
  pick(send, doctor, { targetId: id(target) });
  assert.equal(host.state.nightStage, "lookout");
  assert.equal(lookout.state.me.nightCanChoose, true);
  pick(send, doctor, { skip: true }, /turn is closed/);
  t.mock.timers.tick(10000);
  assert.ok(lookout.state.clock.overtimeUntil);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(10000);
  assert.equal(host.state.phase, "day");
  assert.ok(lookout.state.me.privateMessages.some(({ text }) => text.includes("submitted your night move automatically")));
  assert.ok(lookout.state.me.privateMessages.some(({ text }) => text.includes("the attack shifted")));
});

test("Gemini uses the host key, low thinking, and an abortable request", async () => {
  assert.equal(createGeminiBot(""), null);
  const key = "test-only-key-sample";
  const input = { speaker: "P1", eligible: [{ player: "P2", suspicion: 1 }] };
  let requestOptions;
  let requestUrl;
  const bot = createGeminiBot(key, async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
      { thought: true, text: "ignore" }, { text: '{"voteTarget":"P2","line":" P2, what did you notice? "}' },
    ] } }] }) };
  });
  assert.deepEqual(await bot.decide(input), { voteTarget: "P2", line: "P2, what did you notice?" });
  assert.match(requestUrl, /models\/gemini-4-hydrogen:generateContent$/);
  assert.equal(requestOptions.headers["x-goog-api-key"], key);
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), input);
  bot.close();
  assert.equal(requestOptions.signal.aborted, true);
  assert.equal(await bot.decide(input), null);
  const unavailable = createGeminiBot(key, async () => ({ ok: false }));
  assert.equal(await unavailable.decide(input), null);
  assert.equal(unavailable.available, false);
});
