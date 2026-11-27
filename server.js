const express = require("express");
const { randomInt } = require("node:crypto");
const http = require("node:http");
const { isIP } = require("node:net");
const path = require("node:path");
const { Server } = require("socket.io");
const { createRoom } = require("./game-room");
const { renderAnnouncement } = require("./announce-audio");

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const renderOrigin = process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).origin : null;
const websocketSource = renderOrigin ? renderOrigin.replace(/^https:/, "wss:") : "ws: wss:";
const io = new Server(server, {
  maxHttpBufferSize: 8192,
  allowRequest({ headers: { origin, host } }, callback) {
    const allowed = !origin || (renderOrigin
      ? origin === renderOrigin
      : origin === `http://${host}` || origin === `https://${host}`);
    callback(null, allowed);
  },
});

const timing = {
  night: durationFromEnvironment("NIGHT_TURN_MS", 25000),
  day: durationFromEnvironment("DAY_VOTE_MS", 90000),
};
const roomAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const rooms = new Map();
const creationAttempts = new Map();
const voiceCache = new WeakMap();
const playerEvents = [
  "updateConfig", "startGame", "resetGame", "endGame", "forceSleep", "resolveNight",
  "skipNightTurn", "nightAction", "revealMayor", "vote", "resolveVotes",
  "addBot", "removeBot", "setUpAllRoles", "setBotAuto",
];

app.disable("x-powered-by");
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
app.get("/table-audio/:room/:session/:id", async (request, response) => {
  const { room, session, id } = request.params;
  if (!/^\d{1,10}$/.test(id)) return response.sendStatus(404);
  const cue = rooms.get(room)?.cue(session, Number(id));
  if (!cue) return response.sendStatus(404);

  try {
    if (!voiceCache.has(cue)) voiceCache.set(cue, renderAnnouncement(cue.text));
    const wave = await voiceCache.get(cue);
    response.set("Cache-Control", "no-store").type("audio/wav").send(wave);
  } catch {
    voiceCache.delete(cue);
    response.sendStatus(503);
  }
});
app.use(express.static(path.join(__dirname, "public")));

function durationFromEnvironment(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value >= 1000 && value <= 300000 ? value : fallback;
}

function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => roomAlphabet[randomInt(roomAlphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function roomCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22,80}$/.test(value);
}

function mayCreateRoom(socket) {
  const forwarded = renderOrigin && socket.handshake.headers["x-forwarded-for"]?.split(",").at(-1)?.trim();
  const address = isIP(forwarded || "") ? forwarded : socket.handshake.address;
  const now = Date.now();
  const existing = creationAttempts.get(address);
  if (!existing || existing.until <= now) {
    if (!existing && creationAttempts.size >= 2000) return false;
    creationAttempts.set(address, { count: 1, until: now + 5 * 60 * 1000 });
    return true;
  }
  if (existing.count >= 12) return false;
  existing.count += 1;
  return true;
}

io.on("connection", (socket) => {
  socket.on("createRoom", (payload) => {
    if (socket.data.gameCode || !validSessionId(payload?.sessionId)) return;
    if (rooms.size >= 80 || !mayCreateRoom(socket)) {
      return socket.emit("errorMessage", "Room creation is busy. Give it a moment and try again.");
    }
    const code = newRoomCode();
    const room = createRoom(io, code, payload.sessionId, timing, payload.practice === true);
    rooms.set(code, room);
    room.join(socket, payload.sessionId, payload.name);
  });

  socket.on("join", (payload) => {
    if (socket.data.gameCode || !validSessionId(payload?.sessionId)) return;
    const room = rooms.get(roomCode(payload?.code));
    if (!room) return socket.emit("errorMessage", "That room is closed or the code is incorrect.");
    const error = room.join(socket, payload.sessionId, payload.name);
    if (error) socket.emit("errorMessage", error);
  });

  socket.on("joinBot", (payload) => {
    if (socket.data.gameCode) return;
    const room = rooms.get(roomCode(payload?.code));
    if (!room?.joinBot(socket, payload?.token)) {
      socket.emit("roomLeft", "This bot window has expired. Reopen its view from the practice room.");
    }
  });

  socket.on("leaveRoom", () => {
    const room = rooms.get(socket.data.gameCode);
    socket.data.gameCode = null;
    room?.leave(socket, true);
    socket.emit("roomLeft");
  });

  socket.on("watchTable", (value) => {
    const previous = rooms.get(socket.data.tableCode);
    if (previous) socket.leave(previous.tableRoom);
    socket.data.tableCode = null;
    const code = roomCode(value);
    const room = rooms.get(code);
    if (!room) return socket.emit("tableError", "That room is closed or the code is incorrect.");
    socket.data.tableCode = code;
    socket.join(room.tableRoom);
    socket.emit("tableState", room.buildTableState());
  });

  for (const event of playerEvents) {
    socket.on(event, (...args) => rooms.get(socket.data.gameCode)?.handlers[event](socket, ...args));
  }
  socket.on("disconnect", () => rooms.get(socket.data.gameCode)?.leave(socket, false));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt() > now) continue;
    rooms.delete(code);
    room.dispose();
    io.to(room.tableRoom).emit("tableError", "This room closed after everyone left.");
    io.in(room.tableRoom).socketsLeave(room.tableRoom);
  }
  for (const [address, attempt] of creationAttempts) {
    if (attempt.until <= now) creationAttempts.delete(address);
  }
}, 60000).unref();

server.listen(port, host, () => {
  console.log(`Vampire game listening on ${host}:${port}`);
});
