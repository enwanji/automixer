const { EventEmitter } = require('events');
const osc = require('osc');

const QUERY_TIMEOUT_MS = 500;
const MESSAGES_PER_BURST = 20;   // X32 drops packets if flooded; pause briefly between bursts
const BURST_PAUSE_MS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin wrapper around an OSC UDP port that can also *query* a console
 * (send an address with no arguments, wait for the console to echo it back
 * with its current value — how the X32 reports parameters).
 * Emits 'log' with { dir: 'out'|'in', address, args }.
 */
class OscClient extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.pending = new Map(); // address -> [resolve]
  }

  get connected() { return !!this.port; }

  open(host, port) {
    this.close();
    return new Promise((resolve, reject) => {
      const p = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: 0, remoteAddress: host, remotePort: port, metadata: true });
      const onError = (err) => { p.removeListener('ready', onReady); reject(err); };
      const onReady = () => {
        p.removeListener('error', onError);
        p.on('error', (err) => this.emit('error', err));
        p.on('message', (msg) => this._onMessage(msg));
        this.port = p;
        resolve();
      };
      p.once('ready', onReady);
      p.once('error', onError);
      p.open();
    });
  }

  close() {
    if (this.port) {
      try { this.port.close(); } catch (e) { /* already closed */ }
      this.port = null;
    }
    for (const resolvers of this.pending.values()) resolvers.forEach((r) => r(null));
    this.pending.clear();
  }

  _onMessage(msg) {
    this.emit('log', { dir: 'in', address: msg.address, args: msg.args });
    const resolvers = this.pending.get(msg.address);
    if (resolvers) {
      this.pending.delete(msg.address);
      resolvers.forEach((r) => r(msg.args));
    }
  }

  send(address, args = []) {
    if (!this.port) throw new Error('Not connected to a console');
    this.port.send({ address, args });
    this.emit('log', { dir: 'out', address, args });
  }

  async sendAll(messages) {
    for (let n = 0; n < messages.length; n++) {
      this.send(messages[n].address, messages[n].args);
      if ((n + 1) % MESSAGES_PER_BURST === 0) await sleep(BURST_PAUSE_MS);
    }
  }

  /** @returns {Promise<Array|null>} reply args, or null on timeout */
  query(address, timeoutMs = QUERY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        const list = this.pending.get(address);
        if (list) {
          const idx = list.indexOf(finish);
          if (idx >= 0) list.splice(idx, 1);
          if (!list.length) this.pending.delete(address);
        }
        finish(null);
      }, timeoutMs);
      if (!this.pending.has(address)) this.pending.set(address, []);
      this.pending.get(address).push(finish);
      try { this.send(address); } catch (e) { finish(null); }
    });
  }
}

module.exports = { OscClient };
