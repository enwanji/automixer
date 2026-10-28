/**
 * Generic OSC: human-readable values (Hz, dB, ms) under /dialld/ch/NN/...,
 * for bridging to other consoles via Bitfocus Companion, Max, TouchOSC etc.
 * Nothing is read back, so there are no channel names and no Audition.
 */
const pad2 = (n) => String(n).padStart(2, '0');
const f = (value) => ({ type: 'f', value });
const i = (value) => ({ type: 'i', value });
const s = (value) => ({ type: 's', value });

function presetMessages(channel, preset, instrumentKey) {
  const p = `/dialld/ch/${pad2(channel)}`;
  const { gate, comp } = preset;
  return [
    { address: `${p}/instrument`, args: [s(instrumentKey)] },
    { address: `${p}/hpf`, args: [f(preset.hpf)] },
    ...preset.eq.map((b, idx) => ({ address: `${p}/eq/${idx + 1}`, args: [f(b.f), f(b.g), f(b.q)] })),
    { address: `${p}/gate`, args: [i(gate.on ? 1 : 0), f(gate.thr), f(gate.range), f(gate.attack), f(gate.hold), f(gate.release)] },
    { address: `${p}/comp`, args: [i(comp.on ? 1 : 0), f(comp.thr), f(comp.ratio), f(comp.attack), f(comp.release), f(comp.makeup)] },
  ];
}

module.exports = {
  id: 'generic',
  label: 'Generic OSC (/dialld/...)',
  defaultPort: 9000,
  maxChannels: 128,
  probe: null,
  presetMessages,
};
