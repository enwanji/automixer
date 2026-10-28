/**
 * Builds and sends everything needed to set up a list of channels.
 * Faders, mutes and input gain are never touched — this only sets HPF, EQ,
 * gate and compressor, so it's safe to run on a desk that's live.
 *
 * With `snapshot: true` (Audition), every value about to be changed is read
 * from the console first and returned as `restore` messages, so the change
 * can be undone exactly. A channel whose current settings can't all be read
 * is left untouched rather than auditioned without a way back.
 */
const { normalizePreset } = require('../presets');

const QUERY_CONCURRENCY = 24; // keep UDP bursts small enough that the desk doesn't drop queries

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      results[n] = await fn(items[n], n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Reads many addresses, retrying misses once. @returns {Map<string, Array|null>} */
async function readAll(client, addresses) {
  const values = new Map();
  let pending = [...new Set(addresses)];
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const replies = await mapLimit(pending, QUERY_CONCURRENCY, (a) => client.query(a));
    pending.forEach((a, n) => { if (replies[n]) values.set(a, replies[n]); });
    pending = pending.filter((a) => !values.has(a));
  }
  pending.forEach((a) => values.set(a, null));
  return values;
}

/**
 * @param {object} p
 * @param {import('./osc-client').OscClient|null} p.client  null = dry run (just build messages)
 * @param {object} p.profile   from consoles/index.js
 * @param {object} p.presets   PRESETS
 * @param {{channel:number, instrumentKey:string|null, preset?:object}[]} p.items
 *   `preset` is the channel's edited copy; without it the stock preset for `instrumentKey` is used
 * @param {boolean} [p.snapshot] read current values first and return `restore` messages
 */
async function applyChannels({ client, profile, presets, items, snapshot = false }) {
  if (snapshot && !(client && profile.readback)) throw new Error(`${profile.label} can't report its settings, so changes can't be auditioned`);

  const results = items.map((it) => {
    const result = { channel: it.channel, ok: true, warnings: [], messages: [] };
    try {
      if (it.preset) {
        result.messages = profile.presetMessages(it.channel, normalizePreset(it.preset), it.instrumentKey);
      } else if (it.instrumentKey) {
        const preset = presets[it.instrumentKey];
        if (!preset) throw new Error(`unknown preset "${it.instrumentKey}"`);
        result.messages = profile.presetMessages(it.channel, preset, it.instrumentKey);
      }
    } catch (e) {
      result.ok = false;
      result.error = e.message;
    }
    return result;
  });

  if (snapshot) {
    const current = await readAll(client, results.flatMap((r) => r.messages.map((m) => m.address)));
    for (const r of results) {
      if (!r.ok) continue;
      const restore = [];
      const missing = [];
      for (const m of r.messages) {
        const args = current.get(m.address);
        if (args) restore.push({ address: m.address, args: profile.restoreArgs(args) });
        else missing.push(m.address);
      }
      if (missing.length) {
        r.ok = false;
        r.error = `couldn't read ${missing.length} current setting${missing.length === 1 ? '' : 's'} (e.g. ${missing[0]}), so it wasn't auditioned`;
        r.messages = [];
      } else {
        r.restore = restore;
      }
    }
  }

  if (client) {
    for (const r of results) {
      if (!r.ok || !r.messages.length) continue;
      try {
        await client.sendAll(r.messages);
      } catch (e) {
        r.ok = false;
        r.error = e.message;
      }
    }
  }
  return results;
}

/** Sends the `restore` messages captured by an audition. */
async function restoreChannels({ client, restores }) {
  const results = [];
  for (const { channel, messages } of restores) {
    try {
      await client.sendAll(messages);
      results.push({ channel, ok: true });
    } catch (e) {
      results.push({ channel, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Reads the channel names (scribble strips) from the console.
 * @returns {Promise<Object<number, string>>} channel -> name, only for channels that answered with a name
 */
async function readChannelNames({ client, profile, channels }) {
  if (!profile.channelName) return {};
  const wanted = channels.filter((ch) => ch >= 1 && ch <= profile.maxChannels);
  const replies = await readAll(client, wanted.map((ch) => profile.channelName.address(ch)));
  const names = {};
  for (const ch of wanted) {
    const name = profile.channelName.read(replies.get(profile.channelName.address(ch)));
    if (name) names[ch] = name;
  }
  return names;
}

module.exports = { applyChannels, restoreChannels, readChannelNames, mapLimit };
