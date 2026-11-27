// ##################################### 1
// Socket setup, local player id, and global state
const socket = io();

let state = null;
let selectedTransporterTargets = [];
let joinDetails = null;
let privateView = false;
let roleRevealed = false;
let choosingAccuser = false;
let choosingShot = false;
let seerTargetId = null;
let seerGuessRole = "";
let pendingDayChoice = null;
let pendingNightChoice = null;
let savingTurn = false;
let roomMode = "create";
let botDeskOpen = true;
let boardOpen = false;
const botWindows = new Map();
const boardPlayers = new Map();

const invitedRoom = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
const botToken = new URLSearchParams(location.hash.slice(1)).get("bot");
const inBoard = location.pathname === "/practice/player";
const isBotWindow = inBoard || botToken !== null;
let connectBot = isBotWindow;
let firstBotJoin = true;
const playerId = isBotWindow ? null : getPlayerId();
if (inBoard) document.body.classList.add("board-player");

function getPlayerId() {
  const storedId = localStorage.getItem("vampirePlayerId");
  const id = /^[A-Za-z0-9_-]{22,80}$/.test(storedId || "") ? storedId : makePlayerId();
  localStorage.setItem("vampirePlayerId", id);
  return id;
}

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
  $("practice-option").classList.toggle("hidden", joining);
  $("join-submit").textContent = joining ? "Join room" : "Create room";
  $("join-error").classList.add("hidden");
}

$("mode-create").addEventListener("click", () => setRoomMode("create"));
$("mode-join").addEventListener("click", () => setRoomMode("join"));
if (invitedRoom) $("room-code-input").value = invitedRoom.slice(0, 6);
setRoomMode(invitedRoom ? "join" : "create");

if (isBotWindow) {
  $("join-screen").classList.add("hidden");
  $("bot-entry").classList.remove("hidden");
  $("share-room-btn").classList.add("hidden");
  $("leave-room-btn").textContent = "Release bot";
  document.title = "Bot player view | Vampire";
} else {
  try {
    const previousRoom = JSON.parse(sessionStorage.getItem("vampireRoom"));
    if (previousRoom?.code === invitedRoom && typeof previousRoom.name === "string") {
      $("name-input").value = previousRoom.name;
      joinDetails = { ...previousRoom, sessionId: playerId };
    }
  } catch {
    // A fresh form is still available when browser storage is unavailable.
  }
}

$("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("join-error").classList.add("hidden");
  joinDetails = {
    sessionId: playerId,
    name: $("name-input").value.trim(),
    code: roomMode === "join" ? $("room-code-input").value.trim().toUpperCase() : "",
    practice: roomMode === "create" && $("practice-input").checked,
  };
  if (!joinDetails.name) {
    $("name-input").focus();
    return showToast("Enter a name to play.");
  }
  socket.emit(roomMode === "join" ? "join" : "createRoom", joinDetails);
});

socket.on("connect", () => {
  if (connectBot) {
    socket.emit("joinBot", { code: invitedRoom, token: botToken, automatic: firstBotJoin ? inBoard : undefined });
    firstBotJoin = false;
  }
  else if (joinDetails?.code) socket.emit("join", joinDetails);
});

function roomLink(path = "/") {
  const url = new URL(path, location.origin);
  url.searchParams.set("room", state.roomCode);
  return url.href;
}

function botLink(bot, path = "/") {
  const url = new URL(roomLink(path));
  url.hash = new URLSearchParams({ bot: bot.token }).toString();
  return url.href;
}

function syncBotBoard() {
  const bots = boardOpen ? state?.bots || [] : [];
  const active = bots.length > 0;
  $("practice-board").classList.toggle("hidden", !active);
  document.body.classList.toggle("has-practice-board", active);

  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const [id, pane] of boardPlayers) {
    if (byId.get(id)?.token === pane.token) continue;
    pane.root.remove();
    boardPlayers.delete(id);
  }

  for (const bot of bots) {
    let pane = boardPlayers.get(bot.id);
    if (!pane) {
      const popup = botWindows.get(bot.id)?.popup;
      if (popup && !popup.closed) popup.close();
      botWindows.delete(bot.id);

      const root = document.createElement("section");
      root.className = "board-tile";
      const heading = document.createElement("h3");
      const frame = document.createElement("iframe");
      frame.title = `${bot.name} player view`;
      frame.src = botLink(bot, "/practice/player");
      root.append(heading, frame);
      $("board-grid").append(root);
      pane = { root, heading, token: bot.token };
      boardPlayers.set(bot.id, pane);
    }
    pane.heading.textContent = bot.role ? `${bot.name} · ${bot.role}` : bot.name;
  }
}

