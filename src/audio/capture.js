/**
 * Multichannel capture via audify (RtAudio, prebuilt — no compiler needed).
 *
 * On Windows this exposes ASIO, WASAPI and DirectSound devices. Console USB
 * cards (Behringer X-USB, Midas DN32, ...) usually only expose all of their
 * channels through ASIO; WASAPI/WDM typically shows them as stereo pairs.
 * On macOS everything (USB, Dante Virtual Soundcard, SoundGrid) is Core Audio.
 *
 * Devices are identified by "<api>:<name>" rather than RtAudio's numeric id,
 * because ids are reassigned whenever devices are plugged in or removed.
 */
let audify = null;
let audifyLoadError = null;
try {
  audify = require('audify');
} catch (e) {
  audifyLoadError = e;
}

const APIS_BY_PLATFORM = {
  win32: ['WINDOWS_ASIO', 'WINDOWS_WASAPI'], // DirectSound only duplicates WASAPI devices
  darwin: ['MACOSX_CORE'],
  linux: ['UNIX_JACK', 'LINUX_PULSE', 'LINUX_ALSA'],
};
const API_LABELS = {
  WINDOWS_ASIO: 'ASIO', WINDOWS_WASAPI: 'WASAPI', WINDOWS_DS: 'DirectSound',
  MACOSX_CORE: 'Core Audio', UNIX_JACK: 'JACK', LINUX_PULSE: 'Pulse', LINUX_ALSA: 'ALSA',
};
const NO_DATA_TIMEOUT_MS = 3000;
const ERROR_TYPE_DEBUG_WARNING = 1; // RtAudioErrorType: 0 WARNING, 1 DEBUG_WARNING, >1 real errors
const LEVEL_UPDATE_MS = 50;

function requireAudify() {
  if (!audify) {
    throw new Error(`Audio backend failed to load (${audifyLoadError && audifyLoadError.message}). Run "npm install" again.`);
  }
  return audify;
}

// One long-lived RtAudio instance per host API. Creating and discarding
// instances makes RtAudio report spurious errors (e.g. ASIO "no open stream
// to close") to whichever stream happens to be running.
const instances = new Map();
function rtFor(apiName) {
  const { RtAudio, RtAudioApi } = requireAudify();
  if (!instances.has(apiName)) instances.set(apiName, new RtAudio(RtAudioApi[apiName]));
  return instances.get(apiName);
}

function listInputDevices() {
  const devices = [];
  for (const apiName of APIS_BY_PLATFORM[process.platform] || []) {
    let rt;
    try {
      rt = rtFor(apiName);
    } catch (e) {
      continue;
    }
    if (rt.isStreamOpen()) {
      // Mid-capture: don't re-probe a driver that's streaming.
      continue;
    }
    const defaultId = rt.getDefaultInputDevice();
    for (const d of rt.getDevices()) {
      if (!d.inputChannels) continue;
      devices.push({
        key: `${apiName}:${d.name}`,
        api: apiName,
        apiLabel: API_LABELS[apiName] || apiName,
        name: d.name,
        channels: d.inputChannels,
        sampleRates: d.sampleRates,
        preferredSampleRate: d.preferredSampleRate,
        isDefault: d.id === defaultId,
      });
    }
  }
  // Big multichannel interfaces first — that's almost always the console.
  return devices.sort((a, b) => b.channels - a.channels || a.apiLabel.localeCompare(b.apiLabel));
}

/**
 * Copies interleaved float32 frames into per-channel buffers. `bytes` may
 * start at any byte offset (Node Buffers from a pool usually aren't 4-byte
 * aligned), so it is copied into an aligned array before being viewed as
 * Float32.
 * @returns {number} frames written
 */
function deinterleaveInto(bytes, channelCount, targets, writePos) {
  const aligned = new Float32Array(Math.floor(bytes.length / 4));
  new Uint8Array(aligned.buffer).set(bytes.subarray(0, aligned.length * 4));
  const capacity = targets[0].length - writePos;
  const frames = Math.min(Math.floor(aligned.length / channelCount), capacity);
  for (let c = 0; c < channelCount; c++) {
    const t = targets[c];
    for (let i = 0, j = c; i < frames; i++, j += channelCount) t[writePos + i] = aligned[j];
  }
  return frames;
}

