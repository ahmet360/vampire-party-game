const tableSocket = io();
const audioButton = document.getElementById("table-audio");
const replayButton = document.getElementById("table-replay");
const audioStatus = document.getElementById("table-audio-status");
const connectionStatus = document.getElementById("table-connection");
const phaseLabel = document.getElementById("table-phase");
const turnLabel = document.getElementById("table-turn");
const progressLabel = document.getElementById("table-progress");
const cueList = document.getElementById("table-cues");
const roomInput = document.getElementById("table-room-code");
const tableError = document.getElementById("table-error");

let lastCue = null;
let seenCueId = 0;
let tableSession = null;
let roomCode = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
let audioEnabled = false;
let screenLock = null;
let playbackContext = null;
let playback = null;
let audioQueue = Promise.resolve();
let audioGeneration = 0;

roomInput.value = roomCode.slice(0, 6);

function updateAudioControls(status) {
  audioButton.textContent = audioEnabled ? "Mute announcements" : "Enable announcements";
  replayButton.disabled = !audioEnabled || !lastCue;
  if (status) audioStatus.textContent = status;
}

function playCue(cue) {
  if (!audioEnabled || !tableSession) return;
  const generation = audioGeneration;
  const session = tableSession;
  const room = roomCode;
  audioQueue = audioQueue.then(async () => {
    if (generation !== audioGeneration || session !== tableSession) return;
    const response = await fetch(`/table-audio/${room}/${session}/${cue.id}`, { signal: AbortSignal.timeout(20000) });
    if (response.status === 404 && cue.id !== 0) return;
    if (!response.ok) throw new Error("The announcement could not load.");
    const buffer = await playbackContext.decodeAudioData(await response.arrayBuffer());
    if (generation !== audioGeneration || session !== tableSession) return;

    await new Promise((resolve) => {
      const source = playbackContext.createBufferSource();
      source.buffer = buffer;
      source.connect(playbackContext.destination);
      source.onended = () => {
        if (playback === source) playback = null;
        source.disconnect();
        resolve();
      };
      source.start();
      playback = source;
      updateAudioControls("Announcements are on.");
    });
  }).catch(() => {
    if (generation === audioGeneration) updateAudioControls("A cue could not play. The current cue is on screen.");
  });
}

function clearPlayback() {
  audioGeneration += 1;
  audioQueue = Promise.resolve();
  playback?.stop();
  playback = null;
}

function stopAudio(status) {
  audioEnabled = false;
  clearPlayback();
  screenLock?.release().catch(() => {});
  updateAudioControls(status);
}

async function keepScreenAwake() {
  if (!audioEnabled || !navigator.wakeLock || document.hidden || (screenLock && !screenLock.released)) return;
  try {
    screenLock = await navigator.wakeLock.request("screen");
    if (!audioEnabled) await screenLock.release();
  } catch {
    // The table still works when screen wake lock is unavailable.
  }
}

audioButton.addEventListener("click", async () => {
  if (audioEnabled) {
    stopAudio("Announcements are muted.");
    return;
  }

  const AudioPlayback = window.AudioContext || window.webkitAudioContext;
  if (!AudioPlayback) {
    updateAudioControls("This browser can display cues but cannot play them aloud.");
    audioButton.disabled = true;
    return;
  }

  try {
    audioEnabled = true;
    updateAudioControls("Starting announcements…");
    playbackContext ??= new AudioPlayback();
    await playbackContext.resume();
    if (!audioEnabled) return;
    playCue(lastCue || { id: 0 });
    keepScreenAwake();
  } catch {
    stopAudio("Audio could not start. Tap enable again or follow the cues on screen.");
  }
});

replayButton.addEventListener("click", () => {
  if (!lastCue) return;
  clearPlayback();
  playCue(lastCue);
});

document.addEventListener("visibilitychange", keepScreenAwake);

function watchRoom(code) {
  roomCode = code;
  tableError.classList.add("hidden");
  tableSession = null;
  seenCueId = 0;
  lastCue = null;
  clearPlayback();
  audioButton.disabled = true;
  updateAudioControls();
  tableSocket.emit("watchTable", roomCode);
}

document.getElementById("table-form").addEventListener("submit", (event) => {
  event.preventDefault();
  watchRoom(roomInput.value.trim().toUpperCase());
});

tableSocket.on("connect", () => {
  connectionStatus.textContent = "Connected";
  if (roomCode) tableSocket.emit("watchTable", roomCode);
});

tableSocket.on("disconnect", () => {
  connectionStatus.textContent = "Reconnecting…";
});

tableSocket.on("tableError", (message) => {
  stopAudio("");
  tableSession = null;
  lastCue = null;
  tableError.textContent = message;
  tableError.classList.remove("hidden");
  phaseLabel.textContent = "Lobby";
  turnLabel.textContent = "Connect to a room";
  progressLabel.textContent = "";
  cueList.replaceChildren();
  document.getElementById("table-clock").replaceChildren();
  audioButton.disabled = true;
  updateAudioControls("Choose a room to enable announcements.");
});

tableSocket.on("tableState", (state) => {
  if (state.roomCode !== roomCode) return;
  tableError.classList.add("hidden");
  const previousSession = tableSession;
  tableSession = state.session;
  const url = new URL(location.href);
  url.searchParams.set("room", roomCode);
  history.replaceState(null, "", url);
  document.getElementById("table-player-link").href = `/?room=${roomCode}`;
  audioButton.disabled = false;
  document.body.dataset.phase = state.phase;
  if (state.phase === "night") {
    phaseLabel.textContent = `Room ${roomCode} · Night ${state.nightNumber}`;
    turnLabel.textContent = "Make a private choice";
    progressLabel.textContent = "";
  } else if (state.phase === "day") {
    phaseLabel.textContent = `Room ${roomCode} · Day ${state.dayNumber}`;
    turnLabel.textContent = "Discuss and vote";
    progressLabel.textContent = `${state.votesCast} of ${state.aliveCount} votes in`;
  } else if (state.phase === "gameover") {
    phaseLabel.textContent = `Room ${roomCode} · Game over`;
    const heading = { "No winner": "The host ended the game", Draw: "Draw" };
    turnLabel.textContent = heading[state.winner] || `Winner: ${state.winner}`;
    progressLabel.textContent = "";
  } else {
    phaseLabel.textContent = `Room ${roomCode} · Lobby`;
    turnLabel.textContent = "Waiting for the host";
    progressLabel.textContent = `${state.playerCount} ${state.playerCount === 1 ? "player" : "players"} in the lobby`;
  }

  lastCue = state.cues.at(-1) || null;
  if (previousSession === state.session) {
    for (const cue of state.cues) {
      if (cue.id > seenCueId) playCue(cue);
    }
  } else if (previousSession) {
    clearPlayback();
  }
  seenCueId = lastCue?.id || 0;
  gameClock.set(state.clock, state.serverTime);
  document.getElementById("table-clock").innerHTML = gameClock.markup(state.phase === "day" ? "Voting ends in" : "Night ends in");
  gameClock.refresh();
  cueList.replaceChildren(...state.cues.slice().reverse().map(({ text }) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  updateAudioControls();
});