$("close-board").addEventListener("click", () => {
  boardOpen = false;
  render();
});

function openBotWindow(event) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const { href, dataset: { botId } } = event.currentTarget;
  const previous = botWindows.get(botId);
  if (previous?.href === href && !previous.popup.closed) {
    if (!state.bots.find((bot) => bot.id === botId)?.windowOpen) previous.popup.location.reload();
    previous.popup.focus();
    return;
  }

  const index = state.bots.findIndex((bot) => bot.id === botId);
  const columns = Math.max(1, Math.floor(screen.availWidth / 400));
  const width = Math.min(460, Math.floor(screen.availWidth / columns));
  const rows = Math.ceil(state.bots.length / columns);
  const height = Math.min(760, Math.max(320, Math.floor(screen.availHeight / rows) - 38));
  const left = (screen.availLeft ?? 0) + (index % columns) * width;
  const top = (screen.availTop ?? 0) + Math.floor(index / columns) * (height + 38);
  const popup = window.open(href, `vampire-bot-${botId}`, `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) return showToast("Allow pop-ups or open this bot link in a new tab.");
  popup.opener = null;
  botWindows.set(botId, { href, popup });
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
  if (isBotWindow) {
    connectBot = false;
    state = null;
    gameClock.set(null);
    document.body.removeAttribute("data-phase");
    $("game-screen").classList.add("hidden");
    $("night-panel").classList.add("hidden");
    $("phase-transition").classList.add("hidden");
    $("bot-entry").classList.remove("hidden");
    $("bot-entry-message").textContent = message || "Bot released. You can close this window or reopen it from the practice room.";
    return;
  }

  state = null;
  joinDetails = null;
  boardOpen = false;
  syncBotBoard();
  resetPrivateView();
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
  $("bot-desk")?.remove();
  botWindows.clear();
  botDeskOpen = true;
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
  if (document.hidden && (privateView || roleRevealed)) hidePrivateView();
});

// ##################################### 4
// Main render function
function render() {
  if (!state || !state.me) return;

  const existingDesk = $("bot-desk");
  if (existingDesk) botDeskOpen = existingDesk.open;
  $("join-screen").classList.add("hidden");
  $("bot-entry").classList.add("hidden");
  syncBotBoard();
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
    ${renderBotControls()}
    ${renderStatusCard()}
    ${renderRoleCard()}
    ${renderBotDesk()}
    ${renderHostControls()}
    ${renderActionCard()}
    ${renderMessagesCard()}
  `;
  $("role-descriptions").innerHTML = renderRoleDescriptions();

  bindDynamicButtons();
  gameClock.refresh();
}

function renderNightScreen() {
  const choosing = privateView && state.me.alive && !state.me.botAuto && !state.me.nightComplete && !savingTurn;
  let heading = "Make a private choice";
  if (savingTurn) heading = "Saving your choice…";
  if (state.me.nightComplete) heading = "Choice locked";
  if (!state.me.alive) heading = "Watching the game";

  $("night-panel").innerHTML = `
    ${renderBotControls()}
    <section class="card night-cover">
      <span class="phase-glyph" aria-hidden="true">☾</span>
      <p class="round-label">Night ${state.nightNumber}</p>
      <h1>${heading}</h1>
      ${gameClock.markup("Night ends in")}
      <div class="night-options">
        ${choosing ? `<button id="hide-private-btn" class="secondary">Cover screen</button>` : ""}
        ${state.me.alive && !state.me.nightComplete && !state.me.botAuto && !savingTurn && !choosing
          ? `<button id="show-private-btn" class="primary">Make choice</button>` : ""}
        ${state.me.role && !roleRevealed ? `<button id="show-role-btn" class="secondary">Reveal role</button>` : ""}
      </div>
    </section>
    ${roleRevealed ? renderRoleCard() : ""}
    ${choosing ? (pendingNightChoice ? renderNightConfirmation() : renderNightActions()) : ""}
    ${!choosing && !roleRevealed ? renderBotDesk() : ""}
    ${!choosing && !roleRevealed && state.me.isHost ? `
      <details class="card night-host">
        <summary>Host controls</summary>
        <div class="button-grid">
          <button id="resolve-night-btn" class="secondary">End night early</button>
          <button id="end-game-btn" class="secondary">End game</button>
        </div>
      </details>` : ""}
  `;
}

