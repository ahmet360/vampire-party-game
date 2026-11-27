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
];

const ROLE_DESCRIPTIONS = {
  Vampire: "Kill one player each night. Vampires win when alive vampires are equal to or greater than alive non-vampires.",
  Doctor: "Save one player each night. You cannot save the same player two nights in a row.",
  Jester: "You win immediately if the town votes you out. Detective treats Jester as evil.",
  Detective: "Investigate one player each night. Good players show as not evil. Evil players need two checks for exact role.",
  Villager: "Once per game, watch someone to learn at dawn whether they used a targeted ability that night.",
  Hunter: "Once per game, shoot one player at night. If they are a vampire, only they die. Otherwise, both of you die.",
  Mayor: "Reveal once. After revealing, your name turns blue and your vote counts as 2.",
  Transporter: "Choose two players each night. Any night action aimed at one is redirected to the other.",
};

const NIGHT_ACTIONS = {
  Vampire: "vampires",
  Doctor: "doctors",
  Detective: "detectives",
  Hunter: "hunters",
  Transporter: "transporters",
};

const audioTestCue = { id: 0, text: "Announcements are on." };

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

function createRoom(io, code, hostSession, timing) {
  const players = new Map();
  const socketToPlayerId = new Map();
  const tableSession = randomUUID();
  const tableRoom = `announcer:${tableSession}`;
  let cueSequence = 0;
  let phaseTimer;
  let hostTimer;
  let emptySince = Date.now();

  const game = {
    phase: "lobby",
    hasStarted: false,
    dayNumber: 0,
    nightNumber: 0,
    roleConfig: makeDefaultRoleConfig(),
    vampireCanSkip: false,
    nightActions: makeEmptyNightActions(),
    nightTurns: [],
    nightTurnIndex: 0,
    nightCycle: null,
    clock: null,
    dayVotes: {},
    doctorLastSave: {},
    detectiveMemory: {},
    messages: [],
    tableCues: [],
    gameOver: null,
  };

  function makeEmptyNightActions() {
    return {
      vampires: {},
      doctors: {},
      detectives: {},
      hunters: {},
      transporters: {},
      watches: {},
    };
  }

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

  function announceToTable(text, turnKey = null) {
    game.tableCues.push({ id: ++cueSequence, text, turnKey });
    if (game.tableCues.length > 12) game.tableCues.shift();
  }

  function getNightTurn() {
    const playerId = game.nightTurns[game.nightTurnIndex];
    if (game.phase !== "night" || !playerId) return null;
    return {
      key: `${game.nightCycle}:${game.nightTurnIndex}`,
      playerId,
      number: game.nightTurnIndex + 1,
      total: game.nightTurns.length,
    };
  }

  function buildTableState() {
    const turn = getNightTurn();
    const player = turn ? getPlayer(turn.playerId) : null;
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
      votesCast: Object.keys(game.dayVotes).length,
      nightTurn: player ? { key: turn.key, name: player.name, connected: player.connected, number: turn.number, total: turn.total } : null,
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

  function sendError(socket, message) {
    socket.emit("errorMessage", message);
  }

  // Public state builder and sync
  function buildStateFor(playerId) {
    const me = getPlayer(playerId);
    const turnIndex = game.nightTurns.indexOf(playerId);

    return {
      roomCode: code,
      serverTime: Date.now(),
      clock: game.clock,
      timing,
      phase: game.phase,
      hasStarted: game.hasStarted,
      dayNumber: game.dayNumber,
      nightNumber: game.nightNumber,
      roleOrder: ROLE_ORDER,
      roleDescriptions: ROLE_DESCRIPTIONS,
      roleConfig: cloneRoleConfig(),
      vampireCanSkip: game.vampireCanSkip,
      nightTurn: getNightTurn(),
      votesCast: Object.keys(game.dayVotes).length,
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
        mayorRevealed: player.mayorRevealed,
        role: game.phase === "gameover" ? player.role : null,
      })),
      me: me
        ? {
            id: me.id,
            name: me.name,
            connected: me.connected,
            alive: me.alive,
            isHost: me.isHost,
            role: me.role,
            mayorRevealed: me.mayorRevealed,
            hunterUsed: me.hunterUsed,
        villagerWatchUsed: me.villagerWatchUsed,
            privateMessages: me.privateMessages.slice(-10),
            nightTurnComplete: turnIndex >= 0 && turnIndex < game.nightTurnIndex,
            dayVoteTarget: game.dayVotes[me.id] || null,
            doctorLastSave: game.doctorLastSave[me.id] || null,
          }
        : null,
    };
  }

  function emitAll() {
    for (const player of players.values()) {
      if (!player.connected || !player.socketId) continue;
      io.to(player.socketId).emit("state", buildStateFor(player.id));
    }
    io.to(tableRoom).emit("tableState", buildTableState());
  }

  function join(socket, sessionId, name) {
    const existing = getAllPlayers().find((player) => player.sessionId === sessionId);
    if (!existing && players.size >= 24) return "This room is full.";

    const player = existing || {
      id: randomUUID(), sessionId, alive: game.phase === "lobby", role: null,
      mayorRevealed: false, hunterUsed: false, villagerWatchUsed: false, privateMessages: [],
    };
    if (existing?.socketId && existing.socketId !== socket.id) {
      socketToPlayerId.delete(existing.socketId);
      const previousSocket = io.sockets.sockets.get(existing.socketId);
      if (previousSocket) {
        previousSocket.data.gameCode = null;
        previousSocket.emit("roomLeft", "This player rejoined on another tab.");
      }
    }
    player.name = cleanName(name);
    player.socketId = socket.id;
    player.connected = true;
    player.isHost = sessionId === hostSession;
    players.set(player.id, player);
    socketToPlayerId.set(socket.id, player.id);
    socket.data.gameCode = code;
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

  function transferHosting() {
    const candidates = getAllPlayers();
    if (candidates.some((candidate) => candidate.isHost && candidate.connected)) return;
    const successor = candidates.find((candidate) => candidate.connected);
    if (!successor) return;
    for (const candidate of candidates) candidate.isHost = candidate === successor;
    hostSession = successor.sessionId;
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

    player.connected = false;
    player.socketId = null;
    if (game.phase === "lobby") players.delete(playerId);
    const hasPlayers = getAllPlayers().some((candidate) => candidate.connected);
    if (!hasPlayers) emptySince = Date.now();
    else if (player.isHost && transferHost) transferHosting();
    else if (player.isHost) scheduleHostTransfer();
    emitAll();
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

    for (const player of players.values()) {
      player.role = null;
      player.alive = false;
      player.mayorRevealed = false;
      player.hunterUsed = false;
      player.villagerWatchUsed = false;
      player.privateMessages = [];
    }

    shuffledPlayers.forEach((player, index) => {
      player.role = shuffledRoles[index];
      player.alive = true;
      player.mayorRevealed = false;
      player.hunterUsed = false;
      player.privateMessages = [];
    });

    startNight();
  }

  function resetGame() {
    stopClock();
    for (const [playerId, player] of players.entries()) {
      if (!player.connected) {
        players.delete(playerId);
        continue;
      }

      player.role = null;
      player.alive = true;
      player.mayorRevealed = false;
      player.hunterUsed = false;
      player.villagerWatchUsed = false;
      player.privateMessages = [];
    }

    game.phase = "lobby";
    game.hasStarted = false;
    game.dayNumber = 0;
    game.nightNumber = 0;
    game.nightActions = makeEmptyNightActions();
    game.nightTurns = [];
    game.nightTurnIndex = 0;
    game.nightCycle = null;
    game.dayVotes = {};
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
      })),
    };

    pushMessage(`Game over: ${winner}. ${reason}`);
    announceToTable(winner === "No winner" ? "The host ended the game." : `Game over. Winner: ${winner}.`);
  }

  // Win condition checks
  function checkWinConditions() {
    if (!game.hasStarted || game.phase === "gameover") return true;

    const alive = getAlivePlayers();
    const aliveVampires = alive.filter((player) => player.role === "Vampire");
    const aliveNonVampires = alive.filter((player) => player.role !== "Vampire");

    if (aliveVampires.length === 0) {
      setGameOver("Villagers", "All vampires are dead.");
      return true;
    }

    if (aliveVampires.length >= aliveNonVampires.length) {
      setGameOver("Vampires", "Alive vampires are equal to or greater than alive non-vampires.");
      return true;
    }

    return false;
  }

  // Night action helpers
  function startNight() {
    game.phase = "night";
    game.nightNumber += 1;
    game.nightActions = makeEmptyNightActions();
    game.dayVotes = {};
    game.nightTurns = shuffle(getAlivePlayers()).map((player) => player.id);
    game.nightTurnIndex = 0;
    game.nightCycle = randomUUID();

    const message = `Night ${game.nightNumber} begins. Wait for your name before opening your turn.`;
    pushMessage(message);
    announceToTable(message);
    announceNightTurn();
  }

  function announceNightTurn() {
    const turn = getNightTurn();
    if (!turn) return;
    announceToTable(`${getPlayerName(turn.playerId)}, it's your turn.`, turn.key);
    startClock(timing.night, advanceNightTurn);
  }

  function advanceNightTurn() {
    game.nightTurnIndex += 1;
    if (getNightTurn()) announceNightTurn();
    else resolveNight();
  }

  function buildTransporterPairs(actions) {
    const pairs = [];

    Object.entries(actions.transporters).forEach(([transporterId, action]) => {
      const transporter = getPlayer(transporterId);
      if (!transporter?.alive || transporter.role !== "Transporter") return;
      if (action.skip) return;
      if (!Array.isArray(action.targetIds) || action.targetIds.length !== 2) return;

      const [firstId, secondId] = action.targetIds;
      if (firstId === secondId) return;
      if (!isAlive(firstId) || !isAlive(secondId)) return;

      pairs.push([firstId, secondId]);
    });

    return pairs;
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

  // Night resolution
  function resolveNight() {
    if (game.phase !== "night") return;
    stopClock();

    const roleCues = Object.keys(NIGHT_ACTIONS)
      .filter((role) => game.roleConfig[role].enabled && game.roleConfig[role].count > 0)
      .map((role) => `${role} turn closed.`);
    if (roleCues.length) announceToTable(roleCues.join(" "));

    const actions = game.nightActions;
    const transporterPairs = buildTransporterPairs(actions);
    const savedTargets = new Set();
    const deathSet = new Set();

    Object.entries(actions.doctors).forEach(([doctorId, action]) => {
      const doctor = getPlayer(doctorId);
      if (!doctor?.alive || doctor.role !== "Doctor") return;

      if (action.skip || !action.targetId) {
        game.doctorLastSave[doctorId] = null;
        return;
      }

      if (game.doctorLastSave[doctorId] === action.targetId) return;
      if (!isAlive(action.targetId)) return;

      const actualSaveTarget = remapTarget(action.targetId, transporterPairs);
      if (isAlive(actualSaveTarget)) {
        savedTargets.add(actualSaveTarget);
        game.doctorLastSave[doctorId] = action.targetId;
      }
    });

    Object.entries(actions.detectives).forEach(([detectiveId, action]) => {
      const detective = getPlayer(detectiveId);
      if (!detective?.alive || detective.role !== "Detective") return;
      if (action.skip || !action.targetId) return;
      if (!isAlive(action.targetId)) return;

      const actualTargetId = remapTarget(action.targetId, transporterPairs);
      const target = getPlayer(actualTargetId);
      if (!target?.alive) return;

      const isEvil = target.role === "Vampire" || target.role === "Jester";

      if (!isEvil) {
        pushPrivateMessage(detectiveId, `${target.name} is not evil.`);
        return;
      }

      if (!game.detectiveMemory[detectiveId]) game.detectiveMemory[detectiveId] = {};
      const previousChecks = game.detectiveMemory[detectiveId][actualTargetId] || 0;
      const newChecks = previousChecks + 1;
      game.detectiveMemory[detectiveId][actualTargetId] = newChecks;

      if (newChecks === 1) {
        pushPrivateMessage(detectiveId, `${target.name} seems suspicious.`);
      } else {
        pushPrivateMessage(detectiveId, `${target.name}'s exact role is ${target.role}.`);
      }
    });

    Object.entries(actions.hunters).forEach(([hunterId, action]) => {
      const hunter = getPlayer(hunterId);
      if (!hunter?.alive || hunter.role !== "Hunter" || hunter.hunterUsed) return;
      if (action.skip || !action.targetId) return;
      if (!isAlive(action.targetId)) return;

      const actualTargetId = remapTarget(action.targetId, transporterPairs);
      const target = getPlayer(actualTargetId);
      if (!target?.alive) return;

      hunter.hunterUsed = true;
      deathSet.add(actualTargetId);
      if (target.role !== "Vampire") deathSet.add(hunterId);
    });

    const vampireTally = {};

    Object.entries(actions.vampires).forEach(([vampireId, action]) => {
      const vampire = getPlayer(vampireId);
      if (!vampire?.alive || vampire.role !== "Vampire") return;
      if (action.skip) return;
      if (!action.targetId || !isAlive(action.targetId)) return;

      const actualTargetId = remapTarget(action.targetId, transporterPairs);
      if (!isAlive(actualTargetId)) return;

      vampireTally[actualTargetId] = (vampireTally[actualTargetId] || 0) + 1;
    });

    const vampirePick = getTopTargetFromTally(vampireTally);
    if (vampirePick.targetId && !savedTargets.has(vampirePick.targetId)) deathSet.add(vampirePick.targetId);

    for (const playerId of deathSet) {
      const player = getPlayer(playerId);
      if (player?.alive) player.alive = false;
    }

    const moved = new Set(Object.values(NIGHT_ACTIONS).flatMap((group) => Object.entries(actions[group])
      .filter(([, action]) => !action.skip)
      .map(([id]) => id)));
    for (const [observerId, targetId] of Object.entries(actions.watches)) {
      if (!isAlive(observerId)) continue;
      const result = moved.has(targetId) ? "made a targeted move" : "made no targeted move";
      pushPrivateMessage(observerId, `You saw that ${getPlayerName(targetId)} ${result} last night.`);
    }

    const names = [...deathSet].map(getPlayerName);
    const outcome = names.length ? `Lost overnight: ${names.join(", ")}.` : "Everyone survived the night.";
    pushMessage(outcome);
    announceToTable(outcome);

    game.nightActions = makeEmptyNightActions();

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

    const voteResult = getTopTargetFromTally(tally);

    if (!voteResult.targetId || voteResult.tied) {
      pushMessage("The vote tied. No one was eliminated.");
      announceToTable("The vote tied. No one was eliminated.");
    } else {
      const eliminated = getPlayer(voteResult.targetId);
      if (eliminated?.alive) {
        eliminated.alive = false;
        pushMessage(`${eliminated.name} was voted out.`);
        announceToTable(`${eliminated.name} was voted out.`);

        if (eliminated.role === "Jester") {
          setGameOver("Jester", `${eliminated.name} was voted out and wins immediately.`);
          return;
        }
      }
    }

    if (checkWinConditions()) return;

    startNight();
  }

  const handlers = {
    updateConfig(socket, payload) {
      if (!isHostSocket(socket)) return;
      if (game.phase !== "lobby") return;
      const { role, enabled, count, vampireCanSkip } = payload || {};

      if (ROLE_ORDER.includes(role)) {
        game.roleConfig[role] = {
          enabled: Boolean(enabled),
          count: clampCount(count),
        };
      }

      if (typeof vampireCanSkip === "boolean") {
        game.vampireCanSkip = vampireCanSkip;
      }

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

    skipNightTurn(socket, turnKey) {
      const turn = getNightTurn();
      if (!isHostSocket(socket) || !turn || turn.key !== turnKey) return;
      advanceNightTurn();
      emitAll();
    },

    nightAction(socket, payload, acknowledge) {
      const playerId = socketToPlayerId.get(socket.id);
      const player = getPlayer(playerId);
      const turn = getNightTurn();
      const report = typeof acknowledge === "function" ? acknowledge : () => {};
      if (!player?.alive || !turn || turn.playerId !== playerId || turn.key !== payload?.turnKey || Date.now() >= game.clock?.deadline) {
        return report("This turn is no longer available. Check the current turn on your screen.");
      }

      const { role } = player;
      const { targetId, targetIds } = payload;
      const skip = payload.skip === true;
      const group = player.hunterUsed && role === "Hunter" ? null : NIGHT_ACTIONS[role];
      if (role === "Vampire" && skip && !game.vampireCanSkip) return report("The host has disabled skipping for Vampires.");

      if (role === "Transporter") {
        const pair = Array.isArray(targetIds) ? targetIds : [];
        if (!skip && (pair.length !== 2 || pair[0] === pair[1] || !pair.every(isAlive))) {
          return report("Choose two different living players.");
        }
        game.nightActions[group][playerId] = { skip, targetIds: skip ? [] : pair };
      } else {
        if (!skip && (!isAlive(targetId) || (targetId === playerId && role !== "Doctor"))) {
          return report("Choose an available player.");
        }
        if (role === "Doctor" && !skip && game.doctorLastSave[playerId] === targetId) {
          return report("You cannot save the same player two nights in a row.");
        }
        if (group) game.nightActions[group][playerId] = { skip, targetId: skip ? null : targetId };
        else if (!skip && role === "Villager" && !player.villagerWatchUsed) {
          player.villagerWatchUsed = true;
          game.nightActions.watches[playerId] = targetId;
        }
      }

      advanceNightTurn();
      emitAll();
      report(null);
    },

    revealMayor(socket) {
      const playerId = socketToPlayerId.get(socket.id);
      const player = getPlayer(playerId);
      if (!player?.alive || player.role !== "Mayor" || player.mayorRevealed) return;
      if (game.phase !== "day") return;

      player.mayorRevealed = true;
      pushMessage(`${player.name} has revealed as the Mayor! Their vote now counts as 2.`);
      emitAll();
    },

    vote(socket, payload) {
      const voterId = socketToPlayerId.get(socket.id);
      const voter = getPlayer(voterId);
      if (!voter?.alive || game.phase !== "day" || Date.now() >= game.clock?.deadline) return;
      const targetId = payload?.targetId;
      if (!isAlive(targetId) || targetId === voterId) return;

      game.dayVotes[voterId] = targetId;

      if (allDayVotesSubmitted()) {
        resolveVotes();
      }

      emitAll();
    },

    resolveVotes(socket) {
      if (!isHostSocket(socket)) return;
      resolveVotes();
      emitAll();
    },

  };

  return {
    handlers, join, leave, tableRoom, buildTableState,
    cue(session, id) {
      if (session === tableSession) return id === 0 ? audioTestCue : game.tableCues.find((entry) => entry.id === id);
    },
    expiresAt: () => emptySince === null ? Infinity : emptySince + 15 * 60 * 1000,
    dispose() {
      stopClock();
      clearTimeout(hostTimer);
    },
  };
}

module.exports = { createRoom };
