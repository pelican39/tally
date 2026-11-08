/* Tally: a two-tab daily counter. All data stays in this browser (localStorage). */
(function () {
  'use strict';

  const DATA_KEY = 'tally.data.v1';
  const STEP_KEY = 'tally.step.v1';
  const STEPS = [5, 20, 50, 100];
  const DEFAULT_STEP = 5;
  const DEFAULT_RANGE = '30';
  const MAX_COUNT = 1000000000;

  /* ------------------------------------------------------------------
     Pure helpers (no DOM, so they can be tested on their own)
  ------------------------------------------------------------------ */

  const pad = (n) => String(n).padStart(2, '0');

  // Local calendar date as YYYY-MM-DD. Deliberately NOT toISOString(), which
  // uses UTC and would put an evening in Sydney on the wrong day.
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseKey(key) {
    const p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function isValidKey(key) {
    return typeof key === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(key) &&
      dateKey(parseKey(key)) === key;
  }

  function isValidCount(v) {
    return Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
  }

  // Check a parsed object. Returns { clean, badCount, firstBad } or { error }.
  function checkData(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { error: 'Expected an object like {"2026-11-08": 12}.' };
    }
    const clean = {};
    let badCount = 0;
    let firstBad = null;
    Object.keys(obj).forEach((k) => {
      if (isValidKey(k) && isValidCount(obj[k])) {
        clean[k] = obj[k];
      } else {
        badCount += 1;
        if (firstBad === null) firstBad = k;
      }
    });
    return { clean, badCount, firstBad };
  }

  // Add or subtract a step. The result never goes below 0.
  function applyStep(current, sign, step) {
    return Math.min(MAX_COUNT, Math.max(0, current + sign * step));
  }

  function addDays(key, n) {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  // Calendar days in the chosen range, newest first. Days with no saved
  // number come back with value null (shown blank, skipped in the graph).
  function buildRows(data, range, todayKey) {
    const keys = Object.keys(data).sort();
    const last = keys.length ? keys[keys.length - 1] : todayKey;
    const end = last > todayKey ? last : todayKey;
    let start;
    if (range === 'all') {
      start = keys.length ? keys[0] : todayKey;
    } else {
      start = addDays(end, -(Number(range) - 1));
    }
    const rows = [];
    let key = end;
    for (let i = 0; key >= start && i < 40000; i++) {
      rows.push({ key: key, value: Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null });
      key = addDays(key, -1);
    }
    return rows;
  }

  function formatLong(key) {
    const d = parseKey(key);
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  function formatShort(key) {
    return parseKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  const api = { dateKey, parseKey, isValidKey, isValidCount, checkData, applyStep, addDays, buildRows, STEPS, MAX_COUNT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------
     App
  ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);

  const state = {
    data: {},
    step: DEFAULT_STEP,
    range: DEFAULT_RANGE,
    tab: 'today',
    shownDay: '',
    titles: [],
    pendingImport: null
  };

  let chart = null;
  let statusTimer = null;

  /* ----- storage ----- */

  function loadData() {
    let raw = null;
    try {
      raw = localStorage.getItem(DATA_KEY);
      if (!raw) return {};
      const res = checkData(JSON.parse(raw));
      return res.clean || {};
    } catch (e) {
      // Keep a copy of unreadable data instead of silently overwriting it.
      try { if (raw) localStorage.setItem(DATA_KEY + '.corrupt', raw); } catch (e2) { /* ignore */ }
      return {};
    }
  }

  function saveData() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state.data));
      return true;
    } catch (e) {
      setStatus('Could not save. Browser storage may be full or blocked.', true);
      return false;
    }
  }

  function loadStep() {
    try {
      const s = Number(localStorage.getItem(STEP_KEY));
      if (STEPS.indexOf(s) !== -1) return s;
    } catch (e) { /* ignore */ }
    return DEFAULT_STEP;
  }

  // Set (value) or clear (null) one day. Rolls back if the save fails.
  function commit(key, value) {
    const had = Object.prototype.hasOwnProperty.call(state.data, key);
    const prev = state.data[key];
    if (value === null) delete state.data[key]; else state.data[key] = value;
    if (saveData()) return true;
    if (had) state.data[key] = prev; else delete state.data[key];
    return false;
  }

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status' + (isError ? ' error' : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, 8000);
  }

  /* ----- Today tab ----- */

  function renderToday() {
    const key = dateKey();
    state.shownDay = key;
    const count = Object.prototype.hasOwnProperty.call(state.data, key) ? state.data[key] : 0;

    $('today-date').textContent = parseKey(key).toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long' });
    $('count').textContent = String(count);

    $('plus').textContent = '+' + state.step;
    $('plus').setAttribute('aria-label', 'Add ' + state.step);
    $('minus').textContent = '−' + state.step;
    $('minus').setAttribute('aria-label', 'Subtract ' + state.step);
    $('minus').disabled = count === 0;

    document.querySelectorAll('.step').forEach((b) => {
      const on = Number(b.dataset.step) === state.step;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function adjust(sign) {
    const key = dateKey();
    const cur = Object.prototype.hasOwnProperty.call(state.data, key) ? state.data[key] : 0;
    const next = applyStep(cur, sign, state.step);
    if (next === cur) return; // already at 0 (or the cap): nothing to change
    commit(key, next);
    renderToday();
  }

  function setStep(n) {
    state.step = n;
    try { localStorage.setItem(STEP_KEY, String(n)); } catch (e) { /* ignore */ }
    renderToday();
  }

  // A new day starts blank. Re-check when the app comes back to the screen.
  function checkDay() {
    if (dateKey() === state.shownDay) return;
    renderToday();
    if (state.tab === 'history') renderHistory();
  }

  /* ----- History tab ----- */

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return { accent: v('--accent'), muted: v('--muted'), grid: v('--grid') };
  }

  function renderHistory() {
    const rows = buildRows(state.data, state.range, dateKey());
    document.querySelectorAll('.range').forEach((b) => {
      const on = b.dataset.range === state.range;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    renderChart(rows);
    renderList(rows);
  }

  function renderChart(rows) {
    const wrap = $('chart-wrap');
    const empty = $('chart-empty');

    if (typeof Chart === 'undefined') {
      wrap.hidden = true;
      empty.hidden = false;
      empty.textContent = 'The graph library could not load. Connect to the internet once, then reload.';
      return;
    }

    // Only days that have a number; blank days are skipped.
    const pts = rows.filter((r) => r.value !== null).reverse();
    if (!pts.length) {
      wrap.hidden = true;
      empty.hidden = false;
      empty.textContent = 'No numbers in this range yet.';
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;

    const labels = pts.map((p) => formatShort(p.key));
    const values = pts.map((p) => p.value);
    state.titles = pts.map((p) => formatLong(p.key));
    const c = themeColors();

    if (!chart) {
      chart = new Chart($('chart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            data: values,
            borderColor: c.accent,
            backgroundColor: c.accent,
            borderWidth: 2.5,
            tension: 0.25,
            pointRadius: values.length > 45 ? 0 : 4,
            pointHoverRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 250 },
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: { title: (items) => state.titles[items[0].dataIndex] }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, color: c.muted } },
            y: { beginAtZero: true, grid: { color: c.grid }, ticks: { precision: 0, color: c.muted } }
          }
        }
      });
    } else {
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.data.datasets[0].pointRadius = values.length > 45 ? 0 : 4;
      chart.update();
      chart.resize();
    }
  }

  function renderList(rows) {
    const ul = $('history-list');
    ul.textContent = '';
    const today = dateKey();

    rows.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'row' + (r.value === null ? ' blank' : '');

      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = r.key === today ? 'Today' : formatLong(r.key);

      const val = document.createElement('span');
      val.className = 'value';
      val.textContent = r.value === null ? '' : String(r.value); // blank day = blank cell

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini';
      edit.dataset.action = 'edit';
      edit.dataset.key = r.key;
      edit.textContent = r.value === null ? 'Add' : 'Edit';
      edit.setAttribute('aria-label', (r.value === null ? 'Add number for ' : 'Edit number for ') + formatLong(r.key));

      li.appendChild(date);
      li.appendChild(val);
      li.appendChild(edit);

      if (r.value !== null) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini delete';
        del.dataset.action = 'delete';
        del.dataset.key = r.key;
        del.textContent = '×';
        del.setAttribute('aria-label', 'Clear number for ' + formatLong(r.key));
        li.appendChild(del);
      } else {
        li.appendChild(document.createElement('span')); // keep the grid aligned
      }
      ul.appendChild(li);
    });
  }

  function refreshAll() {
    renderToday();
    if (state.tab === 'history') renderHistory();
  }

  function editDay(key) {
    const cur = Object.prototype.hasOwnProperty.call(state.data, key) ? String(state.data[key]) : '';
    const answer = window.prompt('Number for ' + formatLong(key) + ' (whole number, 0 or more):', cur);
    if (answer === null) return;
    const text = answer.trim();
    if (!/^\d+$/.test(text) || !isValidCount(Number(text))) {
      setStatus('Enter a whole number from 0 to ' + MAX_COUNT + '.', true);
      return;
    }
    if (commit(key, Number(text))) refreshAll();
  }

  function deleteDay(key) {
    if (!window.confirm('Clear the number for ' + formatLong(key) + '?')) return;
    if (commit(key, null)) refreshAll();
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    window.scrollTo(0, 0);
    refreshAll();
  }

  /* ----- JSON export / import ----- */

  function exportData() {
    const keys = Object.keys(state.data).sort();
    if (!keys.length) {
      setStatus('Nothing to export yet.');
      return;
    }
    const out = {};
    keys.forEach((k) => { out[k] = state.data[k]; });
    const blob = new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tally-' + dateKey() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus('Exported ' + keys.length + (keys.length === 1 ? ' day.' : ' days.'));
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    reader.onerror = () => setStatus('Could not read that file.', true);
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        setStatus('That file is not valid JSON.', true);
        return;
      }
      const res = checkData(parsed);
      if (res.error) {
        setStatus(res.error, true);
        return;
      }
      if (res.badCount) {
        setStatus('Nothing imported. ' + res.badCount + ' entries are not a date like 2026-11-08 ' +
          'with a whole number of 0 or more (first: ' + res.firstBad + ').', true);
        return;
      }
      const keys = Object.keys(res.clean).sort();
      if (!keys.length) {
        setStatus('That file has no days in it.', true);
        return;
      }
      state.pendingImport = res.clean;
      $('import-text').textContent = 'Found ' + keys.length + (keys.length === 1 ? ' day' : ' days') +
        ' (' + keys[0] + ' to ' + keys[keys.length - 1] + '). Merge adds them and the file wins on matching dates. ' +
        'Replace all deletes the days saved now.';
      $('import-panel').hidden = false;
    };
    reader.readAsText(file);
  }

  function finishImport(mode) {
    const incoming = state.pendingImport;
    state.pendingImport = null;
    $('import-panel').hidden = true;
    if (!incoming || mode === 'cancel') return;

    const before = state.data;
    state.data = mode === 'replace' ? Object.assign({}, incoming) : Object.assign({}, before, incoming);
    if (!saveData()) {
      state.data = before;
      return;
    }
    setStatus('Imported ' + Object.keys(incoming).length + ' days (' + (mode === 'replace' ? 'replaced' : 'merged') + ').');
    refreshAll();
  }

  /* ----- start up ----- */

  function init() {
    state.data = loadData();
    state.step = loadStep();

    document.querySelectorAll('.step').forEach((b) =>
      b.addEventListener('click', () => setStep(Number(b.dataset.step))));
    $('plus').addEventListener('click', () => adjust(1));
    $('minus').addEventListener('click', () => adjust(-1));

    document.querySelectorAll('.tabbtn').forEach((b) =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.querySelectorAll('.range').forEach((b) =>
      b.addEventListener('click', () => { state.range = b.dataset.range; renderHistory(); }));

    $('history-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'edit') editDay(btn.dataset.key);
      else deleteDay(btn.dataset.key);
    });

    $('export').addEventListener('click', exportData);
    $('import').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleImportFile(file);
    });
    $('import-merge').addEventListener('click', () => finishImport('merge'));
    $('import-replace').addEventListener('click', () => finishImport('replace'));
    $('import-cancel').addEventListener('click', () => finishImport('cancel'));

    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
    window.addEventListener('pageshow', checkDay);
    setInterval(checkDay, 60000);

    // Pick up changes made in another tab of the same browser.
    window.addEventListener('storage', (e) => {
      if (e.key === DATA_KEY || e.key === null) {
        state.data = loadData();
        refreshAll();
      }
    });

    // Redraw the graph in the new colours if the phone switches light/dark.
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onScheme = () => {
        if (chart) { chart.destroy(); chart = null; }
        if (state.tab === 'history') renderHistory();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
    }

    // Ask the browser not to clear this data when space is tight.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    // Offline support (needs https or localhost).
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    renderToday();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