function resetPrivateView() {
  privateView = false;
  roleRevealed = false;
  choosingAccuser = false;
  choosingShot = false;
  seerTargetId = null;
  seerGuessRole = "";
  pendingDayChoice = null;
  pendingNightChoice = null;
  selectedTransporterTargets = [];
}

function hidePrivateView() {
  resetPrivateView();
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
      if (player.isBot) tags.push("BOT");
      if (player.jesterWon) tags.push("Jester win");
      if (state.phase !== "gameover" && player.publicRole) tags.push(`Revealed ${player.publicRole}`);
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
      ${state.phase === "lobby" ? `<p>${state.practice ? "Practice room. The host can tile the bot players’ views." : "Share the room code or invite link."} Everyone chooses during the same ${Math.ceil(state.timing.night / 1000)} seconds at night.</p>` : ""}
      ${state.phase === "gameover" ? renderGameOverSummary() : ""}
    </section>
  `;
}

function renderRoleCard() {
  const me = state.me;
  if (!me.role) return "";
  if (!roleRevealed) return `
    <section class="card role-card">
      <h2>Role hidden</h2>
      <button id="show-role-btn" class="secondary">Reveal role</button>
    </section>
  `;

  return `
    <section class="card role-card">
      <div class="card-title-row">
        <h2>You are ${escapeHtml(me.role)}</h2>
        <span class="badge ${me.alive ? "alive-badge" : "dead-badge"}">${me.alive ? "Alive" : "Dead"}</span>
      </div>
      <p>${escapeHtml(state.roleDescriptions[me.role] || "")}</p>
      <button id="hide-private-btn" class="secondary">Hide role</button>
      ${renderKnownPlayers(me)}
      ${renderMayorRevealButton()}
      ${renderDayShot(me)}
      ${renderSeerCard(me)}
      ${renderOathCard(me)}
      ${renderPrivateMessages()}
    </section>
  `;
}

function renderKnownPlayers(me) {
  if (!me.knownPlayers.length) return "";
  return `<div class="private-box">
    <h3>${me.role === "Vampire" ? "Evil teammates" : "Other Jesters"}</h3>
    <ul class="private-roster">${me.knownPlayers.map(({ name, role }) =>
      `<li>${escapeHtml(name)} <small>${escapeHtml(role)}</small></li>`).join("")}</ul>
  </div>`;
}

function canUseRoleControls() {
  return state.me.alive && !state.me.botAuto && (state.phase === "night" || state.phase === "day");
}

function renderDayShot(me) {
  if (!canUseRoleControls() || state.phase !== "day" || me.role !== "Hunter" || me.abilityUsed) return "";
  if (pendingDayChoice?.event === "hunterShot") return renderDayConfirmation("Fire your shot");
  return `<div class="private-box">
    <button id="toggle-hunter-picker" class="secondary">${choosingShot ? "Cancel shot" : "Choose a daytime shot"}</button>
    ${choosingShot ? `<div class="target-grid">
      ${choiceButtons(otherAlivePlayers().filter(({ id }) => id !== me.oath?.targetId), "day-shot")}
    </div>` : ""}
  </div>`;
}

function renderSeerCard(me) {
  if (me.role !== "Seer") return "";
  const highlighted = otherAlivePlayers().filter(({ id }) => me.seerTargets.includes(id));
  const privateNames = highlighted.filter(({ publicRole }) => !publicRole).map(({ name }) => name);
  const canGuess = canUseRoleControls() && !me.abilityUsed && !me.seerGuessPending && !me.oathActedTonight;
  const target = highlighted.find(({ id }) => id === seerTargetId);
  return `<div class="private-box seer-card">
    <h3>People with roles</h3>
    <p>Only you can see these highlights.</p>
    ${privateNames.length ? `<p class="private-reminder">You cannot say these players have a role: ${escapeHtml(privateNames.join(", "))}.</p>` : ""}
    <div class="target-grid">
      ${highlighted.map(({ id, name }) => `<button type="button" class="seer-target${id === seerTargetId ? " selected" : ""}"
        data-seer-target="${escapeHtml(id)}" ${canGuess ? "" : "disabled"}>${escapeHtml(name)}</button>`).join("")}
    </div>
    ${!highlighted.length ? '<p class="muted">No living players with roles remain.</p>' : ""}
    ${me.seerGuessPending ? '<p class="muted">Your guess will resolve at dawn.</p>' : ""}
    ${me.abilityUsed ? '<p class="muted">Your one guess has been used.</p>' : ""}
    ${canGuess && target ? `
      <form id="seer-guess-form" class="seer-guess-form">
        <label>Choose a role for ${escapeHtml(target.name)}
          <select id="seer-guess-role" required>
            <option value="">Choose a role</option>
            ${state.roleOrder.filter((role) => role !== "Villager").map((role) =>
              `<option value="${escapeHtml(role)}" ${role === seerGuessRole ? "selected" : ""}>${escapeHtml(role)}</option>`).join("")}
          </select>
        </label>
        <p>A wrong guess eliminates you.</p>
        <button class="primary" type="submit" ${savingTurn ? "disabled" : ""}>Lock in guess</button>
      </form>` : ""}
  </div>`;
}

function renderOathCard(me) {
  if (!me.oath) return "";
  const { targetId, canReveal, revealed } = me.oath;
  const choosing = canUseRoleControls() && choosingAccuser && !targetId && !me.seerGuessPending;
  return `<div class="private-box">
    <h3>Accuser’s Oath</h3>
    <p>${targetId ? `Protect ${escapeHtml(playerName(targetId))}. You cannot vote against or target them with a hostile ability.`
      : "Record the first player who accuses you of being a Vampire. You must protect them for the rest of the match."}</p>
    ${choosing && pendingDayChoice?.event === "recordAccuser" ? renderDayConfirmation("Swear to protect") : ""}
    ${choosing && state.phase === "night" && pendingNightChoice?.action.oath ? renderNightConfirmation() : ""}
    ${choosing && !pendingDayChoice && !pendingNightChoice ? `<p>${state.phase === "night" ? "This replaces tonight’s move and shields your accuser tonight." : "They receive a shield on the next night."}</p>
      <div class="target-grid">
        ${choiceButtons(otherAlivePlayers(), "oath-target")}
        <button type="button" id="skip-accuser" class="secondary">Skip</button>
      </div>` : ""}
    ${canUseRoleControls() && !targetId && !choosing && !me.seerGuessPending
      ? '<button id="pick-accuser" class="secondary" type="button">Record first accuser</button>' : ""}
    ${canReveal && canUseRoleControls() ? '<button id="reveal-oath-btn" class="secondary" type="button">Reveal oath to the table</button>' : ""}
    ${revealed ? '<p class="muted">Revealed to the table.</p>' : ""}
  </div>`;
}

function renderDayConfirmation(verb) {
  return `<p>${escapeHtml(verb)}: ${escapeHtml(playerName(pendingDayChoice.targetId))}?</p>
    <div class="night-options">
      <button type="button" id="confirm-day-btn" class="primary">Confirm</button>
      <button type="button" id="cancel-day-btn" class="secondary">Back</button>
    </div>`;
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

function renderBotControls() {
  if (!state.me.isBot) return "";
  return `
    <section class="card bot-controls" aria-label="Bot player controls">
      <div>
        <h2>${escapeHtml(state.me.name)}</h2>
        <p class="muted">${state.me.botAuto ? "Playing automatically" : "You control this bot"} · Practice room</p>
      </div>
      <button type="button" id="toggle-bot-auto" class="secondary">${state.me.botAuto ? "Take control" : "Auto-play"}</button>
    </section>`;
}

function renderBotDesk() {
  if (!state.bots) return "";
  const inLobby = state.phase === "lobby";
  const showingBoard = boardOpen && state.bots.length > 0;
  return `
    <details id="bot-desk" class="card bot-desk${showingBoard ? " tiled" : ""}" ${botDeskOpen ? "open" : ""}>
      <summary>Practice bots <span class="badge">${state.bots.length}</span></summary>
      <div class="bot-actions">
        ${inLobby ? `
          <button type="button" id="add-bot-btn" class="primary">Add bot</button>
          <button type="button" id="all-roles-btn" class="secondary">Set up all ${state.roleOrder.length} roles</button>` : ""}
        ${state.bots.length ? `<button type="button" id="toggle-board" class="secondary">${showingBoard ? "Hide board" : "Tile bot views"}</button>` : ""}
      </div>
      ${state.bots.length && (!showingBoard || inLobby) ? `<ul class="bot-list">
        ${state.bots.map((bot) => `
          <li>
            <div>
              <strong>${escapeHtml(bot.name)}${bot.role ? ` · ${escapeHtml(bot.role)}` : ""}</strong>
              <small>${bot.automatic ? "Automatic" : "Manual"}${bot.windowOpen ? " · Window open" : ""}</small>
            </div>
            ${showingBoard ? "" : `<a class="bot-open" href="${escapeHtml(botLink(bot))}" data-bot-id="${escapeHtml(bot.id)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(bot.name)} window">Open window</a>`}
            ${inLobby ? `<button type="button" class="bot-remove" data-remove-bot="${escapeHtml(bot.id)}" aria-label="Remove ${escapeHtml(bot.name)}">Remove</button>` : ""}
          </li>`).join("")}
      </ul>` : ""}
    </details>`;
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
      ${renderRoomRules()}
    </div>
  `;
}

