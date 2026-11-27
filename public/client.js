// ##################################### 1
// Socket setup, local player id, and global state
const socket = io();

let state = null;
let selectedTransporterTargets = [];
let joinDetails = null;
let privateView = false;
let pendingNightChoice = null;
let savingTurn = false;
let roomMode = "create";

const invitedRoom = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";

const storedId = localStorage.getItem("vampirePlayerId");
const playerId = /^[A-Za-z0-9_-]{22,80}$/.test(storedId || "") ? storedId : makePlayerId();
localStorage.setItem("vampirePlayerId", playerId);

function makePlayerId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID().replaceAll("-", "_");
  }

  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (value) => value.toString(16).padStart(2, "0")).join("");
}

// ##################################### 2
// DOM helpers
function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function findPlayer(id) {
  return state?.players?.find((player) => player.id === id) || null;
}

function playerName(id) {
  return findPlayer(id)?.name || "Unknown";
}

function alivePlayers() {
  return state?.players?.filter((player) => player.alive) || [];
}

function otherAlivePlayers() {
  return alivePlayers().filter((player) => player.id !== state.me.id);
}

function phaseLabel(phase) {
  const labels = {
    lobby: "Lobby",
    night: "Night / Sleep",
    day: "Day Voting",
    gameover: "Game Over",
  };

  return labels[phase] || phase;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

// ##################################### 3
// Join screen handling
function setRoomMode(mode) {
  roomMode = mode;
  const joining = mode === "join";
  $("mode-create").setAttribute("aria-pressed", String(!joining));
  $("mode-join").setAttribute("aria-pressed", String(joining));
  $("room-code-field").classList.toggle("hidden", !joining);
  $("room-code-input").required = joining;
  $("room-code-input").disabled = !joining;
  $("join-submit").textContent = joining ? "Join room" : "Create room";
  $("join-error").classList.add("hidden");
}

$("mode-create").addEventListener("click", () => setRoomMode("create"));
$("mode-join").addEventListener("click", () => setRoomMode("join"));
if (invitedRoom) $("room-code-input").value = invitedRoom.slice(0, 6);
setRoomMode(invitedRoom ? "join" : "create");

try {
  const previousRoom = JSON.parse(sessionStorage.getItem("vampireRoom"));
  if (previousRoom?.code === invitedRoom && typeof previousRoom.name === "string") {
    $("name-input").value = previousRoom.name;
    joinDetails = { ...previousRoom, sessionId: playerId };
  }
} catch {
  // A fresh form is still available when browser storage is unavailable.
}

$("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("join-error").classList.add("hidden");
  joinDetails = {
    sessionId: playerId,
    name: $("name-input").value.trim(),
    code: roomMode === "join" ? $("room-code-input").value.trim().toUpperCase() : "",
  };
  if (!joinDetails.name) {
    $("name-input").focus();
    return showToast("Enter a name to play.");
  }
  socket.emit(roomMode === "join" ? "join" : "createRoom", joinDetails);
});

socket.on("connect", () => {
  if (joinDetails?.code) socket.emit("join", joinDetails);
});

function roomLink(path = "/") {
  const url = new URL(path, location.origin);
  url.searchParams.set("room", state.roomCode);
  return url.href;
}

async function copyInvite() {
  const code = state.roomCode;
  try {
    await navigator.clipboard.writeText(roomLink());
    showToast(`Invite copied for room ${code}.`);
  } catch {
    showToast(`Share room code ${code}.`);
  }
}

$("share-room-btn").addEventListener("click", copyInvite);
$("leave-room-btn").addEventListener("click", () => socket.emit("leaveRoom"));

function returnToRooms(message) {
  state = null;
  joinDetails = null;
  gameClock.set(null);
  sessionStorage.removeItem("vampireRoom");
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState(null, "", url);
  document.body.removeAttribute("data-phase");
  $("game-screen").classList.add("hidden");
  $("night-panel").classList.add("hidden");
  $("phase-transition").classList.add("hidden");
  $("join-screen").classList.remove("hidden");
  $("room-code-input").value = "";
  setRoomMode("create");
  if (message) showToast(message);
}

