const gameClock = (() => {
  let end = 0;
  let duration = 0;

  function refresh() {
    const element = document.querySelector("[data-game-clock]");
    if (!element || !duration) return;
    const remaining = Math.max(0, end - performance.now());
    const seconds = Math.ceil(remaining / 1000);
    element.querySelector("output").textContent = `${seconds}s`;
    element.querySelector("progress").value = remaining;
    element.classList.toggle("clock-urgent", seconds <= 5);
  }

  window.setInterval(refresh, 180);

  return {
    set(clock, serverTime) {
      duration = clock?.duration || 0;
      end = clock ? performance.now() + Math.max(0, clock.deadline - serverTime) : 0;
      refresh();
    },
    markup(label) {
      if (!duration) return "";
      return `<div class="turn-clock" data-game-clock>
        <span>${label}</span><output></output>
        <progress max="${duration}" value="${duration}" aria-label="Time remaining"></progress>
      </div>`;
    },
    refresh,
  };
})();