function renderRoomRules() {
  const modes = {
    off: "Off",
    "random-town": "One random Town player",
    "random-any": "One random player",
    town: "All Town players",
    "non-evil": "All Town and Neutral players",
    evil: "All Evil players",
    everyone: "Everyone",
  };
  return `<fieldset class="room-rule">
    <legend>Custom rules</legend>
    <label for="oath-mode">Accuser’s Oath</label>
    <p class="muted">A player privately records their first accuser and must protect them.</p>
    <select id="oath-mode">
      ${Object.entries(modes).map(([mode, label]) =>
        `<option value="${mode}" ${mode === state.oathMode ? "selected" : ""}>${label}</option>`).join("")}
    </select>
  </fieldset>
  <fieldset class="room-rule">
    <legend>End conditions</legend>
    <label class="toggle-row">
      <input type="checkbox" id="deadlock-draw" ${state.deadlockDraw ? "checked" : ""}>
      Draw on a three-way deadlock
    </label>
    <p class="muted">A full one-vote-each tie among one Vampire, one Jester and one Villager ends in a draw.</p>
  </fieldset>`;
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
        <span>${escapeHtml(role)} <small class="muted">${escapeHtml(state.roleAlignments[role])}</small></span>
      </label>
      <select class="role-count" data-role="${escapeHtml(role)}" aria-label="${escapeHtml(role)} count">
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

  if (state.phase === "day" && !state.me.botAuto) return renderDayVoting();

  return "";
}

