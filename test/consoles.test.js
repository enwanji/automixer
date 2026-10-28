const test = require('node:test');
const assert = require('node:assert/strict');
const x32 = require('../src/consoles/x32');
const generic = require('../src/consoles/generic');
const { applyChannels, restoreChannels, readChannelNames } = require('../src/consoles/apply');
const wing = require('../src/consoles/wing');
const { PRESETS, normalizePreset } = require('../src/presets');

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const copy = (p) => JSON.parse(JSON.stringify(p));

test('x32 value encodings', () => {
  const { lin, log, nearestIndex, COMP_RATIOS } = x32._test;
  assert.equal(lin(-80, -80, 0), 0);
  assert.equal(lin(-40, -80, 0), 0.5);
  assert.ok(close(log(20, 20, 20000), 0));
  assert.ok(close(log(632.46, 20, 20000), 0.5));
  // Q runs backwards on the X32: 10 -> 0.0, 0.3 -> 1.0
  assert.ok(close(log(10, 10, 0.3), 0));
  assert.ok(close(log(0.3, 10, 0.3), 1));
  assert.equal(COMP_RATIOS[nearestIndex(COMP_RATIOS, 4)], 4);
  assert.equal(COMP_RATIOS[nearestIndex(COMP_RATIOS, 3.4)], 3);
  assert.equal(lin(1000, 0, 1), 1, 'clamped');
});

test('x32 preset messages are typed and in range', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    const msgs = x32.presetMessages(7, preset, key);
    assert.ok(msgs.every((m) => m.address.startsWith('/ch/07/')), key);
    for (const m of msgs) {
      for (const a of m.args) {
        assert.ok(a.type === 'f' || a.type === 'i', `${m.address} has typed args`);
        if (a.type === 'f') assert.ok(a.value >= 0 && a.value <= 1, `${key} ${m.address} = ${a.value}`);
        else assert.ok(Number.isInteger(a.value));
      }
    }
    assert.ok(!msgs.some((m) => /fader|mix\/on|headamp/.test(m.address)), 'never touches faders, mutes or gain');
  }
  const kick = x32.presetMessages(1, PRESETS.kick);
  const byAddr = Object.fromEntries(kick.map((m) => [m.address, m.args[0]]));
  assert.deepEqual(byAddr['/ch/01/gate/on'], { type: 'i', value: 1 });
  assert.deepEqual(byAddr['/ch/01/eq/1/type'], { type: 'i', value: 2 });
  assert.ok(close(20 * Math.pow(20, byAddr['/ch/01/preamp/hpf'].value), 30, 0.01));
  assert.ok(close(byAddr['/ch/01/eq/1/g'].value * 30 - 15, 3.5));
  assert.equal(byAddr['/ch/01/eq/4/g'].value, 0.5, 'unused band set flat');
});

test('normalizePreset clamps values and rejects broken presets', () => {
  const p = copy(PRESETS.vocal);
  p.hpf = 5000;
  p.eq[0].g = -40;
  p.comp.ratio = '4';
  p.gate.on = 1;
  const n = normalizePreset(p);
  assert.equal(n.hpf, 400);
  assert.equal(n.eq[0].g, -15);
  assert.equal(n.comp.ratio, 4);
  assert.equal(n.gate.on, true);
  assert.deepEqual(normalizePreset(PRESETS.kick), PRESETS.kick, 'stock presets are already in range');

  const broken = copy(PRESETS.vocal);
  broken.comp.thr = '';
  assert.throws(() => normalizePreset(broken), /compressor thr must be a number/);
  const tooMany = copy(PRESETS.vocal);
  tooMany.eq.push({ f: 100, g: 0, q: 1 }, { f: 100, g: 0, q: 1 });
  assert.throws(() => normalizePreset(tooMany), /at most 4/);
  assert.throws(() => normalizePreset({}), /incomplete/);
});

function fakeClient() {
  const sent = [];
  return {
    sent,
    async query() { return null; },
    async sendAll(messages) { sent.push(...messages); },
  };
}

