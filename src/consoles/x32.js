/**
 * Behringer X32 / Midas M32 OSC (UDP port 10023).
 *
 * The X32 takes most parameters as a float 0..1 mapped onto the parameter's
 * range (linear or logarithmic), and enumerations as ints. Ranges below are
 * from the X32 OSC protocol documentation (P. Maillot, "Unofficial X32/M32
 * OSC Remote Protocol").
 *
 * Channel names (scribble strips) are read from /ch/NN/config/name.
 */
const { COMP_RATIOS } = require('../presets');

const lin = (v, min, max) => clamp01((v - min) / (max - min));
const log = (v, min, max) => clamp01(Math.log(v / min) / Math.log(max / min));
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

const f = (value) => ({ type: 'f', value });
const i = (value) => ({ type: 'i', value });

const EQ_TYPE_PEQ = 2;
const GATE_MODE_GATE = 3;
const DYN_MODE_COMP = 0;

function nearestIndex(values, v) {
  let best = 0;
  values.forEach((x, idx) => { if (Math.abs(x - v) < Math.abs(values[best] - v)) best = idx; });
  return best;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** @returns {{address:string, args:{type:string,value:number}[]}[]} */
function presetMessages(channel, preset) {
  const ch = `/ch/${pad2(channel)}`;
  const m = (address, ...args) => ({ address, args });
  const msgs = [
    m(`${ch}/preamp/hpon`, i(1)),
    m(`${ch}/preamp/hpf`, f(log(preset.hpf, 20, 400))),
    m(`${ch}/eq/on`, i(1)),
  ];
  for (let b = 0; b < 4; b++) {
    const band = preset.eq[b];
    const p = `${ch}/eq/${b + 1}`;
    if (band) {
      msgs.push(
        m(`${p}/type`, i(EQ_TYPE_PEQ)),
        m(`${p}/f`, f(log(band.f, 20, 20000))),
        m(`${p}/g`, f(lin(band.g, -15, 15))),
        m(`${p}/q`, f(log(band.q, 10, 0.3))) // X32 Q runs 10 (0.0) -> 0.3 (1.0)
      );
    } else {
      msgs.push(m(`${p}/g`, f(lin(0, -15, 15)))); // unused band: flat
    }
  }
  const { gate, comp } = preset;
  msgs.push(
    m(`${ch}/gate/on`, i(gate.on ? 1 : 0)),
    m(`${ch}/gate/mode`, i(GATE_MODE_GATE)),
    m(`${ch}/gate/thr`, f(lin(gate.thr, -80, 0))),
    m(`${ch}/gate/range`, f(lin(gate.range, 3, 60))),
    m(`${ch}/gate/attack`, f(lin(gate.attack, 0, 120))),
    m(`${ch}/gate/hold`, f(log(Math.max(0.02, gate.hold), 0.02, 2000))),
    m(`${ch}/gate/release`, f(log(gate.release, 5, 4000))),
    m(`${ch}/dyn/on`, i(comp.on ? 1 : 0)),
    m(`${ch}/dyn/mode`, i(DYN_MODE_COMP)),
    m(`${ch}/dyn/thr`, f(lin(comp.thr, -60, 0))),
    m(`${ch}/dyn/ratio`, i(nearestIndex(COMP_RATIOS, comp.ratio))),
    m(`${ch}/dyn/attack`, f(lin(comp.attack, 0, 120))),
    m(`${ch}/dyn/release`, f(log(comp.release, 5, 4000))),
    m(`${ch}/dyn/mgain`, f(lin(comp.makeup, 0, 24)))
  );
  return msgs;
}

const channelName = {
  address: (channel) => `/ch/${pad2(channel)}/config/name`,
  /** the name from a query reply, or null if unnamed */
  read: (args) => (args && args.length && typeof args[0].value === 'string' ? args[0].value.trim() || null : null),
};

module.exports = {
  id: 'x32',
  label: 'Behringer X32 / Midas M32',
  defaultPort: 10023,
  maxChannels: 32,
  probe: { address: '/info' }, // replies with firmware/model strings
  // X32-Edit's search: broadcast /xinfo, desks answer [ip, name, model, firmware].
  discovery: {
    port: 10023,
    address: '/xinfo',
    parse: (msg) => {
      if (msg.address !== '/xinfo') return null;
      const [, name, model, firmware] = msg.args.map((a) => a.value);
      return { name: String(name || ''), model: String(model || ''), firmware: String(firmware || '') };
    },
  },
  presetMessages,
  channelName,
  // The X32 answers a query with the same typed value it accepts, so a
  // reply can be sent straight back to restore it (used by Audition).
  readback: true,
  restoreArgs: (args) => args,
  _test: { lin, log, nearestIndex, COMP_RATIOS },
};
