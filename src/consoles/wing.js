/**
 * Behringer WING (OSC on UDP 2223).
 *
 * From the WING OSC documentation (P. Maillot, "OSC Documentation for WING"):
 * - Values are set in real units: `/ch/1/fdr ,f -3.0` is -3 dB.
 * - Sending an address with no arguments reads it. Floats come back as
 *   ,sff (text, 0..1 position, value), ints as ,sfi, enums/strings as ,s.
 * - `/?` returns "WING,<ip>,<name>,<model>,<serial>,<firmware>".
 * - Channels are /ch/1 … /ch/40. The channel's filter, EQ, gate and
 *   dynamics are plugins; the parameters below belong to the default
 *   models (TILT filter, STD EQ, GATE, COMP), so the preset selects those.
 * - The channel name (scribble strip) is /ch/N/name.
 */

const f = (value) => ({ type: 'f', value });
const i = (value) => ({ type: 'i', value });
const s = (value) => ({ type: 's', value });

function presetMessages(channel, preset) {
  const ch = `/ch/${channel}`;
  const m = (address, ...args) => ({ address, args });
  const msgs = [
    m(`${ch}/flt/lc`, i(1)),
    m(`${ch}/flt/lcf`, f(preset.hpf)),
    m(`${ch}/eq/mdl`, s('STD')),
    m(`${ch}/eq/on`, i(1)),
  ];
  for (let b = 0; b < 4; b++) {
    const band = preset.eq[b];
    if (band) {
      msgs.push(m(`${ch}/eq/${b + 1}g`, f(band.g)), m(`${ch}/eq/${b + 1}f`, f(band.f)), m(`${ch}/eq/${b + 1}q`, f(band.q)));
    } else {
      msgs.push(m(`${ch}/eq/${b + 1}g`, f(0))); // unused band: flat
    }
  }
  const { gate, comp } = preset;
  msgs.push(
    m(`${ch}/gate/mdl`, s('GATE')),
    m(`${ch}/gate/on`, i(gate.on ? 1 : 0)),
    m(`${ch}/gate/thr`, f(gate.thr)),
    m(`${ch}/gate/range`, f(gate.range)),
    m(`${ch}/gate/att`, f(gate.attack)),
    m(`${ch}/gate/hld`, f(gate.hold)),
    m(`${ch}/gate/rel`, f(gate.release)),
    m(`${ch}/dyn/mdl`, s('COMP')),
    m(`${ch}/dyn/on`, i(comp.on ? 1 : 0)),
    m(`${ch}/dyn/thr`, f(comp.thr)),
    m(`${ch}/dyn/ratio`, f(comp.ratio)),
    m(`${ch}/dyn/att`, f(comp.attack)),
    m(`${ch}/dyn/rel`, f(comp.release)),
    m(`${ch}/dyn/gain`, f(comp.makeup))
  );
  return msgs;
}

/** The actual value from a WING reply (,sff / ,sfi -> 3rd arg, ,s -> the string). */
function replyValue(args) {
  if (!args || !args.length) return null;
  return args.length >= 3 ? args[2].value : args[0].value;
}

const channelName = {
  address: (channel) => `/ch/${channel}/name`,
  read: (args) => {
    const v = replyValue(args);
    return typeof v === 'string' ? v.trim() || null : null;
  },
};

module.exports = {
  id: 'wing',
  label: 'Behringer WING',
  defaultPort: 2223,
  maxChannels: 40,
  probe: {
    address: '/?',
    // "WING,<ip>,<name>,<model>,<serial>,<firmware>" -> "WING · <name> · <model> · v<firmware>"
    describe: (args) => {
      const [product, , name, model, , firmware] = String(args[0] && args[0].value).split(',');
      return [product, name, model, firmware && `v${firmware}`].filter(Boolean).join(' · ');
    },
  },
  discovery: {
    port: 2223,
    address: '/?',
    parse: (msg) => {
      if (msg.address !== '/?' || !msg.args.length) return null;
      const [product, , name, model, , firmware] = String(msg.args[0].value).split(',');
      if (product !== 'WING') return null;
      return { name: name || '', model: model || 'WING', firmware: firmware || '' };
    },
  },
  presetMessages,
  channelName,
  readback: true,
  restoreArgs: (args) => {
    const v = replyValue(args);
    if (args.length >= 3) return [args[2].type === 'i' ? i(v) : f(v)];
    return [s(String(v))];
  },
  _test: { replyValue },
};