test('apply sends an edited preset instead of the stock one', async () => {
  const client = fakeClient();
  const edited = copy(PRESETS.kick);
  edited.hpf = 45;
  edited.eq = [{ f: 70, g: 6, q: 1.2 }];
  edited.gate.on = false;
  const results = await applyChannels({
    client, profile: wing, presets: PRESETS,
    items: [
      { channel: 1, instrumentKey: 'kick', preset: edited },
      { channel: 2, instrumentKey: 'snare' },
    ],
  });
  assert.ok(results.every((r) => r.ok));
  const byAddr = Object.fromEntries(client.sent.map((m) => [m.address, m.args[0].value]));
  assert.equal(byAddr['/ch/1/flt/lcf'], 45);
  assert.equal(byAddr['/ch/1/eq/1f'], 70);
  assert.equal(byAddr['/ch/1/eq/1g'], 6);
  assert.equal(byAddr['/ch/1/eq/2g'], 0, 'removed band set flat');
  assert.equal(byAddr['/ch/1/gate/on'], 0);
  assert.equal(byAddr['/ch/2/flt/lcf'], PRESETS.snare.hpf, 'stock preset when not edited');
});

test('apply refuses a channel with an invalid edited preset but sets the others', async () => {
  const client = fakeClient();
  const bad = copy(PRESETS.bass);
  bad.comp.attack = 'fast';
  const results = await applyChannels({
    client, profile: x32, presets: PRESETS,
    items: [{ channel: 1, instrumentKey: 'bass', preset: bad }, { channel: 2, instrumentKey: 'bass' }, { channel: 3, instrumentKey: 'nope' }],
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /attack must be a number/);
  assert.ok(results[1].ok);
  assert.match(results[2].error, /unknown preset/);
  assert.ok(client.sent.every((m) => m.address.startsWith('/ch/02/')));
});

test('apply dry run builds messages without sending', async () => {
  const [r] = await applyChannels({ client: null, profile: x32, presets: PRESETS, items: [{ channel: 5, instrumentKey: 'bass' }] });
  assert.ok(r.messages.length > 20);
  assert.ok(r.ok);
});

test('generic profile sends readable values and no gain', async () => {
  const client = fakeClient();
  await applyChannels({ client, profile: generic, presets: PRESETS, items: [{ channel: 3, instrumentKey: 'snare' }] });
  const byAddr = Object.fromEntries(client.sent.map((m) => [m.address, m.args]));
  assert.deepEqual(byAddr['/dialld/ch/03/instrument'], [{ type: 's', value: 'snare' }]);
  assert.equal(byAddr['/dialld/ch/03/hpf'][0].value, 80);
  assert.ok(!client.sent.some((m) => /gain_delta/.test(m.address)));
});

/** A desk that answers every query: stored value, or a default by address. */
function fakeDesk(defaults) {
  const values = new Map();
  const sent = [];
  return {
    sent,
    values,
    async query(address) {
      if (values.has(address)) return values.get(address);
      const d = defaults(address);
      return d ? d : null;
    },
    async sendAll(messages) {
      for (const m of messages) { sent.push(m); values.set(m.address, m.args); }
    },
  };
}
const x32Defaults = (a) => {
  if (/\/config\/name$/.test(a)) return [{ type: 's', value: '' }];
  if (/\/(on|type|mode|ratio|hpon)$/.test(a)) return [{ type: 'i', value: 0 }];
  return [{ type: 'f', value: 0.5 }];
};

test('audition snapshot restores every changed value exactly', async () => {
  const desk = fakeDesk(x32Defaults);
  const [r] = await applyChannels({
    client: desk, profile: x32, presets: PRESETS, snapshot: true,
    items: [{ channel: 4, instrumentKey: 'snare' }],
  });
  assert.ok(r.ok);
  assert.equal(r.restore.length, r.messages.length);
  assert.equal(desk.values.get('/ch/04/gate/on')[0].value, 1, 'preset applied');

  await restoreChannels({ client: desk, restores: [{ channel: 4, messages: r.restore }] });
  for (const m of r.messages) {
    assert.deepEqual(desk.values.get(m.address), x32Defaults(m.address), `${m.address} restored`);
  }
});

test('audition refuses a channel it cannot fully read back', async () => {
  const desk = fakeDesk((a) => (a.includes('/dyn/') ? null : x32Defaults(a)));
  const [r] = await applyChannels({
    client: desk, profile: x32, presets: PRESETS, snapshot: true,
    items: [{ channel: 2, instrumentKey: 'vocal' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't read .* wasn't auditioned/);
  assert.equal(desk.sent.length, 0, 'nothing changed on the desk');
});

test('audition is not offered for consoles without read-back', async () => {
  await assert.rejects(
    applyChannels({ client: fakeClient(), profile: generic, presets: PRESETS, snapshot: true, items: [] }),
    /can't be auditioned/
  );
});

test('x32 channel names are read from the scribble strips', async () => {
  const desk = fakeDesk(x32Defaults);
  desk.values.set('/ch/01/config/name', [{ type: 's', value: 'Kick In' }]);
  desk.values.set('/ch/02/config/name', [{ type: 's', value: '  Snare ' }]);
  const names = await readChannelNames({ client: desk, profile: x32, channels: [1, 2, 3, 40] });
  assert.deepEqual(names, { 1: 'Kick In', 2: 'Snare' }, 'unnamed and out-of-range channels left out');
  assert.deepEqual(await readChannelNames({ client: desk, profile: generic, channels: [1] }), {});
});

test('wing preset messages use real units', () => {
  const msgs = wing.presetMessages(12, PRESETS.kick);
  const byAddr = Object.fromEntries(msgs.map((m) => [m.address, m.args[0]]));
  assert.deepEqual(byAddr['/ch/12/flt/lc'], { type: 'i', value: 1 });
  assert.deepEqual(byAddr['/ch/12/flt/lcf'], { type: 'f', value: 30 });
  assert.deepEqual(byAddr['/ch/12/eq/1f'], { type: 'f', value: 60 });
  assert.deepEqual(byAddr['/ch/12/eq/1g'], { type: 'f', value: 3.5 });
  assert.deepEqual(byAddr['/ch/12/eq/4g'], { type: 'f', value: 0 });
  assert.deepEqual(byAddr['/ch/12/gate/thr'], { type: 'f', value: -32 });
  assert.deepEqual(byAddr['/ch/12/dyn/ratio'], { type: 'f', value: 4 });
  assert.deepEqual(byAddr['/ch/12/dyn/gain'], { type: 'f', value: 3 });
  assert.deepEqual(byAddr['/ch/12/eq/mdl'], { type: 's', value: 'STD' });
  assert.ok(!msgs.some((m) => /fdr|mute|\/io\//.test(m.address)), 'never touches faders, mutes or gain');
});

test('wing audition restores ,sff replies with the right types', async () => {
  const sff = (v) => [{ type: 's', value: String(v) }, { type: 'f', value: 0.5 }, { type: 'f', value: v }];
  const desk = fakeDesk((a) => {
    if (a.endsWith('/mdl')) return [{ type: 's', value: 'STD' }];
    if (/\/(on|lc)$/.test(a)) return [{ type: 's', value: '0' }, { type: 'f', value: 0 }, { type: 'i', value: 0 }];
    return sff(0);
  });
  const [r] = await applyChannels({
    client: desk, profile: wing, presets: PRESETS, snapshot: true,
    items: [{ channel: 3, instrumentKey: 'bass' }],
  });
  assert.ok(r.ok, r.error);
  const byAddr = Object.fromEntries(r.restore.map((m) => [m.address, m.args[0]]));
  assert.deepEqual(byAddr['/ch/3/dyn/thr'], { type: 'f', value: 0 });
  assert.deepEqual(byAddr['/ch/3/gate/on'], { type: 'i', value: 0 });
  assert.deepEqual(byAddr['/ch/3/eq/mdl'], { type: 's', value: 'STD' });
});

test('wing channel names', async () => {
  const desk = fakeDesk((a) => (a === '/ch/5/name' ? [{ type: 's', value: 'Lead Vox' }] : a.endsWith('/name') ? [{ type: 's', value: '' }] : null));
  assert.deepEqual(await readChannelNames({ client: desk, profile: wing, channels: [4, 5] }), { 5: 'Lead Vox' });
});

test('wing discovery reply parsing', () => {
  const parsed = wing.discovery.parse({ address: '/?', args: [{ type: 's', value: 'WING,192.168.1.71,FOH,ngc-full,S123,3.0.6' }] });
  assert.deepEqual(parsed, { name: 'FOH', model: 'ngc-full', firmware: '3.0.6' });
  assert.equal(wing.discovery.parse({ address: '/?', args: [{ type: 's', value: 'X32,1.2.3.4' }] }), null);
});
