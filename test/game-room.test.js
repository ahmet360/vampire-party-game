const assert = require("node:assert/strict");
const test = require("node:test");
const { createRoom } = require("../game-room");

function roomFixture(t, practice = true) {
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to: (id) => ({ emit: (...args) => sockets.get(id)?.emit(...args) }),
  };
  const room = createRoom(io, "SAMPLE", "host-session", { night: 800, day: 1200 }, practice);
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
  return { room, host, players, find, send };
}

function id(player) {
  return player.state.me.id;
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
  assert.equal(room.joinBot(tiled, host.state.bots[1].token, true), true);
  assert.equal(tiled.state.me.botAuto, true);
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
  if (vampire) assert.equal(room.joinBot(vampireWindow, vampire.token, false), true);
  const villager = host.state.bots.find(({ role }) => role === "Villager");
  const botWindow = newSocket("villager");
  assert.equal(room.joinBot(botWindow, villager.token, false), true);

  pick(send, vampireWindow, { skip: true });
  const hostEvents = host.received;
  t.mock.timers.tick(400);
  assert.equal(botWindow.state.me.nightComplete, false);
  assert.equal(host.received, hostEvents);
  room.leave(botWindow, false);
  assert.equal(host.state.bots.find(({ id }) => id === villager.id).automatic, true);
  t.mock.timers.tick(200);

  const reopened = newSocket("reopened");
  assert.equal(room.joinBot(reopened, villager.token, true), true);
  assert.equal(reopened.state.me.nightComplete, true);
  assert.deepEqual(reopened.state.me.privateMessages, []);
  assert.equal(host.state.phase, "night");
  t.mock.timers.tick(200);
  assert.equal(host.state.phase, "day");
  assert.equal(host.state.aliveCount, 4);

  send(vampireWindow, "setBotAuto", true);
  t.mock.timers.tick(600);
  assert.equal(host.state.votesCast, 3);
  send(host, "vote", { targetId: villager.id });
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

test("night choices share one deadline and stay private until they resolve", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, players, find, send } = gameFixture(t, ["Vampire", "Doctor", "Mayor", "Villager", "Detective"]);
  const vampire = find("Vampire");
  const doctor = find("Doctor");
  const mayor = find("Mayor");
  const villager = find("Villager");
  const detective = find("Detective");
  assert.ok(players.every(({ state }) => state.nightKey === host.state.nightKey && state.clock.deadline === 1800));
  const board = room.buildTableState();
  assert.equal(board.cues.length, 1);
  assert.match(board.cues[0].text, /Everyone has/);
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
  t.mock.timers.tick(799);
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
    for (const player of players.filter(({ state }) => state.me.alive)) {
      send(player, "vote", { targetId: id(player === target ? villager : target) });
    }
  };
  eliminateWithVotes(first);
  assert.equal(host.state.phase, "night");
  assert.equal(host.state.players.find((player) => player.id === id(first)).jesterWon, true);
  assert.equal(host.state.players.find((player) => player.id === id(second)).jesterWon, false);
  send(host, "resolveNight");
  eliminateWithVotes(second);
  send(host, "resolveNight");
  eliminateWithVotes(vampire);
  assert.equal(host.state.gameOver.winner, "Villagers");
  assert.equal(host.state.gameOver.finalRoles.filter(({ role, won }) => role === "Jester" && won).length, 2);
});

for (const deadlockDraw of [true, false]) {
  test(`the three-way deadlock follows the room setting (${deadlockDraw})`, (t) => {
    const { host, find, send } = gameFixture(t, ["Vampire", "Jester", "Villager"], { deadlockDraw });
    const vampire = find("Vampire");
    const jester = find("Jester");
    const villager = find("Villager");
    send(host, "resolveNight");
    send(vampire, "vote", { targetId: id(villager) });
    send(jester, "vote", { targetId: id(vampire) });
    send(villager, "vote", { targetId: id(jester) });
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
  send(holder, "vote", { targetId: id(accuser) });
  assert.equal(holder.state.me.dayVoteTarget, null);
  if (holder !== hunter) {
    send(hunter, "hunterShot", id(accuser));
  } else {
    for (const player of players.filter((player) => player !== holder && player !== accuser)) {
      send(player, "vote", { targetId: id(accuser) });
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
  send(villager, "vote", { targetId: id(vampire) });
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
  send(vampire, "vote", { targetId: id(fog) });
  assert.equal(villager.received, received);
  assert.match(useFog(send, fog, "boostFogVote", { targetId: id(fog) }), /available player/);
  assert.equal(useFog(send, fog, "boostFogVote", { targetId: id(vampire) }), null);
  assert.equal(fog.state.me.fogmaster.boostTargetId, id(vampire));
  assert.equal(villager.received, received);
  assert.match(useFog(send, fog, "boostFogVote", { targetId: id(villager) }), /already used/);

  for (let day = 2; day <= 3; day += 1) {
    send(host, "forceSleep");
    send(host, "resolveNight");
    assert.equal(useFog(send, fog, "openSecretBallot"), null);
    assert.equal(fog.state.me.fogmaster.ballotsLeft, 3 - day);
    assert.equal(fog.state.me.fogmaster.boostTargetId, null);
    assert.match(useFog(send, fog, "boostFogVote", { targetId: id(villager) }), /already used/);
  }
  send(host, "forceSleep");
  send(host, "resolveNight");
  assert.equal(room.buildTableState().secretBallot, false);
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
  assert.equal(useFog(send, fog, "openSecretBallot"), null);
  for (const player of [vampire, fog, second]) send(player, "vote", { targetId: id(first) });
  for (const player of [first, third, fourth]) send(player, "vote", { targetId: id(vampire) });
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