function showTransition(title, symbol, kind = "phase") {
  const banner = $("phase-transition");
  window.clearTimeout(showTransition.timer);
  banner.classList.add("hidden");
  banner.replaceChildren();
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = symbol;
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  banner.append(mark, titleNode);
  banner.dataset.kind = kind;
  void banner.offsetWidth;
  banner.classList.remove("hidden");
  showTransition.timer = window.setTimeout(() => banner.classList.add("hidden"), 1500);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && privateView) hidePrivateView();
});

// ##################################### 4
// Main render function
function render() {
  if (!state || !state.me) return;

  $("join-screen").classList.add("hidden");
  document.body.dataset.phase = state.phase;
  $("room-label").textContent = `Room ${state.roomCode}`;
  const atNight = state.phase === "night";
  $("night-panel").classList.toggle("hidden", !atNight);
  $("game-screen").classList.toggle("hidden", atNight);
  if (atNight) {
    $("app").replaceChildren();
    renderNightScreen();
    bindDynamicButtons();
    gameClock.refresh();
    return;
  }
  $("night-panel").replaceChildren();
  $("game-screen").classList.remove("hidden");

  $("top-player-list").innerHTML = renderPlayerList();
  $("app").innerHTML = `
    ${renderStatusCard()}
    ${renderRoleCard()}
    ${renderHostControls()}
    ${renderActionCard()}
    ${renderMessagesCard()}
  `;
  $("role-descriptions").innerHTML = renderRoleDescriptions();

  bindDynamicButtons();
  gameClock.refresh();
}

function renderNightScreen() {
  const turn = state.nightTurn;
  const active = turn ? findPlayer(turn.playerId) : null;
  const yourTurn = active?.id === state.me.id;
  const isOpen = yourTurn && privateView && !savingTurn;
  let heading = "Wait for your turn";
  if (yourTurn) heading = "It's your turn";
  if (savingTurn) heading = "Saving your choice…";
  if (state.me.nightTurnComplete) heading = "Turn complete";
  if (!state.me.alive) heading = "Watching the game";

  $("night-panel").innerHTML = `
    <section class="card night-cover">
      <span class="phase-glyph" aria-hidden="true">☾</span>
      <p class="round-label">Night ${state.nightNumber}${turn ? ` · Turn ${turn.number} of ${turn.total}` : ""}</p>
      <h1>${isOpen ? "Your private turn" : heading}</h1>
      ${isOpen ? `<button id="hide-private-btn" class="secondary">Cover screen</button>`
        : `<p>${yourTurn ? "Open your turn to make a choice." : active ? `${escapeHtml(active.name)}${active.connected ? " is taking their turn." : " is reconnecting."}` : "The night is ending."}</p>
          ${yourTurn && !savingTurn ? `<button id="show-private-btn" class="primary">Open my turn</button>` : ""}`}
      ${gameClock.markup("Turn ends in")}
    </section>
    ${isOpen ? `${renderRoleCard()}${pendingNightChoice ? renderNightConfirmation() : renderNightActions()}` : ""}
    ${!isOpen && state.me.isHost ? `
      <details class="card night-host">
        <summary>Host controls</summary>
        <div class="button-grid">
          <button id="skip-night-btn" class="secondary" ${active ? "" : "disabled"}>Skip current turn</button>
          <button id="resolve-night-btn" class="secondary">End night early</button>
          <button id="end-game-btn" class="secondary">End game</button>
        </div>
      </details>` : ""}
  `;
}

function hidePrivateView() {
  privateView = false;
  pendingNightChoice = null;
  selectedTransporterTargets = [];
  render();
}

