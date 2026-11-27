const { randomInt, randomUUID } = require("node:crypto");

const ROLE_ORDER = [
  "Vampire",
  "Doctor",
  "Jester",
  "Detective",
  "Villager",
  "Hunter",
  "Mayor",
  "Transporter",
  "Thief",
  "Silencer",
  "Seer",
  "Fogmaster",
];

const ROLE_DESCRIPTIONS = {
  Vampire: "Vote for a victim each night. A tied kill vote fizzles. You can see the living evil team in your private role card.",
  Doctor: "Save one player each night. You cannot save the same player two nights in a row.",
  Jester: "You win individually if the town votes you out. You know the other Jesters. The match continues for everyone else.",
  Detective: "Investigate one player each night. The first check of an evil player is suspicious. A repeat check shows their exact role.",
  Villager: "Pick a name as cover at night. Your choice has no effect. Discuss and vote during the day.",
  Hunter: "You have one shot for the match, by day or by night. If the target is a Vampire, only they die. Otherwise you die too.",
  Mayor: "Reveal during the day or night from your private role card. Once revealed, your vote counts as 2. Your night choice is cover.",
  Transporter: "Pick two players at night. Saves, investigations, shots, and kill votes aimed at either player go to the other.",
  Thief: "Once per match, choose someone at night to steal their role without seeing it first. Their night ability fizzles. If you both survive, you swap into their role next night and they become a Villager. Until then, you win with the Villagers.",
  Silencer: "Once per match, choose a player to block their night ability. You win with the Vampires. They can see that you are on their team.",
  Seer: "Your private role card highlights players with a role. Keep those names to yourself. You have one guess: name a player and their exact role. If you’re right, the game reveals you and their role. If you’re wrong, you die.",
  Fogmaster: "You win with the Vampires. Open up to three secret day ballots per match. On one secret ballot, you can privately add one extra vote to a player.",
};

const EVIL_ROLES = new Set(["Vampire", "Silencer", "Fogmaster"]);
const NIGHT_ROLES = new Set(["Vampire", "Doctor", "Detective", "Hunter", "Transporter", "Thief", "Silencer"]);
const ONE_USE_ROLES = new Set(["Hunter", "Thief", "Silencer", "Seer"]);
const MAX_SECRET_BALLOTS = 3;
const OATH_MODES = ["off", "random-town", "random-any", "town", "non-evil", "evil", "everyone"];

function alignment(role) {
  if (EVIL_ROLES.has(role)) return "Evil";
  if (role === "Jester" || role === "Thief") return "Neutral";
  return "Town";
}

const audioTestCue = { id: 0, text: "Announcements are on." };
const MAX_PLAYERS = 24;

function makeDefaultRoleConfig() {
  const config = {};

  ROLE_ORDER.forEach((role) => {
    config[role] = {
      enabled: role === "Vampire" || role === "Villager",
      count: role === "Vampire" ? 1 : 0,
    };
  });

  return config;
}