function renderNightActions() {
  const needsPair = state.me.nightPickCount === 2;
  const targets = alivePlayers().filter(({ id }) => state.me.nightTargetIds.includes(id));
  return `
    <section class="card action-card">
      <h2>Choose ${needsPair ? "two names" : "a name"}</h2>
      <div class="target-grid">
        ${choiceButtons(targets, "night-target", selectedTransporterTargets)}
      </div>
      <div class="night-options">
        ${needsPair ? `<button id="send-pair-btn" class="primary" ${selectedTransporterTargets.length === 2 ? "" : "disabled"}>Continue</button>` : ""}
        ${state.me.role !== "Vampire" || state.vampireCanSkip || !targets.length
          ? '<button type="button" id="skip-choice-btn" class="secondary">Skip</button>' : ""}
      </div>
    </section>
  `;
}

function renderDayVoting() {
  return `
    <section class="card action-card">
      <h2>Day vote</h2>
      <p>Vote for one alive player. A revealed Mayor counts as two votes.</p>
      ${state.me.dayVoteTarget ? `<p class="muted">Your current vote: ${escapeHtml(playerName(state.me.dayVoteTarget))}</p>` : ""}
      <div class="target-grid">
        ${choiceButtons(otherAlivePlayers().filter(({ id }) => id !== state.me.oath?.targetId), "vote-target", [state.me.dayVoteTarget])}
      </div>
    </section>
  `;
}

function choiceButtons(players, action, selected = []) {
  if (!players.length) return '<p class="muted">No available players.</p>';
  return players.map(({ id, name }) => `
    <button type="button" class="target-button${selected.includes(id) ? " selected" : ""}"
      data-${action}="${escapeHtml(id)}">${escapeHtml(name)}</button>
  `).join("");
}

function renderMayorRevealButton() {
  if (!canUseRoleControls() || state.me.role !== "Mayor" || state.me.mayorRevealed) return "";
  return '<button id="reveal-mayor-btn" type="button" class="primary">Reveal as Mayor</button>';
}

