const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const capture = require('./src/audio/capture');
const { readWavMono } = require('./src/audio/wav');
const { Recognizer } = require('./src/classifier/recognizer');
const { PRESETS, COMP_RATIOS, MAX_EQ_BANDS, LIMITS } = require('./src/presets');
const { getProfile, listProfiles } = require('./src/consoles');
const { OscClient } = require('./src/consoles/osc-client');
const { applyChannels, restoreChannels, readChannelNames } = require('./src/consoles/apply');
const { discover, diagnose } = require('./src/consoles/network');

// Test modes get their own profile so they never overwrite the user's saved settings.
if (process.argv.some((a) => a === '--smoke-test' || a.startsWith('--ui-test='))) {
  app.setPath('userData', path.join(app.getPath('temp'), 'dialld-test-profile'));
}

// Models live outside the asar archive in packaged builds (onnxruntime needs a real file path).
const MODEL_DIR = path.join(__dirname, 'models').replace('app.asar', 'app.asar.unpacked');

let mainWindow = null;
const recognizer = new Recognizer({ modelDir: MODEL_DIR, presetKeys: Object.keys(PRESETS) });
const recognizerReady = recognizer.init();
recognizerReady.catch(() => { /* reported via app:info and on capture */ });

const oscClient = new OscClient();
let consoleProfile = getProfile('x32');
let captureAbort = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Batch OSC log lines so a 32-channel apply doesn't flood the renderer.
let logQueue = [];
let logTimer = null;
oscClient.on('log', (entry) => {
  logQueue.push({ ...entry, t: Date.now() });
  if (!logTimer) {
    logTimer = setTimeout(() => {
      send('osc:log', logQueue);
      logQueue = [];
      logTimer = null;
    }, 100);
  }
});
oscClient.on('error', (err) => send('console:error', err.message || String(err)));

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Analyzes channels one at a time, streaming each result to the renderer
 * so rows fill in as soon as they're ready.
 * @param {{label:string, pcm:Float32Array, sampleRate:number}[]} channels
 */
async function analyzeChannels(channels) {
  await recognizerReady;
  const results = [];
  for (let n = 0; n < channels.length; n++) {
    const { label, pcm, sampleRate } = channels[n];
    const r = await recognizer.analyze(pcm, sampleRate);
    const result = {
      index: n,
      label,
      levels: r.levels,
      instrument: r.instrument,
      heard: r.heard,
    };
    results.push(result);
    send('analysis:channel', result);
  }
  return results;
}

ipcMain.handle('app:info', async () => {
  let modelError = null;
  try { await recognizerReady; } catch (e) { modelError = errorMessage(e); }
  return {
    presets: PRESETS,
    presetLimits: LIMITS,
    compRatios: COMP_RATIOS,
    maxEqBands: MAX_EQ_BANDS,
    profiles: listProfiles(),
    recognizerMode: recognizer.mode,
    modelError,
  };
});

