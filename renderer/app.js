'use strict';

const api = window.dialld;
const $ = (id) => document.getElementById(id);

const FAMILY_COLOR = {
  drums: 'var(--fam-drums)', bass: 'var(--fam-bass)', guitar: 'var(--fam-guitar)',
  vocal: 'var(--fam-vocal)', keys: 'var(--fam-keys)', horns: 'var(--fam-horns)',
};
const METER_FLOOR_DB = -60;
const LOG_LIMIT = 2000;
const TABLE_COLUMNS = 6;
const AUDITION_EDIT_DELAY_MS = 250; // re-send an edited preset this long after the last change

const state = {
  presets: {},        // factory presets with the user's saved defaults on top
  factoryPresets: {},
  presetLimits: null,
  compRatios: [],
  maxEqBands: 4,
  profiles: [],
  devices: [],
  channels: [],      // one entry per analyzed channel, see makeChannel()
  consoleNames: new Map(), // console channel -> name read from the desk
  busy: null,        // null | 'capture' | 'analyze' | 'apply'
  auditioning: false, // presets are on the desk with the originals saved for undo
  connected: false,
  consoleAnswered: false, // the desk replied, so it can be read from (names)
  meterPeaks: [],
  captureStartedAt: 0,
};

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const pad2 = (n) => String(n).padStart(2, '0');
const toDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const fmtDb = (db) => (Number.isFinite(db) ? db.toFixed(1).replace('-', '−') : '−∞');
const dbToPct = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
const clonePreset = (p) => (p ? JSON.parse(JSON.stringify(p)) : null);

function showBanner(message, kind = 'error') {
  const b = $('banner');
  b.textContent = message;
  b.className = 'banner' + (kind === 'info' ? ' info' : '');
  b.hidden = !message;
}

// ---------------------------------------------------------------------
// settings (remembered between sessions)
// ---------------------------------------------------------------------
const SETTINGS_KEY = 'dialld.settings.v2';
const SETTING_FIELDS = ['profile', 'host', 'port', 'device', 'channelCount', 'firstInput', 'firstConsoleCh', 'duration'];

const LEGACY_SETTINGS_KEY = 'automix.settings.v2'; // before the rename to DIALLD

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveSettings() {
  const s = {};
  for (const f of SETTING_FIELDS) s[f] = $(f).value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
}
const settings = loadSettings();

// The user's own versions of the stock presets ("Save as my … preset").
const USER_PRESETS_KEY = 'dialld.userPresets.v1';

