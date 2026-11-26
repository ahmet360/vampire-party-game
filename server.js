// ##################################### 1
// Imports and basic server setup
const express = require("express");
const { randomUUID } = require("node:crypto");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const { renderAnnouncement } = require("./announce-audio");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const HOST_CODE = process.env.HOST_CODE?.trim();
const renderOrigin = process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).origin : null;

if (!HOST_CODE) throw new Error("Set HOST_CODE before starting the server.");

const io = new Server(server, {
  maxHttpBufferSize: 8192,
  allowRequest(request, callback) {
    const { origin, host } = request.headers;
    const permitted = !origin || (renderOrigin
      ? origin === renderOrigin
      : origin === `http://${host}` || origin === `https://${host}`);
    callback(null, permitted);
  },
});

app.disable("x-powered-by");
const websocketSource = renderOrigin ? renderOrigin.replace(/^https:/, "wss:") : "ws: wss:";
app.use((request, response, next) => {
  response.set({
    "Content-Security-Policy": `default-src 'self'; connect-src 'self' ${websocketSource}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  next();
});
app.get("/healthz", (request, response) => response.type("text").send("ok"));
app.get("/table", (request, response) => response.sendFile(path.join(__dirname, "public", "table.html")));
app.get("/table-audio/:session/:id", sendAnnouncementAudio);
app.use(express.static(path.join(__dirname, "public")));

// ##################################### 2
// Role definitions and default settings
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
  Villager: "Keep watch during the night, then vote during the day and find the vampires.",
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

// ##################################### 3
// Game state
const players = new Map();
const socketToPlayerId = new Map();
const tableRoom = "table-announcer";
const tableSession = randomUUID();
const spokenAudio = new WeakMap();
const audioTestCue = { id: 0, text: "Announcements are on." };
let cueSequence = 0;

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
  };
}

// ##################################### 4
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
    const j = Math.floor(Math.random() * (i + 1));
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

async function sendAnnouncementAudio(request, response) {
  if (request.params.session !== tableSession || !/^\d+$/.test(request.params.id)) return response.sendStatus(404);
  const id = Number(request.params.id);
  const cue = id === 0 ? audioTestCue : game.tableCues.find((entry) => entry.id === id);
  if (!cue) return response.sendStatus(404);

  try {
    if (!spokenAudio.has(cue)) spokenAudio.set(cue, renderAnnouncement(cue.text));
    const audio = await spokenAudio.get(cue);
    response.set("Cache-Control", "no-store").type("audio/wav").send(audio);
  } catch {
    response.sendStatus(503);
  }
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
    session: tableSession,
    phase: game.phase,
    dayNumber: game.dayNumber,
    nightNumber: game.nightNumber,
    playerCount: getAllPlayers().length,
    aliveCount: getAlivePlayers().length,
    votesCast: Object.keys(game.dayVotes).length,
    nightTurn: player ? { name: player.name, connected: player.connected, number: turn.number, total: turn.total } : null,
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

// ##################################### 5
// Public state builder and sync
function buildStateFor(playerId) {
  const me = getPlayer(playerId);
  const turnIndex = game.nightTurns.indexOf(playerId);

  return {
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

// ##################################### 6
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
  for (const [playerId, player] of players.entries()) {
    if (!player.connected) {
      players.delete(playerId);
      continue;
    }

    player.role = null;
    player.alive = true;
    player.mayorRevealed = false;
    player.hunterUsed = false;
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

// ##################################### 7
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

// ##################################### 8
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
  if (turn) announceToTable(`${getPlayerName(turn.playerId)}, it's your turn.`);
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

// ##################################### 9
// Night resolution
function resolveNight() {
  if (game.phase !== "night") return;

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
}

// ##################################### 10
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

// ##################################### 11
// Socket.IO events
io.on("connection", (socket) => {
  socket.on("watchTable", () => {
    socket.join(tableRoom);
    socket.emit("tableState", buildTableState());
  });

  socket.on("join", (payload) => {
    if (!payload || typeof payload !== "object" || socketToPlayerId.has(socket.id)) return;
    const { sessionId, name, hostCode } = payload;
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
      return sendError(socket, "Unable to join. Refresh the page and try again.");
    }

    const submittedCode = typeof hostCode === "string" ? hostCode.trim() : "";
    const wantsHost = submittedCode === HOST_CODE;
    if (submittedCode && !wantsHost) return sendError(socket, "That host code is incorrect.");

    const existing = getAllPlayers().find((player) => player.sessionId === sessionId);

    if (existing) {
      if (existing.socketId) socketToPlayerId.delete(existing.socketId);
      existing.socketId = socket.id;
      existing.connected = true;
      existing.name = cleanName(name);
      if (wantsHost) existing.isHost = true;
      socketToPlayerId.set(socket.id, existing.id);
      pushMessage(`${existing.name} reconnected.`);
      emitAll();
      return;
    }

    if (players.size >= 64) return sendError(socket, "The room is full.");

    const newPlayer = {
      id: randomUUID(),
      sessionId,
      socketId: socket.id,
      connected: true,
      name: cleanName(name),
      isHost: wantsHost,
      alive: game.phase === "lobby",
      role: null,
      mayorRevealed: false,
      hunterUsed: false,
      privateMessages: [],
    };

    players.set(newPlayer.id, newPlayer);
    if (game.phase !== "lobby") {
      pushPrivateMessage(newPlayer.id, "A game is already running, so you joined as a spectator until reset.");
    }

    socketToPlayerId.set(socket.id, newPlayer.id);
    pushMessage(`${newPlayer.name} joined${newPlayer.isHost ? " as host" : ""}.`);
    emitAll();
  });

  socket.on("updateConfig", (payload) => {
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
  });

  socket.on("startGame", () => {
    if (!isHostSocket(socket)) return;
    startGame(socket);
    emitAll();
  });

  socket.on("resetGame", () => {
    if (!isHostSocket(socket)) return;
    resetGame();
    emitAll();
  });

  socket.on("endGame", () => {
    if (!isHostSocket(socket)) return;
    if (!game.hasStarted || game.phase === "gameover") return;
    setGameOver("No winner", "The host ended the game.");
    emitAll();
  });

  socket.on("forceSleep", () => {
    if (!isHostSocket(socket)) return;
    if (game.phase !== "day") return;
    startNight();
    emitAll();
  });

  socket.on("resolveNight", () => {
    if (!isHostSocket(socket)) return;
    resolveNight();
    emitAll();
  });

  socket.on("skipNightTurn", (turnKey) => {
    const turn = getNightTurn();
    if (!isHostSocket(socket) || !turn || turn.key !== turnKey) return;
    advanceNightTurn();
    emitAll();
  });

  socket.on("nightAction", (payload, acknowledge) => {
    const playerId = socketToPlayerId.get(socket.id);
    const player = getPlayer(playerId);
    const turn = getNightTurn();
    const report = typeof acknowledge === "function" ? acknowledge : () => {};
    if (!player?.alive || !turn || turn.playerId !== playerId || turn.key !== payload?.turnKey) {
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
      else if (!skip) pushPrivateMessage(playerId, `You kept watch on ${getPlayerName(targetId)}.`);
    }

    advanceNightTurn();
    emitAll();
    report(null);
  });

  socket.on("revealMayor", () => {
    const playerId = socketToPlayerId.get(socket.id);
    const player = getPlayer(playerId);
    if (!player?.alive || player.role !== "Mayor" || player.mayorRevealed) return;
    if (game.phase !== "day") return;

    player.mayorRevealed = true;
    pushMessage(`${player.name} has revealed as the Mayor! Their vote now counts as 2.`);
    emitAll();
  });

  socket.on("vote", (payload) => {
    const voterId = socketToPlayerId.get(socket.id);
    const voter = getPlayer(voterId);
    if (!voter?.alive || game.phase !== "day") return;
    const targetId = payload?.targetId;
    if (!isAlive(targetId)) return;

    game.dayVotes[voterId] = targetId;

    if (allDayVotesSubmitted()) {
      resolveVotes();
    }

    emitAll();
  });

  socket.on("resolveVotes", () => {
    if (!isHostSocket(socket)) return;
    resolveVotes();
    emitAll();
  });

  socket.on("disconnect", () => {
    const playerId = socketToPlayerId.get(socket.id);
    socketToPlayerId.delete(socket.id);

    const player = getPlayer(playerId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;

    if (game.phase === "lobby") {
      players.delete(playerId);
    } else {
      pushMessage(`${player.name} disconnected.`);
    }

    emitAll();
  });
});

// ##################################### 12
// Local network URL printing and server start
function getLocalNetworkUrls() {
  const urls = [];
  const nets = os.networkInterfaces();

  Object.values(nets).forEach((netList) => {
    netList.forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${PORT}`);
      }
    });
  });

  return urls;
}

server.listen(PORT, HOST, () => {
  console.log(`Vampire game listening on ${HOST}:${PORT}`);
  if (HOST !== "0.0.0.0" || process.env.RENDER) return;
  console.log("Open this on phones connected to the same Wi-Fi:");

  const urls = getLocalNetworkUrls();
  if (urls.length === 0) {
    console.log(`http://YOUR-LAPTOP-IP:${PORT}`);
  } else {
    urls.forEach((url) => console.log(url));
  }
});
