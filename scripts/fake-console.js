#!/usr/bin/env node
/**
 * A stand-in console on the network, for trying DIALLD without a desk.
 * Answers discovery and parameter queries like the real thing, stores every
 * value it's sent, and prints what changed.
 *
 *   node scripts/fake-console.js            X32/M32 on UDP 10023
 *   node scripts/fake-console.js --wing     WING on UDP 2223
 *   then press Find in DIALLD (or connect to 127.0.0.1)
 */
const osc = require('osc');

const wing = process.argv.includes('--wing');
const portArg = process.argv.find((a) => /^\d+$/.test(a));
const port = parseInt(portArg, 10) || (wing ? 2223 : 10023);
const values = new Map();
const f = (value) => ({ type: 'f', value });
const i = (value) => ({ type: 'i', value });
const s = (value) => ({ type: 's', value });

// Scribble-strip names for the first few channels; the rest are unnamed, like a fresh desk.
const NAMES = ['Kick In', 'Snare Top', 'Hi-Hat', 'Tom 1', 'OH L', 'OH R', 'Bass DI', 'Gtr Amp', 'Keys', 'Lead Vox'];

// What an untouched desk reports for a parameter nobody has set yet.
function defaultValue(address) {
  const name = address.match(wing ? /^\/ch\/(\d+)\/name$/ : /^\/ch\/(\d\d)\/config\/name$/);
  if (name) return s(NAMES[parseInt(name[1], 10) - 1] || '');
  if (wing) {
    if (/\/eq\/mdl$/.test(address)) return s('STD');
    if (/\/gate\/mdl$/.test(address)) return s('GATE');
    if (/\/dyn\/mdl$/.test(address)) return s('COMP');
    if (/\/(on|lc)$/.test(address)) return i(0);
    if (/^\/ch\/\d+\//.test(address)) return f(0);
    return null;
  }
  if (/^\/ch\/\d\d\/.*\/(on|type|mode|ratio|hpon)$/.test(address)) return i(0);
  if (/^\/ch\/\d\d\//.test(address)) return f(0.5);
  return null;
}

function replyArgs(arg) {
  if (!wing) return [arg];
  if (arg.type === 's') return [arg];
  return [s(String(arg.value)), f(0.5), arg.type === 'i' ? i(arg.value) : f(arg.value)];
}

const udp = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: port, metadata: true });
let changed = [];
let summaryTimer = null;

udp.on('message', (msg, _timeTag, info) => {
  const reply = (args) => udp.send({ address: msg.address, args }, info.address, info.port);
  if (wing && msg.address === '/?') {
    reply([s('WING,127.0.0.1,fake-wing,wing-rack,NO_SERIAL,3.0.6')]);
    return;
  }
  if (!wing && msg.address === '/xinfo') {
    reply([s('127.0.0.1'), s('fake-x32'), s('X32'), s('4.06')]);
    return;
  }
  if (!wing && msg.address === '/info') {
    reply([s('V2.07'), s('fake-x32'), s('X32'), s('4.06')]);
    return;
  }
  if (!msg.args.length) {
    const v = values.has(msg.address) ? values.get(msg.address) : defaultValue(msg.address);
    if (v) reply(replyArgs(v));
    return;
  }
  values.set(msg.address, msg.args[0]);
  changed.push(`${msg.address} = ${msg.args[0].value}`);
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    const channels = new Set(changed.map((c) => c.split('/')[2]));
    console.log(`${changed.length} EQ/filter/gate/comp values set on ${channels.size} channel${channels.size === 1 ? '' : 's'}`);
    changed = [];
  }, 300);
});

udp.on('ready', () => console.log(`fake ${wing ? 'WING' : 'X32'} listening on UDP ${port}`));
udp.open();
