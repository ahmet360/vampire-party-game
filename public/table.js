const tableSocket = io();
const audioButton = document.getElementById("table-audio");
const replayButton = document.getElementById("table-replay");
const audioStatus = document.getElementById("table-audio-status");
const connectionStatus = document.getElementById("table-connection");
const phaseLabel = document.getElementById("table-phase");
const turnLabel = document.getElementById("table-turn");
const progressLabel = document.getElementById("table-progress");
const cueList = document.getElementById("table-cues");

let lastCue = null;
let seenCueId = 0;
let tableSession = null;
let audioEnabled = false;
let screenLock = null;
let playbackContext = null;
let playback = null;
let audioQueue = Promise.resolve();
let audioGeneration = 0;

function updateAudioControls(status) {
  audioButton.textContent = audioEnabled ? "Mute announcements" : "Enable announcements";
  replayButton.disabled = !audioEnabled || !lastCue;
  if (status) audioStatus.textContent = status;
}

function playCue(cue) {
  if (!audioEnabled || !tableSession) return;
  const generation = audioGeneration;
  const session = tableSession;
  audioQueue = audioQueue.then(async () => {
    if (generation !== audioGeneration || session !== tableSession) return;
    const response = await fetch(`/table-audio/${session}/${cue.id}`);
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
    if (generation === audioGeneration) stopAudio("Audio could not play. Cues will still appear on this screen.");
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

tableSocket.on("connect", () => {
  connectionStatus.textContent = "Connected";
  tableSocket.emit("watchTable");
});

tableSocket.on("disconnect", () => {
  connectionStatus.textContent = "Reconnecting…";
});

tableSocket.on("tableState", (state) => {
  audioButton.disabled = false;
  const turn = state.nightTurn;
  if (state.phase === "night" && turn) {
    phaseLabel.textContent = `Night ${state.nightNumber}`;
    turnLabel.textContent = `${turn.name}, it’s your turn.`;
    progressLabel.textContent = `Turn ${turn.number} of ${turn.total}${turn.connected ? "" : " · Reconnecting"}`;
  } else if (state.phase === "day") {
    phaseLabel.textContent = `Day ${state.dayNumber}`;
    turnLabel.textContent = "Discuss and vote";
    progressLabel.textContent = `${state.votesCast} of ${state.aliveCount} votes in`;
  } else if (state.phase === "gameover") {
    phaseLabel.textContent = "Game over";
    turnLabel.textContent = state.winner === "No winner" ? "The host ended the game" : `Winner: ${state.winner}`;
    progressLabel.textContent = "";
  } else {
    phaseLabel.textContent = "Lobby";
    turnLabel.textContent = "Waiting for the host";
    progressLabel.textContent = `${state.playerCount} ${state.playerCount === 1 ? "player" : "players"} in the lobby`;
  }

  lastCue = state.cues.at(-1) || null;
  if (tableSession === state.session) {
    for (const cue of state.cues) {
      if (cue.id > seenCueId) playCue(cue);
    }
  } else if (tableSession) {
    clearPlayback();
  }
  tableSession = state.session;
  seenCueId = lastCue?.id || 0;
  cueList.replaceChildren(...state.cues.slice().reverse().map(({ text }) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  updateAudioControls();
});