function renderNightConfirmation() {
  return `
    <section class="card action-card">
      <h2>Lock in your choice?</h2>
      <p>${escapeHtml(pendingNightChoice.label)}</p>
      <div class="button-grid">
        <button id="confirm-night-btn" class="primary">Lock in choice</button>
        <button id="change-night-btn" class="secondary">Change choice</button>
      </div>
    </section>
  `;
}

// ##################################### 5
// Player list rendering
function renderPlayerList() {
  return state.players
    .map((player) => {
      const classes = ["player-pill"];
      if (!player.alive) classes.push("dead");
      if (player.mayorRevealed) classes.push("mayor-revealed");
      if (!player.connected) classes.push("disconnected");

      const tags = [];
      if (player.isHost) tags.push("HOST");
      if (!player.connected) tags.push("OFFLINE");
      if (state.phase === "gameover" && player.role) tags.push(player.role);

      return `
        <span class="${classes.join(" ")}">
          ${escapeHtml(player.name)}
          ${tags.map((tag) => `<small>${escapeHtml(tag)}</small>`).join("")}
        </span>
      `;
    })
    .join("");
}

// ##################################### 6
// Status, role, and messages rendering
function renderStatusCard() {
  const roundText = state.phase === "night"
    ? `Night ${state.nightNumber}`
    : state.phase === "day"
      ? `Day ${state.dayNumber}`
      : "";

  return `
    <section class="card status-card ${state.phase === "day" ? "is-dawn" : ""}">
      <div class="card-title-row">
        <h2>${escapeHtml(phaseLabel(state.phase))}</h2>
        <span class="badge">${escapeHtml(roundText || `${state.playerCount} player${state.playerCount === 1 ? "" : "s"}`)}</span>
      </div>
      <p class="muted">Alive players: ${state.aliveCount}</p>
      ${state.phase === "day" ? `<p>${state.votesCast} of ${state.aliveCount} votes in</p>${gameClock.markup("Voting ends in")}` : ""}
      ${state.phase === "lobby" ? `<p>Share the room code or invite link. Night turns last ${Math.ceil(state.timing.night / 1000)} seconds. A turn passes when time runs out.</p>` : ""}
      ${state.phase === "gameover" ? renderGameOverSummary() : ""}
    </section>
  `;
}

function renderRoleCard() {
  const me = state.me;
  const roleText = me.role || "No role yet";
  if (!me.role) return "";
  if (!privateView) return `
    <section class="card role-card">
      <h2>Role hidden</h2>
      <button id="show-private-btn" class="secondary">Show role</button>
    </section>
  `;

  return `
    <section class="card role-card">
      <div class="card-title-row">
        <h2>You are: ${escapeHtml(roleText)}</h2>
        <span class="badge ${me.alive ? "alive-badge" : "dead-badge"}">${me.alive ? "Alive" : "Dead"}</span>
      </div>
      <p>${escapeHtml(state.roleDescriptions[me.role] || "")}</p>
      ${state.phase !== "night" ? `<button id="hide-private-btn" class="secondary">Hide role</button>` : ""}
      ${renderMayorRevealButton()}
      ${renderPrivateMessages()}
    </section>
  `;
}

function renderPrivateMessages() {
  if (!state.me.privateMessages.length) return "";

  return `
    <div class="private-box">
      <h3>Private info</h3>
      ${state.me.privateMessages
        .map((message) => `<p><strong>${escapeHtml(message.time)}</strong> ${escapeHtml(message.text)}</p>`)
        .join("")}
    </div>
  `;
}

function renderMessagesCard() {
  return `
    <section class="card">
      <h2>Game log</h2>
      <div class="log-list">
        ${state.messages.length
          ? state.messages
              .slice()
              .reverse()
              .map((message) => `<p><strong>${escapeHtml(message.time)}</strong> ${escapeHtml(message.text)}</p>`)
              .join("")
          : `<p class="muted">No game messages yet.</p>`}
      </div>
    </section>
  `;
}

