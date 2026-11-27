const gameClock = (() => {
  let end = 0;
  let duration = 0;
  let overdue = false;

  function refresh() {
    const element = document.querySelector("[data-game-clock]");
    if (!element || !duration) return;
    const remaining = end - performance.now();
    const seconds = overdue ? Math.floor(Math.min(0, remaining) / 1000) : Math.ceil(Math.max(0, remaining) / 1000);
    element.querySelector("output").textContent = `${seconds}s`;
    element.querySelector("progress").value = Math.max(0, remaining);
    element.classList.toggle("clock-urgent", seconds <= 5);
  }

  window.setInterval(refresh, 180);

  return {
    set(clock, serverTime) {
      duration = clock?.duration || 0;
      overdue = Boolean(clock?.overtimeUntil);
      end = clock ? performance.now() + clock.deadline - serverTime : 0;
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