function createRoom(io, code, hostSession, timing, practice = false) {
  const players = new Map();
  const socketToPlayerId = new Map();
  const tableSession = randomUUID();
  const tableRoom = `announcer:${tableSession}`;
  let cueSequence = 0;
  let phaseTimer;
  let hostTimer;
  let botTimer;
  let botClock;
  let nextBotNumber = 1;
  let emptySince = Date.now();

  const game = {
    phase: "lobby",
    hasStarted: false,
    dayNumber: 0,
    nightNumber: 0,
    roleConfig: makeDefaultRoleConfig(),
    vampireCanSkip: false,
    oathMode: "off",
    deadlockDraw: true,
    nightChoices: new Map(),
    nightKey: null,
    pendingThefts: [],
    clock: null,
    dayVotes: {},
    secretBallot: false,
    fogBoosts: new Map(),
    doctorLastSave: {},
    detectiveMemory: {},
    messages: [],
    tableCues: [],
    gameOver: null,
  };

  // General helpers
  function cleanName(name) {
    const trimmed = typeof name === "string" ? name.trim().slice(0, 24) : "";
    return trimmed || "Player";
  }

  function cloneRoleConfig() {
    const copy = {};
    ROLE_ORDER.forEach((role) => {
      copy[role] = {
        enabled: Boolean(game.roleConfig[role]?.enabled),
        count: Number(game.roleConfig[role]?.count || 0),
      };
    });
    return copy;
  }

  function clampCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.min(30, parsed));
  }

  function shuffle(array) {
    const copy = [...array];

    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
  }

  function getPlayer(playerId) {
    return players.get(playerId) || null;
  }

  function getPlayerName(playerId) {
    return getPlayer(playerId)?.name || "Unknown";
  }

  function getAllPlayers() {
    return [...players.values()];
  }

  function getAlivePlayers() {
    return getAllPlayers().filter((player) => player.alive);
  }

  function isAlive(playerId) {
    return Boolean(getPlayer(playerId)?.alive);
  }

  function pushMessage(message) {
    game.messages.push({ text: message, time: new Date().toLocaleTimeString() });

    if (game.messages.length > 80) {
      game.messages = game.messages.slice(-80);
    }
  }

  function announceToTable(text) {
    game.tableCues.push({ id: ++cueSequence, text });
    if (game.tableCues.length > 12) game.tableCues.shift();
  }

  function buildTableState() {
    return {
      roomCode: code,
      session: tableSession,
      serverTime: Date.now(),
      clock: game.clock,
      phase: game.phase,
      dayNumber: game.dayNumber,
      nightNumber: game.nightNumber,
      playerCount: getAllPlayers().length,
      aliveCount: getAlivePlayers().length,
      secretBallot: game.secretBallot,
      votesCast: game.secretBallot ? null : Object.keys(game.dayVotes).length,
      winner: game.gameOver?.winner || null,
      cues: game.tableCues,
    };
  }

  function pushPrivateMessage(playerId, message) {
    const player = getPlayer(playerId);
    if (!player) return;

    player.privateMessages.push({ text: message, time: new Date().toLocaleTimeString() });

    if (player.privateMessages.length > 30) {
      player.privateMessages = player.privateMessages.slice(-30);
    }
  }

  function isHostSocket(socket) {
    const playerId = socketToPlayerId.get(socket.id);
    return Boolean(playerId && getPlayer(playerId)?.isHost);
  }

  function isAutomaticBot(player) {
    return Boolean(player?.isBot && (player.botAuto || !player.socketId));
  }

  function sendError(socket, message) {
    socket.emit("errorMessage", message);
  }

  function knownPlayers(me) {
    if (me.role !== "Vampire" && me.role !== "Jester") return [];
    return getAllPlayers().filter((player) => player !== me
      && (me.role === "Vampire" ? EVIL_ROLES.has(player.role) : player.role === "Jester"))
      .map(({ name, role }) => ({ name, role }));
  }

  function seerTargets(me) {
    return getAlivePlayers().filter((player) => player !== me && player.role !== "Villager");
  }

  // Public state builder and sync
  function buildStateFor(playerId) {
    const me = getPlayer(playerId);

    return {
      roomCode: code,
      serverTime: Date.now(),
      clock: game.clock,
      timing,
      practice,
      phase: game.phase,
      hasStarted: game.hasStarted,
      dayNumber: game.dayNumber,
      nightNumber: game.nightNumber,
      roleOrder: ROLE_ORDER,
      roleDescriptions: ROLE_DESCRIPTIONS,
      roleConfig: cloneRoleConfig(),
      roleAlignments: Object.fromEntries(ROLE_ORDER.map((role) => [role, alignment(role)])),
      vampireCanSkip: game.vampireCanSkip,
      oathMode: game.oathMode,
      deadlockDraw: game.deadlockDraw,
      nightKey: game.phase === "night" ? game.nightKey : null,
      secretBallot: game.secretBallot,
      votesCast: game.secretBallot ? null : Object.keys(game.dayVotes).length,
      messages: game.messages.slice(-30),
      gameOver: game.gameOver,
      selectedRoleCount: countSelectedRoles(),
      playerCount: getAllPlayers().length,
      aliveCount: getAlivePlayers().length,
      players: getAllPlayers().map((player) => ({
        id: player.id,
        name: player.name,
        connected: player.connected,
        alive: player.alive,
        isHost: player.isHost,
        isBot: Boolean(player.isBot),
        mayorRevealed: player.mayorRevealed,
        jesterWon: Boolean(player.jesterWon),
        publicRole: player.publicRole || null,
        role: game.phase === "gameover" ? player.role : null,
      })),
      ...(practice && me?.isHost ? {
        bots: getAllPlayers().filter((player) => player.isBot).map((bot) => ({
          id: bot.id,
          name: bot.name,
          role: bot.role,
          token: bot.botToken,
          automatic: isAutomaticBot(bot),
          windowOpen: Boolean(bot.socketId),
        })),
      } : {}),
      me: me
        ? {
            id: me.id,
            name: me.name,
            connected: me.connected,
            alive: me.alive,
            isHost: me.isHost,
            isBot: Boolean(me.isBot),
            botAuto: Boolean(me.botAuto),
            role: me.role,
            mayorRevealed: me.mayorRevealed,
            abilityUsed: Boolean(me.abilityUsed),
            seerTargets: me.role === "Seer" ? seerTargets(me).map(({ id }) => id) : [],
            seerGuessPending: Boolean(game.nightChoices.get(me.id)?.guess),
            oathActedTonight: Boolean(game.nightChoices.get(me.id)?.oath),
            knownPlayers: knownPlayers(me),
            oath: me.oath ? {
              targetId: me.oath.targetId,
              revealed: me.oath.revealed,
              canReveal: canRevealOath(me),
            } : null,
            privateMessages: me.privateMessages.slice(-10),
            nightComplete: game.nightChoices.has(me.id),
            nightPickCount: nightRole(me) === "Transporter" ? 2 : 1,
            nightTargetIds: game.phase === "night" && me.alive
              ? nightTargets(me, nightRole(me)).map(({ id }) => id) : [],
            dayVoteTarget: game.dayVotes[me.id] || null,
            fogmaster: me.role === "Fogmaster" ? {
              ballotsLeft: MAX_SECRET_BALLOTS - me.fogBallotsUsed,
              boostUsed: me.fogBoostUsed,
              boostTargetId: game.fogBoosts.get(me.id) || null,
            } : null,
            doctorLastSave: game.doctorLastSave[me.id] || null,
          }
        : null,
    };
  }

  function emitAll() {
    for (const player of players.values()) emitPlayer(player);
    io.to(tableRoom).emit("tableState", buildTableState());
    if (practice) scheduleBotActions();
  }

  function emitPlayer(player) {
    if (player.connected && player.socketId) io.to(player.socketId).emit("state", buildStateFor(player.id));
  }

  function detachPlayerSocket(player, message) {
    if (!player.socketId) return;
    socketToPlayerId.delete(player.socketId);
    const previousSocket = io.sockets.sockets.get(player.socketId);
    player.socketId = null;
    if (!previousSocket) return;
    previousSocket.data.gameCode = null;
    previousSocket.emit("roomLeft", message);
  }

  function attachPlayerSocket(player, socket) {
    if (player.socketId !== socket.id) {
      detachPlayerSocket(player, "This player rejoined on another tab.");
    }
    player.socketId = socket.id;
    players.set(player.id, player);
    socketToPlayerId.set(socket.id, player.id);
    socket.data.gameCode = code;
  }

  function join(socket, sessionId, name) {
    const existing = getAllPlayers().find((player) => player.sessionId === sessionId);
    if (!existing && players.size >= MAX_PLAYERS) return "This room is full.";

    const player = existing || {
      id: randomUUID(), sessionId, alive: game.phase === "lobby", role: null,
      mayorRevealed: false, privateMessages: [],
    };
    player.name = cleanName(name);
    player.connected = true;
    player.isHost = sessionId === hostSession;
    attachPlayerSocket(player, socket);
    emptySince = null;

    if (!existing && !player.alive) pushPrivateMessage(player.id, "You're watching this round. You'll play in the next one.");
    pushMessage(existing ? `${player.name} reconnected.` : `${player.name} joined${player.isHost ? " as host" : ""}.`);
    if (player.isHost) {
      clearTimeout(hostTimer);
      hostTimer = null;
    } else {
      scheduleHostTransfer();
    }
    emitAll();
  }

  function joinBot(socket, token, automatic) {
    if (!practice || typeof token !== "string" || token.length !== 36 || emptySince !== null) return false;
    const bot = getAllPlayers().find((player) => player.botToken === token);
    if (!bot) return false;
    if (typeof automatic === "boolean") bot.botAuto = automatic;
    attachPlayerSocket(bot, socket);
    emitAll();
    return true;
  }

  function addPracticeBot() {
    const bot = {
      id: randomUUID(), name: `Bot ${nextBotNumber++}`, botToken: randomUUID(), isBot: true,
      connected: true, alive: true, isHost: false, role: null,
      mayorRevealed: false, privateMessages: [],
    };
    players.set(bot.id, bot);
  }

  function rotateBotAccess() {
    for (const bot of players.values()) {
      if (!bot.isBot) continue;
      detachPlayerSocket(bot, "Bot access changed. Reopen this view from the current host’s practice room.");
      bot.botToken = randomUUID();
    }
  }

  function transferHosting() {
    const candidates = getAllPlayers();
    if (candidates.some((candidate) => candidate.isHost && candidate.connected)) return;
    const successor = candidates.find((candidate) => candidate.connected && !candidate.isBot);
    if (!successor) return;
    for (const candidate of candidates) candidate.isHost = candidate === successor;
    hostSession = successor.sessionId;
    if (practice) rotateBotAccess();
    pushMessage(`${successor.name} is now the host.`);
  }

  function scheduleHostTransfer() {
    if (hostTimer || getAllPlayers().some((candidate) => candidate.isHost && candidate.connected)) return;
    hostTimer = setTimeout(() => {
      hostTimer = null;
      transferHosting();
      emitAll();
    }, 45000);
    hostTimer.unref();
  }

  function leave(socket, transferHost) {
    const playerId = socketToPlayerId.get(socket.id);
    const player = getPlayer(playerId);
    socketToPlayerId.delete(socket.id);
    if (!player) return;

    player.socketId = null;
    if (player.isBot) {
      emitAll();
      return;
    }

    player.connected = false;
    if (game.phase === "lobby") players.delete(playerId);
    const hasPlayers = getAllPlayers().some((candidate) => candidate.connected && !candidate.isBot);
    if (!hasPlayers) {
      emptySince = Date.now();
      if (practice && transferHost) rotateBotAccess();
    }
    else if (player.isHost && transferHost) transferHosting();
    else if (player.isHost) scheduleHostTransfer();
    emitAll();
  }

  function nightRole(player) {
    return NIGHT_ROLES.has(player.role) && !(ONE_USE_ROLES.has(player.role) && player.abilityUsed)
      ? player.role : null;
  }

  function nightTargets(player, role) {
    return getAlivePlayers().filter((target) => {
      if (role !== "Doctor" && role !== "Transporter" && target === player) return false;
      if (role === "Doctor" && game.doctorLastSave[player.id] === target.id) return false;
      return !["Vampire", "Hunter", "Silencer", "Thief"].includes(role) || player.oath?.targetId !== target.id;
    });
  }

  function nextBotNightChoice(bot) {
    const role = nightRole(bot);
    const candidates = nightTargets(bot, role);
    if (role === "Transporter") {
      return candidates.length >= 2
        ? { targetIds: shuffle(candidates).slice(0, 2).map((player) => player.id) } : { skip: true };
    }
    if (role === "Hunter" && randomInt(3) !== 0) return { skip: true };
    return chooseTarget(candidates);
  }

  function chooseTarget(candidates) {
    if (!candidates.length) return { skip: true };
    return { targetId: candidates[randomInt(candidates.length)].id };
  }

  function scheduleBotActions() {
    const atNight = game.phase === "night";
    const needsChoice = (bot) => isAutomaticBot(bot)
      && (atNight ? !game.nightChoices.has(bot.id) : !game.dayVotes[bot.id]);
    const botsDue = (atNight || game.phase === "day") && getAlivePlayers().some(needsChoice);
    const clock = botsDue && emptySince === null ? game.clock : null;
    if (clock === botClock) return;

    clearTimeout(botTimer);
    botClock = clock;
    if (!clock) return;

    const delay = Math.min(atNight ? 4000 : 5500, Math.floor((clock.deadline - Date.now()) / 2));
    botTimer = setTimeout(() => {
      botClock = null;
      if (game.clock !== clock || clock.deadline <= Date.now()) return;
      for (const bot of getAlivePlayers()) {
        if (game.clock !== clock) break;
        if (!needsChoice(bot)) continue;
        if (atNight) {
          submitNightAction(bot, { ...nextBotNightChoice(bot), nightKey: game.nightKey });
          emitPlayer(bot);
        } else {
          revealMayor(bot);
          const candidates = getAlivePlayers().filter((player) => player !== bot && player.id !== bot.oath?.targetId);
          submitVote(bot, chooseTarget(candidates).targetId);
        }
      }
      if (atNight) scheduleBotActions();
      else emitAll();
    }, Math.max(50, delay));
  }

  function stopClock() {
    clearTimeout(phaseTimer);
    game.clock = null;
  }

  function startClock(duration, onExpire) {
    stopClock();
    game.clock = { deadline: Date.now() + duration, duration };
    phaseTimer = setTimeout(() => {
      onExpire();
      emitAll();
    }, duration);
  }

  // Lobby, role assignment, reset, and game over
  function countSelectedRoles() {
    return ROLE_ORDER.reduce((sum, role) => {
      const entry = game.roleConfig[role];
      if (!entry?.enabled) return sum;
      return sum + clampCount(entry.count);
    }, 0);
  }

  function buildRolePool() {
    const rolePool = [];

    ROLE_ORDER.forEach((role) => {
      const entry = game.roleConfig[role];
      if (!entry?.enabled) return;

      const count = clampCount(entry.count);
      for (let i = 0; i < count; i += 1) {
        rolePool.push(role);
      }
    });

    return rolePool;
  }

  function resetPlayer(player, alive) {
    Object.assign(player, {
      role: null, alive, mayorRevealed: false, abilityUsed: false, jesterWon: false,
      oath: null, publicRole: null, privateMessages: [], fogBallotsUsed: 0, fogBoostUsed: false,
    });
  }

  function assignOaths(players) {
    if (game.oathMode === "off") return;
    const groups = {
      "random-town": "Town", town: "Town", evil: "Evil",
    };
    const faction = groups[game.oathMode];
    let selected = players.filter((player) => faction ? alignment(player.role) === faction
      : game.oathMode !== "non-evil" || !EVIL_ROLES.has(player.role));
    if (game.oathMode.startsWith("random-")) selected = shuffle(selected).slice(0, 1);
    for (const player of selected) {
      player.oath = { targetId: null, shieldNight: null, revealed: false };
      pushPrivateMessage(player.id, "You have the Accuser’s Oath. Open your private role card to read it.");
    }
  }

  function startGame(socket) {
    if (game.phase !== "lobby") {
      sendError(socket, "The game already started. Reset first if you want a new game.");
      return;
    }

    const activePlayers = getAllPlayers().filter((player) => player.connected);
    const rolePool = buildRolePool();
    const vampireCount = rolePool.filter((role) => role === "Vampire").length;

    if (activePlayers.length < 2) {
      sendError(socket, "You need at least 2 connected players to start.");
      return;
    }

    if (vampireCount < 1) {
      sendError(socket, "You need at least 1 Vampire selected.");
      return;
    }

    if (rolePool.length > activePlayers.length) {
      sendError(socket, "You selected more roles than connected players. Lower some role counts first.");
      return;
    }

    while (rolePool.length < activePlayers.length) {
      rolePool.push("Villager");
    }

    const shuffledRoles = shuffle(rolePool);
    const shuffledPlayers = shuffle(activePlayers);

    game.hasStarted = true;
    game.dayNumber = 0;
    game.nightNumber = 0;
    game.doctorLastSave = {};
    game.detectiveMemory = {};
    game.messages = [];
    game.tableCues = [];
    game.gameOver = null;

    for (const player of players.values()) resetPlayer(player, false);

    shuffledPlayers.forEach((player, index) => {
      player.role = shuffledRoles[index];
      player.alive = true;
    });

    assignOaths(shuffledPlayers);
    startNight();
  }

  function resetGame() {
    stopClock();
    for (const [playerId, player] of players.entries()) {
      if (!player.connected) {
        players.delete(playerId);
        continue;
      }

      resetPlayer(player, true);
    }

    game.phase = "lobby";
    game.hasStarted = false;
    game.dayNumber = 0;
    game.nightNumber = 0;
    game.nightChoices.clear();
    game.nightKey = null;
    game.pendingThefts = [];
    game.dayVotes = {};
    game.secretBallot = false;
    game.fogBoosts.clear();
    game.doctorLastSave = {};
    game.detectiveMemory = {};
    game.messages = [];
    game.tableCues = [];
    game.gameOver = null;

    pushMessage("Game reset. Configure roles and start again.");
    announceToTable("Back to the lobby. Waiting for the host to start.");
  }

  function setGameOver(winner, reason) {
    stopClock();
    game.phase = "gameover";
    game.gameOver = {
      winner,
      reason,
      finalRoles: getAllPlayers().map((player) => ({
        name: player.name,
        role: player.role || "No role",
        alive: player.alive,
        connected: player.connected,
        won: player.jesterWon || (Boolean(player.role) && player.role !== "Jester"
          && (winner === "Vampires" && EVIL_ROLES.has(player.role)
            || winner === "Villagers" && !EVIL_ROLES.has(player.role))),
        rule: player.oath?.revealed ? "Accuser’s Oath" : null,
      })),
    };

    pushMessage(`Game over: ${winner}. ${reason}`);
    announceToTable(winner === "No winner" ? "The host ended the game."
      : winner === "Draw" ? `The game ends in a draw. ${reason}` : `Game over. Winner: ${winner}.`);
  }

  // Win condition checks
  function checkWinConditions() {
    if (!game.hasStarted || game.phase === "gameover") return true;

    const alive = getAlivePlayers();
    if (!alive.some((player) => player.role === "Vampire")) {
      setGameOver("Villagers", "All vampires are dead.");
      return true;
    }

    const evilCount = alive.filter((player) => EVIL_ROLES.has(player.role)).length;
    if (evilCount >= alive.length - evilCount) {
      setGameOver("Vampires", "The living evil team reached parity.");
      return true;
    }

    return false;
  }

  function applyRoleThefts() {
    for (const { thiefId, targetId } of game.pendingThefts) {
      const thief = getPlayer(thiefId);
      const target = getPlayer(targetId);
      if (!thief.alive) continue;
      if (!target.alive) {
        pushPrivateMessage(thiefId, "Your target died before the role could transfer. The steal was spent.");
        continue;
      }
      thief.role = target.role;
      thief.abilityUsed = target.abilityUsed || target.role === "Thief";
      if (thief.role === "Fogmaster") {
        thief.fogBallotsUsed = target.fogBallotsUsed;
        thief.fogBoostUsed = target.fogBoostUsed;
      }
      target.role = "Villager";
      target.abilityUsed = false;
      target.mayorRevealed = false;
      if (thief.role === "Doctor") game.doctorLastSave[thiefId] = game.doctorLastSave[targetId];
      delete game.doctorLastSave[targetId];
      delete game.detectiveMemory[targetId];
      pushPrivateMessage(thiefId, `You stole ${target.name}’s role. Your new role is ${thief.role}.`);
      pushPrivateMessage(targetId, "Your role was stolen. You are now a Villager.");
    }
    game.pendingThefts = [];
  }

  function startNight() {
    applyRoleThefts();
    game.phase = "night";
    game.nightNumber += 1;
    game.nightChoices.clear();
    game.dayVotes = {};
    game.secretBallot = false;
    game.fogBoosts.clear();
    game.nightKey = randomUUID();

    const message = `Night ${game.nightNumber}. Everyone has ${Math.ceil(timing.night / 1000)} seconds to make a private choice.`;
    pushMessage(message);
    announceToTable(message);
    startClock(timing.night, resolveNight);
  }

  function remapTarget(playerId, transporterPairs) {
    let remappedId = playerId;

    transporterPairs.forEach(([firstId, secondId]) => {
      if (remappedId === firstId) remappedId = secondId;
      else if (remappedId === secondId) remappedId = firstId;
    });

    return remappedId;
  }

  function getTopTargetFromTally(tally) {
    const entries = Object.entries(tally);
    if (entries.length === 0) return { targetId: null, tied: false };

    entries.sort((a, b) => b[1] - a[1]);
    const topVotes = entries[0][1];
    const topTargets = entries.filter((entry) => entry[1] === topVotes);

    if (topTargets.length !== 1) return { targetId: null, tied: true };
    return { targetId: topTargets[0][0], tied: false };
  }