// ##################################### 7
// Host controls and role configuration
function renderHostControls() {
  if (!state.me.isHost) return "";

  return `
    <section class="card host-card">
      <h2>Host controls</h2>
      <div class="button-grid">
        <button id="start-game-btn" class="primary" ${state.phase !== "lobby" ? "disabled" : ""}>Start Game</button>
        <button id="force-sleep-btn" ${state.phase !== "day" ? "disabled" : ""}>Start Night Early</button>
        <button id="resolve-votes-btn" ${state.phase !== "day" ? "disabled" : ""}>Resolve Votes</button>
        <button id="end-game-btn" ${!state.hasStarted || state.phase === "gameover" ? "disabled" : ""}>End Game</button>
        <button id="reset-game-btn" class="danger">Reset Game</button>
      </div>
      <a class="subtle-link" href="${escapeHtml(roomLink("/table"))}" target="_blank" rel="noopener">Open table announcer for this room</a>
      ${state.phase === "lobby" ? renderRoleConfig() : `<p class="muted">Role configuration is locked after the game starts.</p>`}
    </section>
  `;
}

function renderRoleConfig() {
  return `
    <div class="role-config">
      <div class="config-summary">
        <strong>Selected roles:</strong> ${state.selectedRoleCount} / ${state.playerCount}
        <br>
        <span class="muted">If selected roles are fewer than players, extra players become Villagers automatically.</span>
      </div>

      <label class="toggle-row vampire-skip-row">
        <input type="checkbox" id="vampire-skip-toggle" ${state.vampireCanSkip ? "checked" : ""}>
        <span>Allow vampire to skip killing for a night</span>
      </label>

      <div class="role-grid">
        ${state.roleOrder.map((role) => renderRoleConfigRow(role)).join("")}
      </div>
    </div>
  `;
}

function renderRoleConfigRow(role) {
  const config = state.roleConfig[role];
  const options = Array.from({ length: 16 }, (_, index) => {
    return `<option value="${index}" ${config.count === index ? "selected" : ""}>${index}</option>`;
  }).join("");

  return `
    <div class="role-config-row">
      <label class="toggle-row">
        <input type="checkbox" class="role-enabled" data-role="${escapeHtml(role)}" ${config.enabled ? "checked" : ""}>
        <span>${escapeHtml(role)}</span>
      </label>
      <select class="role-count" data-role="${escapeHtml(role)}">
        ${options}
      </select>
    </div>
  `;
}

// ##################################### 8
// Player action rendering
function renderActionCard() {
  if (state.phase === "gameover") return renderFinalRolesCard();
  if (state.phase === "lobby") return "";
  if (!state.me.alive) {
    return `
      <section class="card">
        <h2>Spectating</h2>
        <p>Watch the rest of the round and rejoin when the host resets.</p>
      </section>
    `;
  }

  if (state.phase === "day") return renderDayVoting();

  return "";
}

function renderNightActions() {
  const role = state.me.role;

  if (role === "Vampire") return renderVampireAction();
  if (role === "Doctor") return renderDoctorAction();
  if (role === "Detective") return renderDetectiveAction();
  if (role === "Hunter" && !state.me.hunterUsed) return renderHunterAction();
  if (role === "Transporter") return renderTransporterAction();
  const canWatch = role === "Villager" && !state.me.villagerWatchUsed;

  return `
    <section class="card action-card">
      <h2>${canWatch ? "Keep watch" : "Cover turn"}</h2>
      <p>${canWatch ? "Once per game, choose someone. If you survive, you’ll privately learn at dawn whether they used a targeted ability." : "Choose a player or pass to finish your private turn."}</p>
      <div class="target-grid">
        ${targetButtons(otherAlivePlayers(), "night", "watch")}
        <button class="secondary" data-night-skip="watch">${canWatch ? "Save watch for later" : "Pass"}</button>
      </div>
    </section>
  `;
}

