const assert = require("node:assert/strict");
const test = require("node:test");
const { createRoom } = require("../game-room");

function practiceFixture(t, practice = true) {
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to: (id) => ({ emit: (...args) => sockets.get(id)?.emit(...args) }),
  };
  const room = createRoom(io, "SAMPLE", "host-session", { night: 800, day: 1200 }, practice);
  t.after(() => room.dispose());

  function newSocket(id) {
    const socket = { id, data: {}, emit(event, data) { this[event] = data; } };
    sockets.set(id, socket);
    return socket;
  }

  const host = newSocket("host");
  room.join(host, "host-session", "Tester");
  return { room, host, newSocket, send: (socket, event, ...args) => room.handlers[event](socket, ...args) };
}

test("only the practice host receives bot access and a bot gets its own role", (t) => {
  const { room, host, newSocket, send } = practiceFixture(t);
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
  assert.equal(host.state.playerCount, 8);
  assert.equal(host.state.bots.length, 6);
  assert.equal(host.state.selectedRoleCount, 8);
  const bot = host.state.bots[0];
  const botWindow = newSocket("bot");
  assert.equal(room.joinBot(botWindow, bot.id), false);
  assert.equal(room.joinBot(botWindow, bot.token), true);
  const hostId = host.state.me.id;
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

test("a manual bot uses the regular turn rules and disconnected bots act and vote", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { room, host, newSocket, send } = practiceFixture(t);
  for (let i = 0; i < 3; i += 1) send(host, "addBot");
  send(host, "updateConfig", { vampireCanSkip: true });
  send(host, "startGame");

  const vampire = host.state.bots.find(({ role }) => role === "Vampire");
  const vampireWindow = vampire ? newSocket("vampire") : host;
  if (vampire) assert.equal(room.joinBot(vampireWindow, vampire.token), true);
  const watchedBot = host.state.bots.find(({ role }) => role === "Villager");
  const botWindow = newSocket("villager");
  assert.equal(room.joinBot(botWindow, watchedBot.token), true);

  for (let number = 1; number <= 4; number += 1) {
    const turn = host.state.nightTurn;
    assert.equal(turn.number, number);
    if (turn.playerId === watchedBot.id) {
      t.mock.timers.tick(400);
      assert.equal(host.state.nightTurn.key, turn.key);
      room.leave(botWindow, false);
      assert.equal(host.state.bots.find(({ id }) => id === watchedBot.id).automatic, true);
      t.mock.timers.tick(200);
    } else if (turn.playerId === host.state.me.id || turn.playerId === vampire?.id) {
      const actor = turn.playerId === host.state.me.id ? host : vampireWindow;
      send(actor, "nightAction", { turnKey: turn.key, skip: true }, (error) => assert.equal(error, null));
    } else {
      t.mock.timers.tick(400);
    }
  }

  assert.equal(host.state.phase, "day");
  assert.equal(host.state.aliveCount, 4);
  const botReopened = newSocket("reopened");
  assert.equal(room.joinBot(botReopened, watchedBot.token), true);
  assert.equal(botReopened.state.me.villagerWatchUsed, true);
  assert.match(botReopened.state.me.privateMessages[0].text, /targeted move last night/);
  send(botReopened, "setBotAuto", true);
  send(vampireWindow, "setBotAuto", true);
  t.mock.timers.tick(600);
  assert.equal(host.state.votesCast, 3);
  send(host, "vote", { targetId: watchedBot.id });
  assert.notEqual(host.state.phase, "day");
});

test("a regular room cannot add bots", (t) => {
  const { room, host, newSocket, send } = practiceFixture(t, false);
  send(host, "addBot");
  send(host, "setUpAllRoles");
  assert.equal(host.state.bots, undefined);
  assert.equal(host.state.playerCount, 1);
  assert.equal(room.joinBot(newSocket("bot"), "00000000-0000-0000-0000-000000000000"), false);
});