function nightMoves() {
    return shuffle(getAlivePlayers()).flatMap((player) => {
      const choice = game.nightChoices.get(player.id);
      const role = choice?.guess ? "Seer" : nightRole(player);
      if (!role || !choice || choice.skip || choice.oath) return [];
      return [{ player, role, ...choice }];
    });
  }

  function blockNightMoves(moves) {
    const blocked = new Set();
    for (const { player, role, targetId } of moves) {
      if (role !== "Silencer" || blocked.has(player.id)) continue;
      player.abilityUsed = true;
      blocked.add(targetId);
    }
    for (const { player, role } of moves) {
      if (role !== "Silencer" && blocked.has(player.id)) pushPrivateMessage(player.id, "Your night action was blocked.");
    }

    // Blocks resolve first. Each player can be involved in at most one theft that night.
    const theftParticipants = new Set();
    for (const { player, role, targetId } of moves) {
      if (role !== "Thief" || blocked.has(player.id)) continue;
      if (theftParticipants.has(player.id) || theftParticipants.has(targetId)) continue;
      theftParticipants.add(player.id);
      theftParticipants.add(targetId);
      blocked.add(targetId);
      player.abilityUsed = true;
      game.pendingThefts.push({ thiefId: player.id, targetId });
    }
    return blocked;
  }

  function reportInvestigation(detective, target) {
    if (!EVIL_ROLES.has(target.role)) {
      pushPrivateMessage(detective.id, `${target.name} is not evil.`);
      return;
    }
    const memory = game.detectiveMemory[detective.id] ??= {};
    const previous = memory[target.id];
    memory[target.id] = target.role;
    pushPrivateMessage(detective.id, previous === target.role
      ? `${target.name}’s exact role is ${target.role}.` : `${target.name} seems suspicious.`);
  }

  function hunterShot(hunter, target) {
    hunter.abilityUsed = true;
    return target.role === "Vampire" ? [target.id] : [target.id, hunter.id];
  }

  function resolveNight() {
    if (game.phase !== "night") return;
    stopClock();

    const moves = nightMoves();
    const blocked = blockNightMoves(moves);
    const active = moves.filter(({ player }) => !blocked.has(player.id));
    const pairs = active.filter(({ role }) => role === "Transporter").map(({ targetIds }) => targetIds);
    const saves = new Set();
    const oathSaves = new Set(getAlivePlayers()
      .filter((player) => player.oath?.shieldNight === game.nightNumber && !blocked.has(player.id))
      .map((player) => player.oath.targetId));
    const deaths = new Set();
    const forcedDeaths = new Set();
    const vampireTally = {};
    game.doctorLastSave = {};

    for (const { player, role, targetId, guess } of active) {
      if (!targetId) continue;
      if (role === "Seer") {
        if (!resolveSeerGuess(player, getPlayer(targetId), guess)) forcedDeaths.add(player.id);
        continue;
      }
      const target = getPlayer(remapTarget(targetId, pairs));
      if (role === "Doctor") {
        saves.add(target.id);
        game.doctorLastSave[player.id] = targetId;
      } else if (role === "Detective") {
        reportInvestigation(player, target);
      } else if (role === "Hunter" && target.id !== player.oath?.targetId) {
        const [victim, recoil] = hunterShot(player, target);
        deaths.add(victim);
        if (recoil) forcedDeaths.add(recoil);
      } else if (role === "Vampire" && target.id !== player.oath?.targetId) {
        vampireTally[target.id] = (vampireTally[target.id] || 0) + 1;
      }
    }

    const vampirePick = getTopTargetFromTally(vampireTally).targetId;
    if (vampirePick && !saves.has(vampirePick)) deaths.add(vampirePick);
    for (const id of oathSaves) deaths.delete(id);
    for (const id of forcedDeaths) deaths.add(id);
    for (const id of deaths) eliminate(getPlayer(id));

    const names = [...deaths].map(getPlayerName);
    const outcome = names.length ? `Lost overnight: ${names.join(", ")}.` : "Everyone survived the night.";
    pushMessage(outcome);
    announceToTable(outcome);
    for (const id of deaths) revealOath(getPlayer(id));

    game.nightChoices.clear();
    if (checkWinConditions()) return;

    game.phase = "day";
    game.dayNumber += 1;
    game.dayVotes = {};
    pushMessage(`Day ${game.dayNumber} begins. Discuss and vote.`);
    announceToTable(`Day ${game.dayNumber}. Discuss and vote on your phones.`);
    startClock(timing.day, resolveVotes);
  }

  // Day voting resolution
  function allDayVotesSubmitted() {
    const aliveIds = getAlivePlayers().map((player) => player.id);
    if (aliveIds.length === 0) return false;
    return aliveIds.every((playerId) => game.dayVotes[playerId]);
  }

  function isDeadlock() {
    if (!game.deadlockDraw || !allDayVotesSubmitted()) return false;
    const roles = getAlivePlayers().map((player) => player.role);
    return roles.length === 3 && ["Vampire", "Jester", "Villager"].every((role) => roles.includes(role));
  }

  function resolveVotes() {
    if (game.phase !== "day") return;

    const tally = {};

    Object.entries(game.dayVotes).forEach(([voterId, targetId]) => {
      const voter = getPlayer(voterId);
      const target = getPlayer(targetId);
      if (!voter?.alive || !target?.alive) return;

      const weight = voter.role === "Mayor" && voter.mayorRevealed ? 2 : 1;
      tally[targetId] = (tally[targetId] || 0) + weight;
    });
    for (const [voterId, targetId] of game.fogBoosts) {
      const voter = getPlayer(voterId);
      if (voter?.alive && canVoteFor(voter, targetId)) tally[targetId] = (tally[targetId] || 0) + 1;
    }

    const voteResult = getTopTargetFromTally(tally);

    if (voteResult.tied && isDeadlock()) {
      setGameOver("Draw", "The Vampire, Jester and Villager each received one vote.");
      return;
    }
    if (!voteResult.targetId || voteResult.tied) {
      const message = voteResult.tied ? "The vote tied. No one was eliminated." : "No votes were cast. No one was eliminated.";
      pushMessage(message);
      announceToTable(message);
    } else {
      const eliminated = getPlayer(voteResult.targetId);
      if (eliminated?.alive) {
        eliminated.jesterWon = eliminated.role === "Jester";
        eliminate(eliminated);
        const outcome = eliminated.jesterWon
          ? `${eliminated.name} was voted out and earned a Jester win.` : `${eliminated.name} was voted out.`;
        pushMessage(outcome);
        announceToTable(outcome);
        revealOath(eliminated);
      }
    }

    if (checkWinConditions()) return;

    startNight();
  }