function renderVampireAction() {
  return `
    <section class="card action-card">
      <h2>Vampire action</h2>
      <p>Choose one player to kill.</p>
      <div class="target-grid">
        ${targetButtons(otherAlivePlayers(), "night", "vampire")}
        ${state.vampireCanSkip ? `<button class="secondary" data-night-skip="vampire">Skip killing tonight</button>` : ""}
      </div>
    </section>
  `;
}

function renderDoctorAction() {
  const lastSave = state.me.doctorLastSave;

  return `
    <section class="card action-card">
      <h2>Doctor action</h2>
      <p>Choose one player to save. You cannot save the same person two nights in a row.</p>
      <div class="target-grid">
        ${targetButtons(alivePlayers(), "night", "doctor", lastSave)}
        <button class="secondary" data-night-skip="doctor">Skip save</button>
      </div>
    </section>
  `;
}

function renderDetectiveAction() {
  return `
    <section class="card action-card">
      <h2>Detective action</h2>
      <p>Choose one player to investigate.</p>
      <div class="target-grid">
        ${targetButtons(otherAlivePlayers(), "night", "detective")}
        <button class="secondary" data-night-skip="detective">Skip investigation</button>
      </div>
    </section>
  `;
}

function renderHunterAction() {
  return `
    <section class="card action-card">
      <h2>Hunter action</h2>
      <p>You can shoot one player once per game. Choose carefully.</p>
      <div class="target-grid">
        ${targetButtons(otherAlivePlayers(), "night", "hunter")}
        <button class="secondary" data-night-skip="hunter">Do not shoot tonight</button>
      </div>
    </section>
  `;
}

function renderTransporterAction() {
  return `
    <section class="card action-card">
      <h2>Transporter action</h2>
      <p>Pick exactly two players to swap tonight.</p>
      <div class="target-grid">
        ${alivePlayers()
          .map((player) => {
            const selected = selectedTransporterTargets.includes(player.id);
            return `
              <button class="target-button ${selected ? "selected" : ""}" data-transporter-target="${escapeHtml(player.id)}">
                ${escapeHtml(player.name)}
              </button>
            `;
          })
          .join("")}
      </div>
      <div class="button-grid small-gap">
        <button id="send-transport-btn" class="primary" ${selectedTransporterTargets.length !== 2 ? "disabled" : ""}>Send Swap</button>
        <button id="clear-transport-btn" class="secondary">Clear</button>
        <button class="secondary" data-night-skip="transporter">Skip swap</button>
      </div>
    </section>
  `;
}

function renderDayVoting() {
  return `
    <section class="card action-card">
      <h2>Day vote</h2>
      <p>Vote for one alive player. Mayor votes count as 2 only after revealing.</p>
      ${state.me.dayVoteTarget ? `<p class="muted">Your current vote: ${escapeHtml(playerName(state.me.dayVoteTarget))}</p>` : ""}
      <div class="target-grid">
        ${targetButtons(otherAlivePlayers(), "vote", "vote")}
      </div>
    </section>
  `;
}

// ##################################### 9
// Buttons and smaller render helpers
function targetButtons(players, mode, actionName, disabledPlayerId = null) {
  if (!players.length) return `<p class="muted">No valid targets.</p>`;

  return players
    .map((player) => {
      const disabled = disabledPlayerId === player.id ? "disabled" : "";
      const disabledText = disabled ? " Cannot choose twice" : "";

      if (mode === "vote") {
        return `
          <button class="target-button" data-vote-target="${escapeHtml(player.id)}" ${disabled}>
            ${escapeHtml(player.name)}${disabledText}
          </button>
        `;
      }

      return `
        <button class="target-button" data-night-action="${escapeHtml(actionName)}" data-target-id="${escapeHtml(player.id)}" ${disabled}>
          ${escapeHtml(player.name)}${disabledText}
        </button>
      `;
    })
    .join("");
}