/**
 * Records a fixed-length take from every channel.
 *
 * @param {object} opts
 * @param {string} opts.deviceKey   from listInputDevices()
 * @param {number} opts.channelCount
 * @param {number} [opts.firstChannel=0]
 * @param {number} [opts.sampleRate] if omitted, the device's preferred rate (falling back to its other rates)
 * @param {number} [opts.durationSec=10]
 * @param {(peaks:number[], progress:number) => void} [opts.onLevels] linear peak per channel since last update
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{sampleRate:number, channels:Float32Array[]}>}
 */
async function record({ deviceKey, channelCount, firstChannel = 0, sampleRate, durationSec = 10, onLevels, signal }) {
  const { RtAudioFormat } = requireAudify();
  const device = listInputDevices().find((d) => d.key === deviceKey);
  if (!device) throw new Error('Audio device not found — is it plugged in? Refresh the device list.');
  if (firstChannel + channelCount > device.channels) {
    throw new Error(`${device.name} only has ${device.channels} inputs.`);
  }
  const rt = rtFor(device.api);
  const deviceId = rt.getDevices().find((d) => d.name === device.name && d.inputChannels).id;

  // Buffers are sized once the stream is open and the real rate is known.
  let rate = 0;
  let totalFrames = 0;
  let channels = [];
  const peaks = new Float32Array(channelCount);
  let written = 0;
  let lastLevelAt = 0;
  let onInput = () => {};
  let onStreamError = () => {};

  const candidates = sampleRate
    ? [sampleRate]
    : [...new Set([device.preferredSampleRate, 48000, 44100, 96000, ...(device.sampleRates || [])].filter(Boolean))];
  let lastError = null;
  let attempt = 0;
  for (const candidate of candidates) {
    // A failed open throws *and* later replays the error through that
    // attempt's callback, so callbacks only count for the current attempt.
    const thisAttempt = ++attempt;
    let openError = null;
    onStreamError = (msg) => { openError = msg; };
    try {
      rt.openStream(
        null,
        { deviceId, nChannels: channelCount, firstChannel },
        RtAudioFormat.RTAUDIO_FLOAT32,
        candidate,
        device.api === 'WINDOWS_ASIO' ? 0 : 512, // ASIO: use the driver's buffer size
        'DIALLD',
        (bytes) => onInput(bytes),
        null,
        0,
        (type, msg) => { if (type > ERROR_TYPE_DEBUG_WARNING && thisAttempt === attempt) onStreamError(msg); }
      );
      if (!openError && rt.isStreamOpen()) {
        rate = candidate;
        break;
      }
      lastError = openError || 'stream did not open';
    } catch (e) {
      lastError = e.message;
    }
    try { if (rt.isStreamOpen()) rt.closeStream(); } catch (e) { /* not open */ }
  }
  if (!rate) throw new Error(`Could not open ${device.name} (tried ${candidates.join(', ')} Hz): ${lastError}`);
  totalFrames = Math.round(durationSec * rate);
  channels = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));

  return new Promise((resolve, reject) => {
    let finished = false;
    let noDataTimer = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(noDataTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Never stop the stream from inside its own callback.
      setImmediate(() => {
        try { if (rt.isStreamRunning()) rt.stop(); } catch (e) { /* already stopped */ }
        try { if (rt.isStreamOpen()) rt.closeStream(); } catch (e) { /* already closed */ }
        if (err) reject(err);
        else resolve({ sampleRate: rate, channels });
      });
    };
    const onAbort = () => finish(new Error('Capture cancelled'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    noDataTimer = setTimeout(() => {
      if (written === 0) finish(new Error(`No audio arrived from ${device.name}. Check the device isn't in use by another app and that the sample rate (${rate} Hz) matches the console.`));
    }, NO_DATA_TIMEOUT_MS);

    onStreamError = (msg) => finish(new Error(`Audio device error: ${msg}`));
    onInput = (bytes) => {
      if (finished) return;
      const before = written;
      written += deinterleaveInto(bytes, channelCount, channels, written);
      for (let c = 0; c < channelCount; c++) {
        const t = channels[c];
        let p = peaks[c];
        for (let i = before; i < written; i++) {
          const a = t[i] < 0 ? -t[i] : t[i];
          if (a > p) p = a;
        }
        peaks[c] = p;
      }
      const now = Date.now();
      if (onLevels && (now - lastLevelAt >= LEVEL_UPDATE_MS || written >= totalFrames)) {
        lastLevelAt = now;
        onLevels(Array.from(peaks), written / totalFrames);
        peaks.fill(0);
      }
      if (written >= totalFrames) finish();
    };

    try {
      rt.start();
    } catch (e) {
      finish(new Error(`Could not start ${device.name}: ${e.message}`));
    }
  });
}

module.exports = { listInputDevices, record, deinterleaveInto };