function loadUserPresets() {
  try {
    return JSON.parse(localStorage.getItem(USER_PRESETS_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveUserPresets(userPresets) {
  try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(userPresets)); } catch (e) { /* storage unavailable */ }
}
const userPresets = loadUserPresets();

// ---------------------------------------------------------------------
// devices + console
// ---------------------------------------------------------------------
async function loadDevices() {
  const sel = $('device');
  const previous = sel.value || settings.device;
  sel.replaceChildren(h('option', { value: '' }, 'Scanning…'));
  const res = await api.listAudioDevices();
  state.devices = res.ok ? res.devices : [];
  sel.replaceChildren();
  if (!res.ok) showBanner(`Audio devices unavailable: ${res.error}`);
  if (!state.devices.length) {
    sel.append(h('option', { value: '' }, 'No input devices found'));
    return;
  }
  for (const d of state.devices) {
    sel.append(h('option', { value: d.key }, `[${d.apiLabel}] ${d.name} — ${d.channels} in`));
  }
  if (previous && state.devices.some((d) => d.key === previous)) sel.value = previous;
  else onDeviceChange();
}

function currentDevice() {
  return state.devices.find((d) => d.key === $('device').value);
}

function onDeviceChange() {
  const d = currentDevice();
  if (d) {
    const max = profileById($('profile').value).maxChannels;
    $('channelCount').value = Math.min(d.channels, max);
    $('firstInput').value = 1;
  }
  saveSettings();
}

function profileById(id) {
  return state.profiles.find((p) => p.id === id) || state.profiles[0];
}

let lastProfileDefaultPort = null;
function onProfileChange() {
  const p = profileById($('profile').value);
  if (!$('port').value || $('port').value === String(lastProfileDefaultPort)) $('port').value = p.defaultPort;
  lastProfileDefaultPort = p.defaultPort;
  $('findBtn').hidden = !p.canDiscover;
  if (state.connected) disconnect();
  setChannelNames(new Map()); // they belonged to the other console
  saveSettings();
}

function setConn(kind, label) {
  $('connDot').className = 'dot ' + kind;
  $('connLabel').textContent = label;
  $('connLabel').title = label;
}

function describeConsole(c) {
  return `${c.host} (${[c.model, c.name].filter(Boolean).join(' ')}${c.firmware ? ' v' + c.firmware : ''}, via ${c.via})`;
}

function offerConsoles(consoles) {
  $('consoleList').replaceChildren(...consoles.map((c) => h('option', { value: c.host }, describeConsole(c))));
}

async function toggleConnect() {
  if (state.connected) return disconnect();
  if (!$('host').value.trim() && profileById($('profile').value).canDiscover) return findConsoles();
  const host = $('host').value.trim();
  const port = parseInt($('port').value, 10);
  if (!host || !port) { setConn('off', 'Enter the console IP and port'); return; }
  saveSettings();
  setConn('warn', 'Connecting…');
  $('connectBtn').disabled = true;
  $('findBtn').disabled = true;
  const res = await api.connectConsole($('profile').value, host, port);
  $('connectBtn').disabled = false;
  $('findBtn').disabled = false;
  if (!res.ok) {
    setConn('off', 'Connection failed');
    showBanner(`Couldn't connect to ${host}: ${res.error}. ${res.diagnosis || ''}`);
    return;
  }

  if (res.status === 'no-reply' && res.found && res.found.length === 1) {
    // The typed address didn't answer but a console did — switch to it.
    await api.disconnectConsole();
    const found = res.found[0];
    $('host').value = found.host;
    $('port').value = found.port;
    showBanner(`${host} didn't answer, but a console was found at ${describeConsole(found)} — connecting to that instead.`, 'info');
    return toggleConnect();
  }

  state.connected = true;
  state.consoleAnswered = res.status === 'connected';
  $('connectBtn').textContent = 'Disconnect';
  if (res.status === 'connected') {
    setConn('live', `${host} · ${res.info || 'connected'}`);
    if (!$('banner').classList.contains('info')) showBanner('');
  } else if (res.status === 'no-reply') {
    setConn('warn', `No reply from ${host}:${port}`);
    if (res.found && res.found.length > 1) {
      offerConsoles(res.found);
      showBanner(`${host} didn't answer. Consoles found: ${res.found.map(describeConsole).join('; ')}. Click the IP box to pick one, then Connect.`);
    } else {
      showBanner(`${host} didn't answer on port ${port}. ${res.diagnosis || 'Check the console is on, the cable is plugged in, and the IP matches Setup → Network on the console.'}`);
    }
  } else {
    setConn('live', `Sending to ${host}:${port}`);
    if (res.diagnosis) showBanner(res.diagnosis);
  }
  updateApplyButton();
  readChannelNames(state.channels.filter(Boolean).map((c) => c.consoleCh));
}

async function findConsoles({ quiet = false } = {}) {
  if (state.connected) await disconnect();
  setConn('warn', 'Searching the network…');
  $('findBtn').disabled = true;
  $('connectBtn').disabled = true;
  const res = await api.discoverConsoles($('profile').value);
  $('findBtn').disabled = false;
  $('connectBtn').disabled = false;
  const consoles = res.ok ? res.consoles : [];
  offerConsoles(consoles);
  if (consoles.length === 1) {
    $('host').value = consoles[0].host;
    $('port').value = consoles[0].port;
    showBanner('');
    return toggleConnect();
  }
  setConn('off', 'Console offline');
  if (consoles.length > 1) {
    showBanner(`Found ${consoles.length} consoles: ${consoles.map(describeConsole).join('; ')}. Click the IP box to pick one, then Connect.`, 'info');
  } else if (!quiet) {
    showBanner('No console answered on any network port. Check the console is switched on and the cable is plugged in. '
      + 'With a cable straight from the computer to the console there is no DHCP, so this computer\'s Ethernet port needs a fixed IP in the console\'s range '
      + '(e.g. 192.168.0.200, mask 255.255.255.0 — Windows: Settings → Network → Ethernet → IP assignment → Manual). '
      + 'The console\'s own IP is under Setup → Network.');
  }
}

async function disconnect() {
  await api.disconnectConsole();
  state.connected = false;
  state.consoleAnswered = false;
  $('connectBtn').textContent = 'Connect';
  setConn('off', 'Console offline');
  updateApplyButton();
}

// ---------------------------------------------------------------------
// channel names (scribble strips) from the console
// ---------------------------------------------------------------------
function canReadNames() {
  const profile = state.profiles.length ? profileById($('profile').value) : null;
  return !!(profile && profile.canReadNames && state.consoleAnswered);
}

/** Reads the names of these console channels; quietly does nothing if the desk can't say. */
async function readChannelNames(consoleChs) {
  if (!canReadNames() || !consoleChs.length) return;
  const res = await api.readChannelNames($('profile').value, consoleChs);
  if (!res.ok) return;
  const names = new Map(state.consoleNames);
  for (const ch of consoleChs) names.set(ch, res.names[ch] || null);
  setChannelNames(names);
}

function setChannelNames(names) {
  state.consoleNames = names;
  for (const ch of state.channels) {
    if (!ch) continue;
    const name = names.get(ch.consoleCh) || null;
    if (name !== ch.consoleName) {
      ch.consoleName = name;
      renderRow(ch);
    }
  }
}

// ---------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------
function setBusy(kind) {
  state.busy = kind;
  const btn = $('captureBtn');
  const capturing = kind === 'capture';
  btn.classList.toggle('recording', capturing);
  $('captureLabel').textContent = capturing ? 'Stop' : kind === 'analyze' ? 'Analyzing…' : `Capture ${$('duration').value} s`;
  updateApplyButton();
}

function buildMeters(count) {
  state.meterPeaks = new Array(count).fill(0);
  $('meters').replaceChildren(...Array.from({ length: count }, (_, i) => h('div', { class: 'meter' },
    h('div', { class: 'meter-track' }, h('div', { class: 'meter-clip' }), h('div', { class: 'meter-fill' })),
    h('div', { class: 'meter-num' }, pad2(i + 1))
  )));
}

function onLevels({ peaks, progress }) {
  const meters = $('meters').children;
  peaks.forEach((p, i) => {
    const m = meters[i];
    if (!m) return;
    state.meterPeaks[i] = Math.max(state.meterPeaks[i], p);
    m.querySelector('.meter-fill').style.height = dbToPct(toDb(p)) + '%';
    if (p >= 0.999) m.querySelector('.meter-clip').classList.add('on');
  });
  $('progressFill').style.width = (progress * 100).toFixed(1) + '%';
  const total = parseFloat($('duration').value);
  $('progressTime').textContent = `${(progress * total).toFixed(1)} / ${total} s`;
}

function captureOptions() {
  return { durationSec: parseFloat($('duration').value) };
}

function firstConsoleCh() {
  return parseInt($('firstConsoleCh').value, 10) || 1;
}

function startSession(labelText, channelCount) {
  showBanner('');
  state.channels = [];
  $('rows').replaceChildren();
  $('emptyPanel').hidden = true;
  $('resultsPanel').hidden = true;
  $('progressPanel').hidden = false;
  $('progressLabel').textContent = labelText;
  $('progressFill').style.width = '0%';
  $('progressTime').textContent = '';
  if (channelCount) buildMeters(channelCount);
  else $('meters').replaceChildren();
}

async function onCapture() {
  if (state.busy === 'capture') { api.cancelCapture(); return; }
  if (state.busy) return;
  const device = currentDevice();
  if (!device) { showBanner('Pick an input device first.'); return; }
  const channelCount = parseInt($('channelCount').value, 10);
  const firstInput = parseInt($('firstInput').value, 10) || 1;
  if (!(channelCount > 0)) { showBanner('Enter how many channels to capture.'); return; }
  if (firstInput - 1 + channelCount > device.channels) {
    showBanner(`${device.name} has ${device.channels} inputs — inputs ${firstInput}–${firstInput + channelCount - 1} don't exist.`);
    return;
  }
  saveSettings();
  startSession(`Recording ${channelCount} channels from ${device.name} — play now`, channelCount);
  setBusy('capture');
  // Names are read while the band plays, so rows show them as soon as they appear.
  readChannelNames(Array.from({ length: channelCount }, (_, n) => firstConsoleCh() + n));
  const res = await api.capture({
    ...captureOptions(),
    deviceKey: device.key,
    channelCount,
    firstChannel: firstInput - 1,
  });
  finishSession(res);
}

async function onAnalyzeFiles() {
  if (state.busy) return;
  setBusy('analyze');
  const res = await api.analyzeFiles(captureOptions());
  if (res.canceled) { setBusy(null); return; }
  finishSession(res);
}

function onCaptureDone() {
  // File analysis has no recording phase; its progress panel starts here.
  if ($('progressPanel').hidden) startSession('Identifying instruments…', 0);
  setBusy('analyze');
  $('progressLabel').textContent = 'Identifying instruments…';
  $('progressFill').style.width = '100%';
  $('resultsPanel').hidden = false;
}

function makeChannel(result) {
  const recommended = result.instrument && result.instrument.key;
  const consoleCh = firstConsoleCh() + result.index;
  return {
    ...result,
    consoleCh,
    consoleName: state.consoleNames.get(consoleCh) || null,
    key: recommended || '',
    recommended,
    preset: clonePreset(state.presets[recommended]), // this channel's own copy, edited in place
    edited: false,
    editorOpen: false,
    selected: result.levels.hasSignal,
    status: null,
  };
}

function onChannelAnalyzed(result) {
  const ch = makeChannel(result);
  state.channels[result.index] = ch;
  $('resultsPanel').hidden = false;
  renderRow(ch);
  renderSummary();
}

function finishSession(res) {
  setBusy(null);
  $('progressPanel').hidden = true;
  if (!res.ok) {
    if (!res.canceled) showBanner(res.error);
    if (!state.channels.length) { $('resultsPanel').hidden = true; $('emptyPanel').hidden = false; }
    return;
  }
  // Results normally stream in via onChannelAnalyzed; this covers anything missed.
  res.results.forEach((r) => { if (!state.channels[r.index]) onChannelAnalyzed(r); });
  renderSummary();
  readChannelNames(state.channels.filter(Boolean).map((c) => c.consoleCh));
}

// ---------------------------------------------------------------------
// results table
// ---------------------------------------------------------------------
function confClass(c) {
  return c >= 0.6 ? 'high' : c >= 0.35 ? 'mid' : 'low';
}

/** Approximate response of the HPF (12 dB/oct) + bell bands, for display only. */
function eqCurve(preset, { W = 110, H = 32, dbScale = 2.4, cls = 'eq-curve' } = {}) {
  const mid = H / 2;
  const lo = Math.log10(20), hi = Math.log10(20000);
  const pts = [];
  for (let x = 0; x <= W; x += 2) {
    const lf = lo + (x / W) * (hi - lo);
    let g = 0;
    for (const b of preset.eq) {
      const sigma = 0.5 / Math.max(0.3, b.q);
      const d = lf - Math.log10(b.f);
      g += b.g * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    const f = Math.pow(10, lf);
    if (f < preset.hpf) g -= 12 * Math.log2(preset.hpf / f);
    const y = Math.max(0, Math.min(H, mid - g * dbScale));
    pts.push(`${x},${y.toFixed(1)}`);
  }
  const el = svg('svg', { class: cls, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  el.append(svg('line', { x1: 0, y1: mid, x2: W, y2: mid }), svg('path', { d: 'M' + pts.join(' L') }));
  return el;
}

function presetSummary(ch) {
  const p = ch.preset;
  if (!p) return h('span', { class: 'muted' }, 'Pick an instrument to apply a preset');
  const gate = p.gate.on ? h('span', {}, 'Gate ', h('b', {}, fmtDb(p.gate.thr))) : h('span', { class: 'off' }, 'Gate off');
  const comp = p.comp.on ? h('span', {}, 'Comp ', h('b', {}, `${p.comp.ratio}:1`), ` @ ${fmtDb(p.comp.thr)}`) : h('span', { class: 'off' }, 'Comp off');
  return h('div', { class: 'preset' },
    h('button', { class: 'curve-btn', title: 'Edit EQ and dynamics', onclick: () => toggleEditor(ch) }, eqCurve(p)),
    h('div', { class: 'preset-text' },
      h('div', {}, 'HPF ', h('b', {}, `${Math.round(p.hpf)} Hz`), ch.edited ? h('span', { class: 'tag', title: 'Changed from the stock preset' }, 'edited') : null),
      h('div', {}, gate, ' · ', comp)),
    h('button', { class: 'btn ghost small' + (ch.editorOpen ? ' active' : ''), onclick: () => toggleEditor(ch) }, ch.editorOpen ? 'Close' : 'Edit')
  );
}

function renderRow(ch) {
  const preset = state.presets[ch.key];
  const levels = ch.levels;
  const silent = !levels.hasSignal;

  const select = h('select', {
    title: 'Instrument / preset',
    onchange: (e) => { ch.key = e.target.value; ch.selected = ch.selected || !!ch.key; onInstrumentChanged(ch); },
  }, h('option', { value: '' }, silent ? '— no signal —' : '— pick —'),
  Object.entries(state.presets).map(([k, p]) => h('option', { value: k, selected: k === ch.key }, p.label + (k === ch.recommended ? '  ★' : ''))));

  const inst = ch.instrument;
  const alts = inst && !silent ? [ch.recommended, ...inst.alternatives.map((a) => a.key)].filter((k) => k && k !== ch.key) : [];

  const heard = ch.heard && ch.heard.length && !silent
    ? 'Model heard: ' + ch.heard.map((x) => `${x.name} ${Math.round(x.score * 100)}%`).join(', ')
    : null;

  const tr = h('tr', { class: silent ? 'silent' : '', 'data-index': ch.index },
    h('td', {}, h('input', {
      type: 'checkbox', checked: ch.selected, disabled: state.auditioning,
      onchange: (e) => { ch.selected = e.target.checked; renderSummary(); },
    })),
    h('td', { class: 'ch-cell' },
      h('span', { class: 'fam-bar', style: { background: preset ? FAMILY_COLOR[preset.family] : '' } }),
      h('span', { class: 'ch-id', title: ch.consoleName ? `${ch.consoleName} (console name) — captured from ${ch.label}` : ch.label },
        h('div', { class: 'ch-num' }, `CH ${pad2(ch.consoleCh)}`),
        ch.consoleName ? h('div', { class: 'ch-name' }, ch.consoleName) : null,
        h('div', { class: 'ch-src' }, ch.label))
    ),
    h('td', {}, h('div', { class: 'level' },
      h('div', { class: 'hbar' },
        h('div', { class: 'hbar-fill', style: { width: dbToPct(levels.peakDb) + '%', background: levels.clipped ? 'var(--red)' : '' } })),
      h('div', { class: 'level-nums' }, silent ? 'no signal'
        : [`pk ${fmtDb(levels.peakDb)}  avg ${fmtDb(levels.activeRmsDb)}`, levels.clipped ? h('span', { class: 'clip' }, '  CLIP') : null])
    )),
    h('td', {}, h('div', { class: 'inst' },
      h('div', { class: 'inst-top' }, select,
        inst && inst.key && ch.key === ch.recommended && !silent
          ? h('span', { class: 'conf ' + confClass(inst.confidence), title: `Confidence\n${heard || ''}` }, Math.round(inst.confidence * 100) + '%')
          : null),
      alts.length ? h('div', { class: 'alts', title: heard }, alts.map((k) => h('button', {
        class: 'chip', title: k === ch.recommended ? 'DIALLD suggestion' : 'Alternative',
        onclick: () => { ch.key = k; ch.selected = true; onInstrumentChanged(ch); },
      }, (k === ch.recommended ? '★ ' : '') + state.presets[k].label))) : null
    )),
    h('td', {}, presetSummary(ch)),
    h('td', {}, renderStatus(ch))
  );

  const tbody = $('rows');
  const existing = tbody.querySelector(`tr[data-index="${ch.index}"]`);
  if (existing) existing.replaceWith(tr);
  else {
    const after = [...tbody.children].find((r) => parseInt(r.dataset.index, 10) > ch.index);
    tbody.insertBefore(tr, after || null);
  }
}

function renderStatus(ch) {
  const s = ch.status;
  const applyOne = h('button', {
    class: 'btn ghost small', disabled: !!state.busy || state.auditioning || !ch.key,
    onclick: () => applyChannels([ch], false),
  }, 'Apply');
  if (!s) return h('div', { class: 'status' }, applyOne);
  return h('div', { class: 'status ' + s.kind }, h('div', {}, s.text), s.kind !== 'ok' && s.kind !== 'audition' ? applyOne : null);
}

function renderSummary() {
  const all = state.channels.filter(Boolean);
  const withSignal = all.filter((c) => c.levels.hasSignal).length;
  const selected = all.filter((c) => c.selected).length;
  $('summary').textContent = `${all.length} channels · ${withSignal} with signal · ${selected} selected`;
  $('selectAll').checked = selected > 0 && selected === all.length;
  $('selectAll').indeterminate = selected > 0 && selected < all.length;
  updateApplyButton();
}

function updateApplyButton() {
  const n = state.channels.filter((c) => c && c.selected).length;
  const profile = state.profiles.length ? profileById($('profile').value) : null;
  const btn = $('applyBtn');
  if (state.auditioning) {
    btn.textContent = 'Keep audition';
    btn.disabled = !!state.busy;
  } else {
    btn.textContent = state.connected ? `Apply ${n} channel${n === 1 ? '' : 's'}` : 'Connect a console to apply';
    btn.disabled = !!state.busy || n === 0 || !state.connected;
  }
  $('previewBtn').disabled = !!state.busy || n === 0 || state.auditioning;
  $('namesBtn').hidden = !(profile && profile.canReadNames);
  $('namesBtn').disabled = !canReadNames();

  const aud = $('auditionBtn');
  aud.classList.toggle('auditioning', state.auditioning);
  aud.textContent = state.auditioning ? '↺ Undo audition' : '▶ Audition';
  if (profile && !profile.canAudition) {
    aud.disabled = true;
    aud.title = `${profile.label} can't report its current settings, so there would be no way to undo — Audition isn't available.`;
  } else {
    aud.disabled = !!state.busy || !state.connected || (!state.auditioning && n === 0);
    aud.title = state.auditioning
      ? 'Put the auditioned channels back exactly as they were'
      : 'Try the presets on the console; press again to undo';
  }
  // Settings that would invalidate the audition are locked until it's undone or kept.
  for (const id of ['profile', 'connectBtn', 'findBtn']) $(id).disabled = state.auditioning || (id === 'connectBtn' && !!state.busy);
  $('captureBtn').disabled = state.auditioning || state.busy === 'analyze' || state.busy === 'apply';
  $('filesBtn').disabled = state.auditioning || !!state.busy;
}

// ---------------------------------------------------------------------
// preset editor (one row under the channel, opened with Edit)
// ---------------------------------------------------------------------
function toggleEditor(ch) {
  if (!ch.preset) return;
  ch.editorOpen = !ch.editorOpen;
  renderRow(ch);
  renderEditor(ch);
}

function renderEditor(ch) {
  const tbody = $('rows');
  const existing = tbody.querySelector(`tr.editor-row[data-editor="${ch.index}"]`);
  if (!ch.editorOpen || !ch.preset) {
    if (existing) existing.remove();
    return;
  }
  const tr = h('tr', { class: 'editor-row', 'data-editor': ch.index }, h('td', { colspan: TABLE_COLUMNS }, presetEditor(ch)));
  if (existing) existing.replaceWith(tr);
  else tbody.querySelector(`tr[data-index="${ch.index}"]`).after(tr);
}

/** A number box bound to obj[key]: updates live while typing, clamps to range when committed. */
function numField(ch, label, obj, key, [min, max], { step = 'any', unit = '' } = {}) {
  const commit = (input, final) => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) {
      if (final) input.value = obj[key];
      return;
    }
    const clamped = Math.max(min, Math.min(max, v));
    if (!final && clamped !== v) return; // still typing, e.g. "1" on the way to "120"
    if (final) input.value = clamped;
    if (obj[key] !== clamped) {
      obj[key] = clamped;
      onPresetEdited(ch);
    }
  };
  return h('label', { class: 'pe-field', title: `${min} to ${max}${unit ? ' ' + unit : ''}` },
    h('span', { class: 'pe-label' }, label),
    h('span', { class: 'pe-input' },
      h('input', {
        type: 'number', class: 'mono', min, max, step, value: obj[key],
        oninput: (e) => commit(e.target, false),
        onchange: (e) => commit(e.target, true),
      }),
      unit ? h('span', { class: 'pe-unit' }, unit) : null)
  );
}

function onOffToggle(ch, obj, label) {
  return h('label', { class: 'check pe-toggle' },
    h('input', { type: 'checkbox', checked: obj.on, onchange: (e) => { obj.on = e.target.checked; onPresetEdited(ch); } }),
    label);
}

function presetEditor(ch) {
  const p = ch.preset;
  const L = state.presetLimits;

  const bands = p.eq.map((band, n) => h('div', { class: 'pe-band' },
    h('span', { class: 'pe-band-num mono' }, n + 1),
    numField(ch, 'Freq', band, 'f', L.eq.f, { step: 1, unit: 'Hz' }),
    numField(ch, 'Gain', band, 'g', L.eq.g, { step: 0.5, unit: 'dB' }),
    numField(ch, 'Q', band, 'q', L.eq.q, { step: 0.1 }),
    h('button', {
      class: 'btn ghost small pe-remove', title: 'Remove this band',
      onclick: () => { p.eq.splice(n, 1); onPresetEdited(ch); renderEditor(ch); },
    }, '✕')
  ));

  const ratio = h('label', { class: 'pe-field' },
    h('span', { class: 'pe-label' }, 'Ratio'),
    h('select', {
      onchange: (e) => { p.comp.ratio = parseFloat(e.target.value); onPresetEdited(ch); },
    }, state.compRatios.map((r) => h('option', { value: r, selected: r === p.comp.ratio }, `${r}:1`)),
    // an off-list ratio (e.g. from Generic OSC presets) stays selectable
    state.compRatios.includes(p.comp.ratio) ? null : h('option', { value: p.comp.ratio, selected: true }, `${p.comp.ratio}:1`)));

  return h('div', { class: 'pe' },
    h('div', { class: 'pe-grid' },
      h('section', { class: 'pe-section pe-eq' },
        h('div', { class: 'pe-head' }, h('h3', {}, 'Filter & EQ')),
        eqCurve(p, { W: 300, H: 64, dbScale: 2, cls: 'eq-curve big' }),
        numField(ch, 'High-pass', p, 'hpf', L.hpf, { step: 1, unit: 'Hz' }),
        bands,
        p.eq.length < state.maxEqBands ? h('button', {
          class: 'btn ghost small',
          onclick: () => { p.eq.push({ f: 1000, g: 0, q: 1 }); onPresetEdited(ch); renderEditor(ch); },
        }, '+ Add band') : null),
      h('section', { class: 'pe-section' },
        h('div', { class: 'pe-head' }, h('h3', {}, 'Gate'), onOffToggle(ch, p.gate, 'On')),
        h('div', { class: 'pe-fields' + (p.gate.on ? '' : ' dim') },
          numField(ch, 'Threshold', p.gate, 'thr', L.gate.thr, { step: 0.5, unit: 'dB' }),
          numField(ch, 'Range', p.gate, 'range', L.gate.range, { step: 1, unit: 'dB' }),
          numField(ch, 'Attack', p.gate, 'attack', L.gate.attack, { step: 0.5, unit: 'ms' }),
          numField(ch, 'Hold', p.gate, 'hold', L.gate.hold, { step: 1, unit: 'ms' }),
          numField(ch, 'Release', p.gate, 'release', L.gate.release, { step: 5, unit: 'ms' }))),
      h('section', { class: 'pe-section' },
        h('div', { class: 'pe-head' }, h('h3', {}, 'Compressor'), onOffToggle(ch, p.comp, 'On')),
        h('div', { class: 'pe-fields' + (p.comp.on ? '' : ' dim') },
          numField(ch, 'Threshold', p.comp, 'thr', L.comp.thr, { step: 0.5, unit: 'dB' }),
          ratio,
          numField(ch, 'Attack', p.comp, 'attack', L.comp.attack, { step: 0.5, unit: 'ms' }),
          numField(ch, 'Release', p.comp, 'release', L.comp.release, { step: 5, unit: 'ms' }),
          numField(ch, 'Makeup', p.comp, 'makeup', L.comp.makeup, { step: 0.5, unit: 'dB' })))
    ),
    editorFooter(ch)
  );
}

function editorFooter(ch) {
  const label = state.presets[ch.key].label;
  const custom = !!userPresets[ch.key];
  return h('div', { class: 'pe-foot' },
    h('span', { class: 'muted' }, ch.edited
      ? `Edited for CH ${pad2(ch.consoleCh)} only.`
      : `Your ${custom ? 'saved' : 'stock'} ${label} preset.`),
    h('div', { class: 'pe-actions' },
      h('button', {
        class: 'btn ghost small', disabled: !ch.edited,
        title: `Go back to the ${label} preset`,
        onclick: () => { ch.preset = clonePreset(state.presets[ch.key]); ch.edited = false; onPresetEdited(ch, { edited: false }); renderEditor(ch); },
      }, 'Reset'),
      h('button', {
        class: 'btn ghost small', disabled: !ch.edited,
        title: `Use these settings for every ${label} channel from now on (remembered between sessions)`,
        onclick: () => saveAsDefault(ch),
      }, `Save as my ${label} preset`),
      custom ? h('button', {
        class: 'btn ghost small',
        title: `Forget your saved ${label} preset and go back to DIALLD's`,
        onclick: () => restoreFactory(ch.key),
      }, 'Restore stock preset') : null,
      h('button', { class: 'btn small', onclick: () => toggleEditor(ch) }, 'Done'))
  );
}

/** A preset value changed: redraw the row (not the editor, so typing keeps focus) and re-audition if live. */
function onPresetEdited(ch, { edited = true } = {}) {
  ch.edited = edited;
  if (!ch.auditioning) ch.status = null;
  renderRow(ch);
  const editor = $('rows').querySelector(`tr.editor-row[data-editor="${ch.index}"]`);
  if (editor) {
    editor.querySelector('.eq-curve.big').replaceWith(eqCurve(ch.preset, { W: 300, H: 64, dbScale: 2, cls: 'eq-curve big' }));
    editor.querySelector('.pe-foot').replaceWith(editorFooter(ch));
    editor.querySelectorAll('.pe-section').forEach((s) => {
      const toggle = s.querySelector('.pe-toggle input');
      if (toggle) s.querySelector('.pe-fields').classList.toggle('dim', !toggle.checked);
    });
  }
  if (ch.auditioning) scheduleAudition(ch);
}

/** Changed presets go to the desk once the user pauses, not on every keystroke. */
function scheduleAudition(ch) {
  clearTimeout(ch.auditionTimer);
  ch.auditionTimer = setTimeout(() => {
    if (!ch.auditioning || !state.auditioning) return;
    if (state.busy) { scheduleAudition(ch); return; }
    auditionItems(buildItems([ch], { markSkipped: false }));
  }, AUDITION_EDIT_DELAY_MS);
}

/** Channels still on the stock version of `key` follow a changed default. */
function updatePresetDefault(key, preset) {
  state.presets[key] = preset;
  for (const c of state.channels) {
    if (!c || c.key !== key || c.edited) continue;
    c.preset = clonePreset(preset);
    renderRow(c);
    renderEditor(c);
    if (c.auditioning) scheduleAudition(c);
  }
}

function saveAsDefault(ch) {
  const preset = clonePreset(ch.preset);
  userPresets[ch.key] = preset;
  saveUserPresets(userPresets);
  ch.edited = false;
  updatePresetDefault(ch.key, preset);
  renderRow(ch);
  renderEditor(ch);
  showBanner(`Saved. Every ${preset.label} channel will start from these settings, including future captures.`, 'info');
}

function restoreFactory(key) {
  delete userPresets[key];
  saveUserPresets(userPresets);
  updatePresetDefault(key, clonePreset(state.factoryPresets[key]));
  for (const c of state.channels) if (c && c.key === key) renderEditor(c);
}

// ---------------------------------------------------------------------
// apply / audition
// ---------------------------------------------------------------------
/** Channel -> what to send. Marks channels with nothing to do. */
function buildItems(channels, { markSkipped }) {
  const items = channels.map((ch) => ({
    ch,
    item: { channel: ch.consoleCh, instrumentKey: ch.key || null, preset: ch.key ? ch.preset : null },
  }));
  if (markSkipped) {
    for (const { ch, item } of items) {
      if (item.instrumentKey) continue;
      ch.status = { kind: 'warn', text: ch.levels.hasSignal ? 'Nothing to apply — pick an instrument' : 'No signal — skipped' };
      renderRow(ch);
    }
  }
  return items.filter(({ item }) => item.instrumentKey);
}

async function toggleAudition() {
  if (state.busy) return;
  if (state.auditioning) return undoAudition();
  const items = buildItems(state.channels.filter((c) => c && c.selected), { markSkipped: true });
  if (!items.length) { showBanner('Nothing to audition — pick an instrument first.', 'info'); return; }
  await auditionItems(items);
}

async function auditionItems(items) {
  showBanner('');
  setBusy('apply');
  const res = await api.audition($('profile').value, items.map((x) => x.item));
  state.auditioning = !!(res.ok && res.active);
  setBusy(null);
  if (!res.ok) { showBanner(res.error); return; }
  res.results.forEach((r, n) => {
    const ch = items[n].ch;
    if (!r.ok) {
      ch.status = { kind: 'err', text: r.error };
    } else {
      ch.auditioning = true;
      ch.status = { kind: 'audition', text: '▶ Auditioning' + (ch.edited ? ' (edited)' : '') + (r.warnings.length ? ' — ' + r.warnings.join('; ') : '') };
    }
    renderRow(ch);
  });
}

async function undoAudition() {
  setBusy('apply');
  const res = await api.undoAudition();
  setBusy(null);
  if (!res.ok) { showBanner(res.error); return; }
  state.auditioning = false;
  const failed = new Map(res.results.filter((r) => !r.ok).map((r) => [r.channel, r.error]));
  for (const ch of state.channels) {
    if (!ch || !ch.auditioning) continue;
    ch.auditioning = false;
    clearTimeout(ch.auditionTimer);
    ch.status = failed.has(ch.consoleCh)
      ? { kind: 'err', text: `Undo failed: ${failed.get(ch.consoleCh)}` }
      : { kind: 'info', text: '↺ Restored to how it was' };
    renderRow(ch);
  }
  updateApplyButton();
}

async function keepAudition() {
  await api.keepAudition();
  state.auditioning = false;
  for (const ch of state.channels) {
    if (!ch || !ch.auditioning) continue;
    ch.auditioning = false;
    clearTimeout(ch.auditionTimer);
    ch.status = { kind: 'ok', text: '✓ Applied' };
    renderRow(ch);
  }
  updateApplyButton();
}

/** Instrument changed: the channel starts again from that instrument's preset (heard straight away if auditioning). */
function onInstrumentChanged(ch) {
  ch.preset = clonePreset(state.presets[ch.key]);
  ch.edited = false;
  if (!ch.preset) ch.editorOpen = false;
  ch.status = ch.auditioning ? ch.status : null;
  renderRow(ch);
  renderEditor(ch);
  renderSummary();
  if (ch.auditioning && ch.key && !state.busy) auditionItems(buildItems([ch], { markSkipped: false }));
}

async function applyChannels(channels, dryRun) {
  if (state.busy) return;
  if (state.auditioning && !dryRun) return keepAudition();
  if (!dryRun && !state.connected) { showBanner('Connect to the console first (or use Preview OSC).'); return; }
  const items = buildItems(channels, { markSkipped: !dryRun });
  if (!items.length) { showBanner('Nothing to apply — pick an instrument first.', 'info'); return; }

  showBanner('');
  setBusy('apply');
  const res = await api.apply($('profile').value, items.map((x) => x.item), dryRun);
  setBusy(null);
  if (!res.ok) { showBanner(res.error); return; }
  if (dryRun) {
    document.querySelector('details.log').open = true;
    showBanner(`Preview: ${res.results.reduce((a, r) => a + r.messageCount, 0)} OSC messages for ${items.length} channels shown in the log below. Nothing was sent.`, 'info');
    return;
  }
  res.results.forEach((r, n) => {
    const ch = items[n].ch;
    if (!r.ok) {
      ch.status = { kind: 'err', text: r.error };
    } else {
      const text = '✓ Applied' + (ch.edited ? ' (edited)' : '');
      ch.status = r.warnings.length ? { kind: 'warn', text: text + ' — ' + r.warnings.join('; ') } : { kind: 'ok', text };
    }
    renderRow(ch);
  });
}

function applySelected(dryRun) {
  applyChannels(state.channels.filter((c) => c && c.selected), dryRun);
}

// ---------------------------------------------------------------------
// OSC log
// ---------------------------------------------------------------------
let logCount = 0;
function formatArgs(args) {
  return (args || []).map((a) => {
    const v = a && typeof a === 'object' && 'value' in a ? a.value : a;
    return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : String(v);
  }).join('  ');
}
function onOscLog(entries) {
  const body = $('logBody');
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const d = new Date(e.t);
    const t = d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    frag.append(h('div', { class: 'log-row' },
      h('span', { class: 't' }, t),
      h('span', { class: 'dir ' + e.dir }, { out: '→', in: '←', dry: 'dry' }[e.dir]),
      h('span', { class: 'addr' }, e.address),
      h('span', { class: 'args' }, formatArgs(e.args))));
  }
  body.append(frag);
  while (body.children.length > LOG_LIMIT) body.firstChild.remove();
  logCount += entries.length;
  $('logCount').textContent = `(${logCount})`;
  body.scrollTop = body.scrollHeight;
}
function clearLog() {
  logCount = 0;
  $('logCount').textContent = '';
  $('logBody').replaceChildren(h('div', { class: 'log-empty' }, 'Nothing sent yet.'));
}

// ---------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------
async function init() {
  clearLog();
  const info = await api.getInfo();
  state.factoryPresets = info.presets;
  state.presets = clonePreset(info.presets);
  for (const [key, p] of Object.entries(userPresets)) {
    if (state.presets[key]) state.presets[key] = { ...p, label: info.presets[key].label, family: info.presets[key].family };
  }
  state.presetLimits = info.presetLimits;
  state.compRatios = info.compRatios;
  state.maxEqBands = info.maxEqBands;
  state.profiles = info.profiles;
  if (info.modelError) showBanner(`Instrument model failed to load: ${info.modelError}`);

  const profileSel = $('profile');
  profileSel.replaceChildren(...state.profiles.map((p) => h('option', { value: p.id }, p.label)));
  if (settings.profile && state.profiles.some((p) => p.id === settings.profile)) profileSel.value = settings.profile;
  lastProfileDefaultPort = profileById(profileSel.value).defaultPort;
  $('findBtn').hidden = !profileById(profileSel.value).canDiscover;
  $('host').value = settings.host || '';
  $('port').value = settings.port || lastProfileDefaultPort;
  for (const f of ['channelCount', 'firstInput', 'firstConsoleCh', 'duration']) {
    if (settings[f]) $(f).value = settings[f];
  }
  setBusy(null);

  profileSel.addEventListener('change', onProfileChange);
  $('device').addEventListener('change', onDeviceChange);
  $('refreshDevices').addEventListener('click', loadDevices);
  for (const f of ['host', 'port', 'channelCount', 'firstInput', 'firstConsoleCh']) $(f).addEventListener('change', saveSettings);
  $('duration').addEventListener('change', () => { saveSettings(); setBusy(state.busy); });
  $('connectBtn').addEventListener('click', toggleConnect);
  $('findBtn').addEventListener('click', () => findConsoles());
  $('captureBtn').addEventListener('click', onCapture);
  $('filesBtn').addEventListener('click', onAnalyzeFiles);
  $('applyBtn').addEventListener('click', () => applySelected(false));
  $('previewBtn').addEventListener('click', () => applySelected(true));
  $('auditionBtn').addEventListener('click', toggleAudition);
  $('namesBtn').addEventListener('click', () => readChannelNames(state.channels.filter(Boolean).map((c) => c.consoleCh)));
  $('selectAll').addEventListener('change', (e) => {
    if (state.auditioning) { e.target.checked = !e.target.checked; return; }
    state.channels.forEach((c) => { if (c) c.selected = e.target.checked; });
    state.channels.forEach((c) => c && renderRow(c));
    renderSummary();
  });
  $('copyLogBtn').addEventListener('click', () => {
    const text = [...$('logBody').querySelectorAll('.log-row')].map((r) => r.innerText.replace(/\n/g, '  ')).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  });
  $('clearLogBtn').addEventListener('click', clearLog);

  api.onCaptureLevels(onLevels);
  api.onCaptureDone(onCaptureDone);
  api.onChannelAnalyzed(onChannelAnalyzed);
  api.onOscLog(onOscLog);
  api.onConsoleError((msg) => setConn('off', `Console error: ${msg}`));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.code === 'Space' && !typing) { e.preventDefault(); onCapture(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applySelected(false); }
    if ((e.key === 'a' || e.key === 'A') && !typing && !e.ctrlKey && !e.metaKey && !$('auditionBtn').disabled) { e.preventDefault(); toggleAudition(); }
    if (e.key === 'Escape' && state.busy === 'capture') api.cancelCapture();
  });

  await loadDevices();

  // First run: look for the console so the IP doesn't have to be typed.
  if (!$('host').value.trim() && profileById($('profile').value).canDiscover) findConsoles({ quiet: true });
}

init();