function renderMayorRevealButton() {
  if (state.phase !== "day") return "";
  if (state.me.role !== "Mayor" || !state.me.alive || state.me.mayorRevealed || !state.hasStarted || state.phase === "gameover") {
    return "";
  }

  return `<button id="reveal-mayor-btn" class="primary full-width">Reveal as Mayor</button>`;
}

function renderGameOverSummary() {
  if (!state.gameOver) return "";

  return `
    <div class="game-over-box">
      <h3>Winner: ${escapeHtml(state.gameOver.winner)}</h3>
      <p>${escapeHtml(state.gameOver.reason)}</p>
    </div>
  `;
}

function renderFinalRolesCard() {
  return `
    <section class="card">
      <h2>Final roles</h2>
      <div class="final-role-list">
        ${state.gameOver?.finalRoles
          ?.map((player) => `
            <div class="final-role-row">
              <span>${escapeHtml(player.name)}</span>
              <strong>${escapeHtml(player.role)}</strong>
              <em>${player.alive ? "Alive" : "Dead"}${player.connected ? "" : " / Offline"}</em>
            </div>
          `)
          .join("") || ""}
      </div>
    </section>
  `;
}

function renderRoleDescriptions() {
  return `
    <section class="card">
      <h2>Role descriptions</h2>
      <div class="description-grid">
        ${state.roleOrder
          .map((role) => `
            <article>
              <h3>${escapeHtml(role)}</h3>
              <p>${escapeHtml(state.roleDescriptions[role])}</p>
            </article>
          `)
          .join("")}
      </div>
    </section>
  `;
}

// ##################################### 10
// Dynamic event binding after render
function bindDynamicButtons() {
  $("show-private-btn")?.addEventListener("click", () => {
    privateView = true;
    render();
  });
  $("hide-private-btn")?.addEventListener("click", hidePrivateView);
  $("confirm-night-btn")?.addEventListener("click", submitNightChoice);
  $("change-night-btn")?.addEventListener("click", () => {
    pendingNightChoice = null;
    render();
  });
  $("skip-night-btn")?.addEventListener("click", () => socket.emit("skipNightTurn", state.nightTurn?.key));

  const startButton = $("start-game-btn");
  if (startButton) startButton.addEventListener("click", () => socket.emit("startGame"));

  const forceSleepButton = $("force-sleep-btn");
  if (forceSleepButton) forceSleepButton.addEventListener("click", () => socket.emit("forceSleep"));

  const resetButton = $("reset-game-btn");
  if (resetButton) resetButton.addEventListener("click", () => socket.emit("resetGame"));

  const endButton = $("end-game-btn");
  if (endButton) endButton.addEventListener("click", () => socket.emit("endGame"));

  const resolveNightButton = $("resolve-night-btn");
  if (resolveNightButton) resolveNightButton.addEventListener("click", () => socket.emit("resolveNight"));

  const resolveVotesButton = $("resolve-votes-btn");
  if (resolveVotesButton) resolveVotesButton.addEventListener("click", () => socket.emit("resolveVotes"));

  const revealMayorButton = $("reveal-mayor-btn");
  if (revealMayorButton) revealMayorButton.addEventListener("click", () => socket.emit("revealMayor"));

  document.querySelectorAll(".role-enabled, .role-count").forEach((input) => {
    input.addEventListener("change", () => {
      const role = input.dataset.role;
      const enabledInput = document.querySelector(`.role-enabled[data-role="${role}"]`);
      const countInput = document.querySelector(`.role-count[data-role="${role}"]`);

      socket.emit("updateConfig", {
        role,
        enabled: enabledInput.checked,
        count: Number(countInput.value),
        vampireCanSkip: Boolean($("vampire-skip-toggle")?.checked),
      });
    });
  });

  const vampireSkipToggle = $("vampire-skip-toggle");
  if (vampireSkipToggle) {
    vampireSkipToggle.addEventListener("change", () => {
      socket.emit("updateConfig", { vampireCanSkip: vampireSkipToggle.checked });
    });
  }

  document.querySelectorAll("[data-night-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.targetId;
      chooseNightAction({ targetId }, playerName(targetId));
    });
  });

  document.querySelectorAll("[data-night-skip]").forEach((button) => {
    button.addEventListener("click", () => {
      chooseNightAction({ skip: true }, button.textContent.trim());
    });
  });

  document.querySelectorAll("[data-vote-target]").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("vote", { targetId: button.dataset.voteTarget });
    });
  });

  document.querySelectorAll("[data-transporter-target]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleTransporterTarget(button.dataset.transporterTarget);
    });
  });

  const sendTransportButton = $("send-transport-btn");
  if (sendTransportButton) {
    sendTransportButton.addEventListener("click", () => {
      if (selectedTransporterTargets.length !== 2) return;
      chooseNightAction({ targetIds: [...selectedTransporterTargets] }, selectedTransporterTargets.map(playerName).join(" and "));
    });
  }

  const clearTransportButton = $("clear-transport-btn");
  if (clearTransportButton) {
    clearTransportButton.addEventListener("click", () => {
      selectedTransporterTargets = [];
      render();
    });
  }
}