function activeMatch() {
    return game.phase === "day" || game.phase === "night";
  }

  function canAct(player) {
    return Boolean(player?.alive && activeMatch() && Date.now() < game.clock?.deadline);
  }

  function eliminate(player) {
    player.alive = false;
    delete game.dayVotes[player.id];
    for (const [voter, target] of Object.entries(game.dayVotes)) {
      if (target === player.id) delete game.dayVotes[voter];
    }
  }

  function canRevealOath(player) {
    if (!player.oath || player.oath.revealed || !canAct(player)) return false;
    const living = getAlivePlayers();
    const vampires = living.filter(({ role }) => role === "Vampire").length;
    const lostAccuser = player.oath.targetId && !isAlive(player.oath.targetId);
    return Boolean(lostAccuser || living.length <= 2 * vampires + 2);
  }

  function revealOath(player) {
    const oath = player.oath;
    if (!oath || oath.revealed) return;
    oath.revealed = true;
    const detail = oath.targetId ? ` They vowed to protect ${getPlayerName(oath.targetId)}, their first accuser.`
      : " It required them to protect the first person who accused them of being a Vampire.";
    const message = `${player.name} had the Accuser’s Oath.${detail}`;
    pushMessage(message);
    announceToTable(message);
  }

  function recordAccuser(player, targetId) {
    if (!canAct(player) || !player.oath || player.oath.targetId) return "This oath is no longer available.";
    if (player.id === targetId || !isAlive(targetId)) return "Choose another living player.";
    player.oath.targetId = targetId;
    player.oath.shieldNight = game.phase === "night" ? game.nightNumber : game.nightNumber + 1;
    if (game.dayVotes[player.id] === targetId) delete game.dayVotes[player.id];
    return null;
  }

  function submitNightAction(player, payload) {
    if (!canAct(player) || game.phase !== "night" || payload?.nightKey !== game.nightKey) {
      return "The night has closed.";
    }

    const previous = game.nightChoices.get(player.id);
    if (payload.oath === true && !previous?.guess) {
      const error = recordAccuser(player, payload.targetId);
      if (!error) game.nightChoices.set(player.id, { oath: true });
      return error;
    }
    if (previous) return "Your choice is already locked in.";

    const role = nightRole(player);
    const targets = nightTargets(player, role);
    const { targetId, targetIds } = payload;
    if (payload.skip === true) {
      if (role === "Vampire" && !game.vampireCanSkip && targets.length) return "Choose an available player.";
      game.nightChoices.set(player.id, { skip: true });
      return null;
    }

    const valid = (id) => targets.some((target) => target.id === id);
    if (role === "Transporter") {
      if (!Array.isArray(targetIds) || targetIds.length !== 2 || targetIds[0] === targetIds[1] || !targetIds.every(valid)) {
        return "Choose two different living players.";
      }
      game.nightChoices.set(player.id, { targetIds });
    } else {
      if (!valid(targetId)) return "Choose an available player.";
      game.nightChoices.set(player.id, { targetId });
    }
    return null;
  }

  function revealMayor(player) {
    if (!canAct(player) || player.role !== "Mayor" || player.mayorRevealed) return false;
    player.mayorRevealed = true;
    const message = `${player.name} revealed as Mayor. Their vote counts as two.`;
    pushMessage(message);
    announceToTable(message);
    return true;
  }

  function submitVote(voter, targetId) {
    if (!canAct(voter) || game.phase !== "day") return false;
    if (!canVoteFor(voter, targetId)) return false;

    game.dayVotes[voter.id] = targetId;
    if (!game.secretBallot && allDayVotesSubmitted()) resolveVotes();
    return true;
  }

  function canVoteFor(voter, targetId) {
    return isAlive(targetId) && targetId !== voter.id && voter.oath?.targetId !== targetId;
  }

  function canUseFogmaster(player, dayNumber) {
    return canAct(player) && game.phase === "day" && dayNumber === game.dayNumber
      && player.role === "Fogmaster" && !isAutomaticBot(player);
  }

  function resolveSeerGuess(seer, target, guess) {
    seer.abilityUsed = true;
    if (target.role !== guess) {
      pushPrivateMessage(seer.id, "Your guess was wrong.");
      return false;
    }

    seer.publicRole = "Seer";
    target.publicRole = target.role;
    const message = `${seer.name} is the Seer and revealed that ${target.name} is a ${target.role}.`;
    pushMessage(message);
    announceToTable(message);
    const remaining = seerTargets(seer).filter((player) => player !== target).map(({ name }) => name);
    if (remaining.length) pushPrivateMessage(seer.id, `You cannot say these players have a role: ${remaining.join(", ")}.`);
    return true;
  }

  function submitSeerGuess(seer, payload) {
    if (!canAct(seer) || seer.role !== "Seer" || seer.abilityUsed) return "Your guess is no longer available.";
    const { targetId, guess } = payload || {};
    const target = seerTargets(seer).find(({ id }) => id === targetId);
    if (!target || !ROLE_ORDER.includes(guess) || guess === "Villager") return "Choose a highlighted player and a role.";
    if (game.phase === "night") {
      const previous = game.nightChoices.get(seer.id);
      if (payload.nightKey !== game.nightKey || previous?.guess || previous?.oath) return "Your choice is already locked or the night has closed.";
      game.nightChoices.set(seer.id, { targetId, guess });
    } else {
      if (payload.nightKey) return "The night has closed.";
      if (!resolveSeerGuess(seer, target, guess)) {
        eliminate(seer);
        const message = `${seer.name} died.`;
        pushMessage(message);
        announceToTable(message);
        revealOath(seer);
        checkWinConditions();
      }
    }
    return null;
  }

  const handlers = {
    addBot(socket) {
      if (!practice || !isHostSocket(socket) || game.phase !== "lobby") return;
      if (players.size >= MAX_PLAYERS) return sendError(socket, "This room is full.");
      addPracticeBot();
      emitAll();
    },

    removeBot(socket, id) {
      if (!practice || !isHostSocket(socket) || game.phase !== "lobby") return;
      const bot = getPlayer(id);
      if (!bot?.isBot) return;
      detachPlayerSocket(bot, "This bot was removed. Reopen a bot view from the practice room.");
      players.delete(id);
      emitAll();
    },

    setUpAllRoles(socket) {
      if (!practice || !isHostSocket(socket) || game.phase !== "lobby") return;
      for (const role of ROLE_ORDER) game.roleConfig[role] = { enabled: true, count: 1 };
      while (players.size < ROLE_ORDER.length) addPracticeBot();
      emitAll();
    },

    setBotAuto(socket, automatic) {
      const bot = getPlayer(socketToPlayerId.get(socket.id));
      if (!bot?.isBot || typeof automatic !== "boolean") return;
      bot.botAuto = automatic;
      emitAll();
    },

    updateConfig(socket, payload) {
      if (!isHostSocket(socket)) return;
      if (game.phase !== "lobby") return;
      const { role, enabled, count, vampireCanSkip, oathMode, deadlockDraw } = payload || {};

      if (ROLE_ORDER.includes(role)) {
        game.roleConfig[role] = {
          enabled: Boolean(enabled),
          count: clampCount(count),
        };
      }

      if (typeof vampireCanSkip === "boolean") {
        game.vampireCanSkip = vampireCanSkip;
      }
      if (OATH_MODES.includes(oathMode)) game.oathMode = oathMode;
      if (typeof deadlockDraw === "boolean") game.deadlockDraw = deadlockDraw;

      emitAll();
    },

    startGame(socket) {
      if (!isHostSocket(socket)) return;
      startGame(socket);
      emitAll();
    },

    resetGame(socket) {
      if (!isHostSocket(socket)) return;
      resetGame();
      emitAll();
    },

    endGame(socket) {
      if (!isHostSocket(socket)) return;
      if (!game.hasStarted || game.phase === "gameover") return;
      setGameOver("No winner", "The host ended the game.");
      emitAll();
    },

    forceSleep(socket) {
      if (!isHostSocket(socket)) return;
      if (game.phase !== "day") return;
      startNight();
      emitAll();
    },

    resolveNight(socket) {
      if (!isHostSocket(socket)) return;
      resolveNight();
      emitAll();
    },

    nightAction(socket, payload, acknowledge) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      const error = isAutomaticBot(player) ? "Take control before choosing an action." : submitNightAction(player, payload);
      if (!error) emitPlayer(player);
      if (typeof acknowledge === "function") acknowledge(error);
    },

    recordAccuser(socket, targetId) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      if (isAutomaticBot(player) || game.phase !== "day") return;
      const error = recordAccuser(player, targetId);
      if (error) return sendError(socket, error);
      emitAll();
    },

    revealOath(socket) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      if (!player || isAutomaticBot(player) || !canRevealOath(player)) return;
      revealOath(player);
      emitAll();
    },

    seerGuess(socket, payload, acknowledge) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      const atNight = game.phase === "night";
      const error = isAutomaticBot(player) ? "Take control before guessing." : submitSeerGuess(player, payload);
      if (!error) {
        if (atNight) emitPlayer(player);
        else emitAll();
      }
      if (typeof acknowledge === "function") acknowledge(error);
    },

    hunterShot(socket, targetId) {
      const hunter = getPlayer(socketToPlayerId.get(socket.id));
      if (!canAct(hunter) || game.phase !== "day" || isAutomaticBot(hunter)
        || hunter.role !== "Hunter" || hunter.abilityUsed) return;
      const target = getPlayer(targetId);
      if (!target?.alive || target === hunter || target.id === hunter.oath?.targetId) {
        return sendError(socket, "Choose an available player.");
      }
      const victims = hunterShot(hunter, target).map(getPlayer);
      const message = `A shot rang out. ${victims.map(({ name }) => name).join(" and ")} died.`;
      pushMessage(message);
      announceToTable(message);
      for (const victim of victims) {
        eliminate(victim);
        revealOath(victim);
      }
      if (!checkWinConditions() && !game.secretBallot && allDayVotesSubmitted()) resolveVotes();
      emitAll();
    },

    revealMayor(socket) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      if (!isAutomaticBot(player) && revealMayor(player)) emitAll();
    },

    vote(socket, payload) {
      const voter = getPlayer(socketToPlayerId.get(socket.id));
      if (isAutomaticBot(voter) || !submitVote(voter, payload?.targetId)) return;
      if (game.secretBallot) emitPlayer(voter);
      else emitAll();
    },

    openSecretBallot(socket, payload, acknowledge) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      let error = null;
      if (!canUseFogmaster(player, payload?.dayNumber)) error = "That ability is unavailable.";
      else if (game.secretBallot) error = "A secret ballot is already open.";
      else if (player.fogBallotsUsed >= MAX_SECRET_BALLOTS) error = "You’ve used all three secret ballots.";
      else {
        game.secretBallot = true;
        player.fogBallotsUsed += 1;
        const message = "A secret ballot is open. Vote privately on your phones.";
        pushMessage(message);
        announceToTable(message);
        emitAll();
      }
      if (typeof acknowledge === "function") acknowledge(error);
    },

    boostFogVote(socket, payload, acknowledge) {
      const player = getPlayer(socketToPlayerId.get(socket.id));
      let error = null;
      if (!canUseFogmaster(player, payload?.dayNumber) || !game.secretBallot) error = "Your +1 is available during a secret ballot.";
      else if (player.fogBoostUsed) error = "You’ve already used your +1.";
      else if (!canVoteFor(player, payload.targetId)) error = "Choose an available player.";
      else {
        player.fogBoostUsed = true;
        game.fogBoosts.set(player.id, payload.targetId);
        emitPlayer(player);
      }
      if (typeof acknowledge === "function") acknowledge(error);
    },

    resolveVotes(socket) {
      if (!isHostSocket(socket)) return;
      resolveVotes();
      emitAll();
    },

  };

  return {
    handlers, join, joinBot, leave, tableRoom, buildTableState,
    cue(session, id) {
      if (session === tableSession) return id === 0 ? audioTestCue : game.tableCues.find((entry) => entry.id === id);
    },
    expiresAt: () => emptySince === null ? Infinity : emptySince + 15 * 60 * 1000,
    dispose() {
      stopClock();
      clearTimeout(hostTimer);
      clearTimeout(botTimer);
      if (practice) {
        for (const bot of players.values()) {
          if (bot.isBot) detachPlayerSocket(bot, "This practice room has closed.");
        }
      }
    },
  };
}

module.exports = { createRoom };