ipcMain.handle('audio:listDevices', async () => {
  try {
    return { ok: true, devices: capture.listInputDevices() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('session:capture', async (_e, opts) => {
  if (captureAbort) return { ok: false, error: 'A capture is already running' };
  captureAbort = new AbortController();
  try {
    await recognizerReady;
    const take = await capture.record({
      deviceKey: opts.deviceKey,
      channelCount: opts.channelCount,
      firstChannel: opts.firstChannel || 0,
      sampleRate: opts.sampleRate || undefined,
      durationSec: opts.durationSec,
      signal: captureAbort.signal,
      onLevels: (peaks, progress) => send('capture:levels', { peaks, progress }),
    });
    send('capture:done', null);
    const channels = take.channels.map((pcm, n) => ({ label: `In ${n + 1 + (opts.firstChannel || 0)}`, pcm, sampleRate: take.sampleRate }));
    const results = await analyzeChannels(channels);
    return { ok: true, results, sampleRate: take.sampleRate };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    captureAbort = null;
  }
});

ipcMain.handle('session:cancel', async () => {
  if (captureAbort) captureAbort.abort();
  return { ok: true };
});

let testFilePaths = null; // set by scripts/ui-test.js instead of showing the file dialog

ipcMain.handle('session:analyzeFiles', async (_e, opts) => {
  const pick = testFilePaths ? { canceled: false, filePaths: testFilePaths } : await dialog.showOpenDialog(mainWindow, {
    title: 'Pick one WAV file per channel (stems)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
  try {
    const files = pick.filePaths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const channels = files.map((file) => {
      const { sampleRate, pcm } = readWavMono(file, opts.durationSec);
      return { label: path.basename(file, path.extname(file)), pcm, sampleRate };
    });
    send('capture:done', null);
    return { ok: true, results: await analyzeChannels(channels) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

async function discoverConsoles(profile) {
  return profile.discovery ? discover(profile.discovery) : [];
}

ipcMain.handle('console:discover', async (_e, { profileId }) => {
  try {
    return { ok: true, consoles: await discoverConsoles(getProfile(profileId)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('console:connect', async (_e, { profileId, host, port }) => {
  try {
    consoleProfile = getProfile(profileId);
    await oscClient.open(host, port);
    if (!consoleProfile.probe) return { ok: true, status: 'open', diagnosis: diagnose(host) };
    const reply = await oscClient.query(consoleProfile.probe.address, 1000);
    if (!reply) {
      // Didn't answer: explain why, and look for the console elsewhere on the network.
      const found = (await discoverConsoles(consoleProfile)).filter((c) => c.host !== host);
      return { ok: true, status: 'no-reply', diagnosis: diagnose(host), found };
    }
    const info = consoleProfile.probe.describe
      ? consoleProfile.probe.describe(reply)
      : reply.map((a) => a.value).filter((v) => typeof v === 'string').join(' · ');
    return { ok: true, status: 'connected', info };
  } catch (err) {
    oscClient.close();
    return { ok: false, error: errorMessage(err), diagnosis: diagnose(host) };
  }
});

ipcMain.handle('console:disconnect', async () => {
  oscClient.close();
  return { ok: true };
});

ipcMain.handle('console:channelNames', async (_e, { profileId, channels }) => {
  try {
    if (!oscClient.connected) return { ok: false, error: 'Not connected to a console' };
    return { ok: true, names: await readChannelNames({ client: oscClient, profile: getProfile(profileId), channels }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('console:apply', async (_e, { profileId, items, dryRun }) => {
  try {
    const profile = getProfile(profileId);
    const client = dryRun ? null : oscClient;
    if (client && !client.connected) return { ok: false, error: 'Not connected to a console' };
    const results = await applyChannels({ client, profile, presets: PRESETS, items });
    if (dryRun) {
      send('osc:log', results.flatMap((r) => r.messages.map((m) => ({ dir: 'dry', t: Date.now(), ...m }))));
    }
    return { ok: true, results: results.map(summarize) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

const summarize = ({ messages, restore, ...r }) => ({ ...r, messageCount: messages.length });

// Audition: the original values of every parameter changed, per channel,
// so "Undo audition" can put the desk back exactly as it was.
let audition = null; // { profileId, restores: Map<channel, {address, args}[]> }

ipcMain.handle('console:audition', async (_e, { profileId, items }) => {
  try {
    const profile = getProfile(profileId);
    if (!oscClient.connected) return { ok: false, error: 'Not connected to a console' };
    if (audition && audition.profileId !== profileId) return { ok: false, error: 'Undo or keep the current audition first' };
    if (!audition) audition = { profileId, restores: new Map() };

    // A channel that's already being auditioned (its instrument or preset was
    // changed) keeps its original snapshot, so Undo still goes back to the start.
    const results = await applyChannels({ client: oscClient, profile, presets: PRESETS, snapshot: true, items });
    for (const r of results) {
      if (!r.ok || !r.restore) continue;
      const original = audition.restores.get(r.channel) || [];
      const known = new Set(original.map((m) => m.address));
      audition.restores.set(r.channel, [...original, ...r.restore.filter((m) => !known.has(m.address))]);
    }
    if (!audition.restores.size) audition = null;
    return { ok: true, active: !!audition, results: results.map(summarize) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('console:auditionUndo', async () => {
  if (!audition) return { ok: true, results: [] };
  if (!oscClient.connected) return { ok: false, error: 'Reconnect to the console to undo the audition' };
  const restores = [...audition.restores].map(([channel, messages]) => ({ channel, messages }));
  audition = null;
  return { ok: true, results: await restoreChannels({ client: oscClient, restores }) };
});

ipcMain.handle('console:auditionKeep', async () => {
  audition = null;
  return { ok: true };
});

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0B0D10',
    autoHideMenuBar: true,
    title: 'DIALLD',
    show,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: show,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/**
 * `npm run smoke`: loads the native modules inside Electron, lists devices,
 * analyzes synthetic channels and builds an X32 apply in dry-run mode.
 */
async function smokeTest() {
  const report = {};
  try {
    const t0 = Date.now();
    await recognizerReady;
    report.modelLoadMs = Date.now() - t0;
    report.recognizerMode = recognizer.mode;
    report.devices = capture.listInputDevices().map((d) => `[${d.apiLabel}] ${d.name} (${d.channels} in)`);
    const sr = 48000;
    const tone = new Float32Array(sr * 10).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr));
    const silence = new Float32Array(sr * 10);
    const t1 = Date.now();
    const results = await analyzeChannels(
      [{ label: 'tone', pcm: tone, sampleRate: sr }, { label: 'silence', pcm: silence, sampleRate: sr }]
    );
    report.analyzeMs = Date.now() - t1;
    report.results = results.map((r) => ({ label: r.label, instrument: r.instrument, heard: r.heard }));
    const applied = await applyChannels({
      client: null, profile: getProfile('x32'), presets: PRESETS,
      items: [{ channel: 1, instrumentKey: 'kick' }],
    });
    report.x32MessagesForKick = applied[0].messages.length;
    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = err.stack || String(err);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  app.exit(report.ok ? 0 : 1);
}

const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

if (process.argv.includes('--smoke-test')) {
  app.whenReady().then(smokeTest);
} else if (argValue('ui-test')) {
  app.whenReady().then(() => {
    createWindow({ show: false });
    require('./scripts/ui-test').run({
      win: mainWindow,
      folder: argValue('ui-test'),
      outDir: argValue('ui-shots') || path.join(app.getPath('temp'), 'dialld-ui-test'),
      setTestFiles: (files) => { testFilePaths = files; },
      quit: (code) => app.exit(code),
      connectOnly: argValue('ui-connect'),
      profile: argValue('ui-profile') || 'x32',
    }).catch((err) => { console.error(err); app.exit(1); });
  });
} else {
  app.whenReady().then(() => createWindow());
  app.on('window-all-closed', () => {
    oscClient.close();
    if (captureAbort) captureAbort.abort();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