function chooseNightAction(action, label) {
  pendingNightChoice = { action, label };
  render();
}

function submitNightChoice() {
  const turnKey = state?.nightTurn?.key;
  if (!turnKey || !pendingNightChoice || savingTurn) return;
  if (!socket.connected) return showToast("Reconnecting. Please try again in a moment.");

  const { action } = pendingNightChoice;
  savingTurn = true;
  hidePrivateView();
  socket.timeout(6500).emit("nightAction", { ...action, turnKey }, (error, message) => {
    if (state.nightTurn?.key !== turnKey || (!error && !message)) return;
    savingTurn = false;
    render();
    showToast(message || "Could not confirm your choice. Check whose turn it is and try again.");
  });
}

// ##################################### 11
// Transporter local selection logic
function toggleTransporterTarget(targetId) {
  if (selectedTransporterTargets.includes(targetId)) {
    selectedTransporterTargets = selectedTransporterTargets.filter((id) => id !== targetId);
  } else if (selectedTransporterTargets.length < 2) {
    selectedTransporterTargets.push(targetId);
  }

  render();
}

// ##################################### 12
// Socket listeners
socket.on("state", (newState) => {
  const previous = state;
  if (newState.phase !== state?.phase || newState.nightTurn?.key !== state?.nightTurn?.key) {
    privateView = false;
    pendingNightChoice = null;
    selectedTransporterTargets = [];
    savingTurn = false;
  }
  state = newState;
  if (!previous) {
    joinDetails = { code: state.roomCode, name: state.me.name, sessionId: playerId };
    sessionStorage.setItem("vampireRoom", JSON.stringify({ code: state.roomCode, name: state.me.name }));
    history.replaceState(null, "", roomLink());
  }
  gameClock.set(state.clock, state.serverTime);
  render();

  if (previous?.me.alive && !state.me.alive) {
    showTransition("You were eliminated", "✦", "elimination");
  } else if (previous?.phase !== state.phase && state.phase === "day") {
    showTransition(`Day ${state.dayNumber}`, "☀");
  } else if (previous?.phase !== state.phase && state.phase === "night") {
    showTransition(state.nightTurn?.playerId === state.me.id ? "Your turn" : `Night ${state.nightNumber}`, "☾");
  } else if (previous?.nightTurn?.key !== state.nightTurn?.key && state.nightTurn?.playerId === state.me.id) {
    showTransition("Your turn", "☾");
  }
});

socket.on("roomLeft", returnToRooms);

socket.on("disconnect", () => {
  if (!state?.me) return;
  savingTurn = false;
  hidePrivateView();
  showToast("Connection lost. Reconnecting…");
});

socket.on("errorMessage", (message) => {
  if (state && message.includes("room is closed")) return returnToRooms(message);
  if (state) return showToast(message);
  $("join-error").textContent = message;
  $("join-error").classList.remove("hidden");
});
