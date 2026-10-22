/* Recent saves timer controls. Wheel edits are session-only until Start. */
(() => {
  const C = globalThis.MVSWatchTimerCore, $ = id => document.getElementById(id);
  const trigger = $('viewing-timer'), popover = $('timer-popover'), picker = $('timer-picker'), input = $('timer-minutes');
  const primary = $('timer-primary'), reset = $('timer-reset'), note = $('timer-note'), countdown = $('timer-countdown');
  let state = C.idle(), defaults = 15, selected = 15, dirty = false, busy = false, loaded = false, error = '', wheel = 0, phase;
  const active = () => ['running', 'paused'].includes(state.phase);
  const place = () => {
    if (popover.hidden) return;
    const rect = trigger.getBoundingClientRect(), box = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - box.width - 12))}px`;
    popover.style.top = `${Math.max(12, Math.min(rect.bottom + 10, innerHeight - box.height - 12))}px`;
  };
  const render = (next, configured, remaining) => {
    state = next; defaults = configured;
    if (!dirty && !active()) selected = defaults;
    const text = C.format(active() ? remaining : state.phase === 'expired' ? 0 : defaults * 60000);
    trigger.textContent = text; trigger.dataset.phase = state.phase;
    trigger.setAttribute('aria-label', `Viewing timer: ${text}${state.phase === 'paused' ? ', paused' : state.phase === 'expired' ? ', time is up' : ''}. Open timer controls`);
    picker.hidden = active(); countdown.hidden = !active(); countdown.textContent = text;
    if (document.activeElement !== input) input.value = String(selected);
    $('timer-less').textContent = selected > 1 ? String(selected - 1) : '−';
    $('timer-more').textContent = selected < 180 ? String(selected + 1) : '−';
    $('timer-less').disabled = selected <= 1 || busy; $('timer-more').disabled = selected >= 180 || busy;
    input.disabled = busy;
    primary.textContent = state.phase === 'running' ? 'Pause' : state.phase === 'paused' ? 'Resume' : state.phase === 'expired' ? 'Start again' : 'Start';
    primary.disabled = !loaded || busy || (!active() && !C.validMinutes(selected));
    reset.disabled = busy || state.phase === 'idle';
    const message = error || (state.phase === 'running' ? 'We’ll remind you on YouTube when time is up.' : state.phase === 'paused' ? 'Paused. Your remaining time is kept.'
      : state.phase === 'expired' ? 'Time’s up. A good moment for a break.' : `This session only · Default ${defaults} min`);
    if (note.textContent !== message) note.textContent = message;
    if (phase !== state.phase) { $('timer-status').textContent = state.phase === 'expired' ? 'Viewing timer finished.' : state.phase === 'paused' ? 'Viewing timer paused.' : state.phase === 'running' ? 'Viewing timer started.' : ''; phase = state.phase; }
    place();
  };
  const client = MVSWatchTimerClient.create({ onChange: render });
  client.ready.then(reply => { loaded = reply.ok; if (!reply.ok) error = 'Timer unavailable. Try again.'; client.refresh(); });
  const close = focus => { popover.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
  const open = () => {
    popover.hidden = false; trigger.setAttribute('aria-expanded', 'true'); client.refresh(); place();
    (active() ? primary : input).focus();
    if (!loaded) void client.action('get').then(reply => { loaded = reply.ok; error = reply.ok ? '' : 'Timer unavailable. Try again.'; client.refresh(); });
  };
  trigger.addEventListener('click', () => popover.hidden ? open() : close(false));
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } });
  $('timer-close').addEventListener('click', () => close(true));
  document.addEventListener('pointerdown', event => { if (!popover.hidden && !event.composedPath().includes($('viewing-timer-wrap'))) close(false); });
  document.addEventListener('keydown', event => { if (!popover.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } });
  window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
  const choose = value => {
    selected = Math.min(180, Math.max(1, value)); dirty = true; error = ''; input.value = String(selected); client.refresh();
  };
  input.addEventListener('input', () => { selected = input.valueAsNumber; dirty = true; error = C.validMinutes(selected) ? '' : 'Choose 1–180 whole minutes.'; client.refresh(); });
  $('timer-less').addEventListener('click', () => choose((C.validMinutes(selected) ? selected : defaults) - 1));
  $('timer-more').addEventListener('click', () => choose((C.validMinutes(selected) ? selected : defaults) + 1));
  picker.addEventListener('wheel', event => {
    if (event.ctrlKey || picker.hidden || busy || popover.hidden) return;
    event.preventDefault(); wheel += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 160 : 1);
    const steps = Math.trunc(wheel / 40);
    if (steps) { wheel -= steps * 40; choose((C.validMinutes(selected) ? selected : defaults) + Math.max(-5, Math.min(5, steps))); }
  }, { passive: false });
  const run = async action => {
    if (busy) return; busy = true; error = ''; client.refresh();
    const reply = await client.action(action, action === 'start' ? { minutes: selected } : {});
    busy = false;
    if (!reply.ok) error = reply.code === 'timer_changed' ? 'Timer changed in another tab. Review its current state.' : 'Could not update the timer. Try again.';
    else if (action === 'reset') { dirty = false; selected = defaults; }
    client.refresh();
    if (!popover.hidden && document.activeElement === document.body) primary.focus();
  };
  primary.addEventListener('click', () => void run(state.phase === 'running' ? 'pause' : state.phase === 'paused' ? 'resume' : 'start'));
  reset.addEventListener('click', () => void run('reset'));
})();