function renderGameOverSummary() {
  if (!state.gameOver) return "";

  return `
    <div class="game-over-box">
      <h3>${state.gameOver.winner === "Draw" ? "Draw" : `Winner: ${escapeHtml(state.gameOver.winner)}`}</h3>
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
              <strong>${escapeHtml(player.role)}${player.rule ? ` · ${escapeHtml(player.rule)}` : ""}</strong>
              <em>${player.won ? "Won · " : ""}${player.alive ? "Alive" : "Dead"}${player.connected ? "" : " / Offline"}</em>
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
  const roomActions = {
    "add-bot-btn": "addBot",
    "start-game-btn": "startGame",
    "force-sleep-btn": "forceSleep",
    "reset-game-btn": "resetGame",
    "end-game-btn": "endGame",
    "resolve-night-btn": "resolveNight",
    "resolve-votes-btn": "resolveVotes",
    "reveal-mayor-btn": "revealMayor",
    "reveal-oath-btn": "revealOath",
  };
  for (const [id, event] of Object.entries(roomActions)) {
    $(id)?.addEventListener("click", () => socket.emit(event));
  }

  $("all-roles-btn")?.addEventListener("click", () => {
    boardOpen = true;
    socket.emit("setUpAllRoles");
  });
  $("toggle-board")?.addEventListener("click", () => {
    boardOpen = !boardOpen;
    render();
  });
  $("toggle-bot-auto")?.addEventListener("click", () => socket.emit("setBotAuto", !state.me.botAuto));
  document.querySelectorAll("[data-bot-id]").forEach((link) => link.addEventListener("click", openBotWindow));
  document.querySelectorAll("[data-remove-bot]").forEach((button) => {
    button.addEventListener("click", () => socket.emit("removeBot", button.dataset.removeBot));
  });

  $("show-private-btn")?.addEventListener("click", () => {
    resetPrivateView();
    privateView = true;
    render();
  });
  $("show-role-btn")?.addEventListener("click", () => {
    roleRevealed = true;
    render();
  });
  $("hide-private-btn")?.addEventListener("click", hidePrivateView);
  $("confirm-night-btn")?.addEventListener("click", submitNightChoice);
  $("change-night-btn")?.addEventListener("click", () => {
    pendingNightChoice = null;
    render();
  });

  document.querySelectorAll(".role-enabled, .role-count").forEach((input) => {
    input.addEventListener("change", () => {
      const role = input.dataset.role;
      const enabled = document.querySelector(`.role-enabled[data-role="${role}"]`).checked;
      const count = Number(document.querySelector(`.role-count[data-role="${role}"]`).value);
      socket.emit("updateConfig", { role, enabled, count });
    });
  });
  $("vampire-skip-toggle")?.addEventListener("change", (event) =>
    socket.emit("updateConfig", { vampireCanSkip: event.target.checked }));
  $("oath-mode")?.addEventListener("change", (event) => socket.emit("updateConfig", { oathMode: event.target.value }));
  $("deadlock-draw")?.addEventListener("change", (event) => socket.emit("updateConfig", { deadlockDraw: event.target.checked }));

  document.querySelectorAll("[data-night-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const { nightTarget: targetId } = button.dataset;
      if (state.me.nightPickCount === 2) toggleTransporterTarget(targetId);
      else chooseNightAction({ targetId }, playerName(targetId));
    });
  });
  $("skip-choice-btn")?.addEventListener("click", () => chooseNightAction({ skip: true }, "Skip"));
  $("send-pair-btn")?.addEventListener("click", () => {
    if (selectedTransporterTargets.length !== 2) return;
    chooseNightAction({ targetIds: [...selectedTransporterTargets] }, selectedTransporterTargets.map(playerName).join(" and "));
  });
  document.querySelectorAll("[data-vote-target]").forEach((button) => {
    button.addEventListener("click", () => socket.emit("vote", { targetId: button.dataset.voteTarget }));
  });

  bindRoleControls();
}

function bindRoleControls() {
  $("pick-accuser")?.addEventListener("click", () => {
    privateView = false;
    pendingNightChoice = null;
    pendingDayChoice = null;
    choosingAccuser = true;
    choosingShot = false;
    seerTargetId = null;
    seerGuessRole = "";
    render();
  });
  $("skip-accuser")?.addEventListener("click", () => {
    choosingAccuser = false;
    render();
  });
  document.querySelectorAll("[data-oath-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const { oathTarget: targetId } = button.dataset;
      if (state.phase === "night") chooseNightAction({ targetId, oath: true }, `Protect ${playerName(targetId)}`);
      else {
        pendingDayChoice = { event: "recordAccuser", targetId };
        render();
      }
    });
  });

  $("toggle-hunter-picker")?.addEventListener("click", () => {
    pendingDayChoice = null;
    choosingAccuser = false;
    choosingShot = !choosingShot;
    render();
  });
  document.querySelectorAll("[data-day-shot]").forEach((button) => {
    button.addEventListener("click", () => {
      pendingDayChoice = { event: "hunterShot", targetId: button.dataset.dayShot };
      render();
    });
  });
  $("cancel-day-btn")?.addEventListener("click", () => {
    pendingDayChoice = null;
    render();
  });
  $("confirm-day-btn")?.addEventListener("click", () => {
    const { event, targetId } = pendingDayChoice;
    if (!socket.connected) return showToast("Reconnecting. Try again in a moment.");
    socket.emit(event, targetId);
    hidePrivateView();
  });

  document.querySelectorAll("[data-seer-target]").forEach((button) => {
    button.addEventListener("click", () => {
      privateView = false;
      pendingNightChoice = null;
      choosingAccuser = false;
      pendingDayChoice = null;
      seerTargetId = button.dataset.seerTarget;
      seerGuessRole = "";
      render();
    });
  });
  $("seer-guess-role")?.addEventListener("change", (event) => { seerGuessRole = event.target.value; });
  $("seer-guess-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (seerTargetId && seerGuessRole) sendLockedChoice("seerGuess", { targetId: seerTargetId, guess: seerGuessRole });
  });
}

function chooseNightAction(action, label) {
  pendingNightChoice = { action, label };
  render();
}

function submitNightChoice() {
  if (state?.nightKey && pendingNightChoice) sendLockedChoice("nightAction", pendingNightChoice.action);
}

function sendLockedChoice(event, payload) {
  if (savingTurn) return;
  if (!socket.connected) return showToast("Reconnecting. Try again in a moment.");
  const { nightKey, dayNumber, phase } = state;
  savingTurn = true;
  hidePrivateView();
  socket.timeout(6500).emit(event, { ...payload, nightKey }, (error, message) => {
    if (state?.nightKey !== nightKey || state?.phase !== phase || state?.dayNumber !== dayNumber) return;
    savingTurn = false;
    render();
    if (error || message) showToast(message || "Could not confirm your choice. Try again.");
  });
}

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
  if (newState.phase !== previous?.phase || newState.nightKey !== previous?.nightKey
    || newState.me.botAuto !== previous?.me.botAuto || newState.me.role !== previous?.me.role
    || newState.me.alive !== previous?.me.alive) {
    resetPrivateView();
    savingTurn = false;
  }
  state = newState;
  if (!previous) {
    if (isBotWindow) {
      document.title = `${state.me.name} | Vampire practice`;
    } else {
      joinDetails = { code: state.roomCode, name: state.me.name, sessionId: playerId };
      sessionStorage.setItem("vampireRoom", JSON.stringify({ code: state.roomCode, name: state.me.name }));
      history.replaceState(null, "", roomLink());
    }
  }
  gameClock.set(state.clock, state.serverTime);
  render();

  if (previous?.me.alive && !state.me.alive) {
    showTransition("You were eliminated", "✦", "elimination");
  } else if (previous?.phase !== state.phase && state.phase === "day") {
    showTransition(`Day ${state.dayNumber}`, "☀");
  } else if (state.phase === "night" && state.nightKey !== previous?.nightKey) {
    showTransition(`Night ${state.nightNumber}`, "☾");
  }
  const latestNote = state.me.privateMessages.at(-1);
  const priorNote = previous?.me.privateMessages.at(-1);
  const newNight = state.nightKey && state.nightKey !== previous?.nightKey;
  const oathReminder = newNight && state.me.oath && !state.me.oath.targetId;
  const unreadNote = latestNote && (latestNote.text !== priorNote?.text || latestNote.time !== priorNote?.time);
  if (state.me.alive && (oathReminder || unreadNote)) {
    showToast("Private update. Reveal your role to read it.");
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
