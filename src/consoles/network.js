/**
 * Finding the console on the network, and explaining why it can't be found.
 *
 * A console plugged straight into the laptop has no router, so nothing on
 * the cable hands out addresses (DHCP). Consoles default to a fixed
 * 192.168.x.x address; the laptop's port must be set to a fixed address in
 * the same range, or it falls back to 169.254.x.x and can't reach the desk.
 */
const os = require('os');
const dgram = require('dgram');
const osc = require('osc');

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | (parseInt(part, 10) & 255)) >>> 0, 0);
}
function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => +p <= 255);

/** This computer's IPv4 interfaces (excluding loopback). */
function localInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        network: intToIp(ip & mask),
        broadcast: intToIp((ip & mask) | (~mask >>> 0)),
        linkLocal: a.address.startsWith('169.254.'),
      });
    }
  }
  return out;
}

function sameSubnet(iface, host) {
  const mask = ipToInt(iface.netmask);
  return (ipToInt(iface.address) & mask) === (ipToInt(host) & mask);
}

/**
 * Broadcasts a discovery query on every network port (one socket per port,
 * because Windows only sends 255.255.255.255 out of one interface) and
 * collects the consoles that answer.
 * @param {{port:number, address:string, parse:(msg)=>object|null}} probe
 * @returns {Promise<{host:string, port:number, name:string, model:string, firmware:string, via:string}[]>}
 */
async function discover(probe, { timeoutMs = 1200, interfaces = localInterfaces() } = {}) {
  const found = new Map();
  const packet = Buffer.from(osc.writePacket({ address: probe.address, args: [] }));
  const sockets = [];

  await Promise.all(interfaces.map((iface) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sockets.push(s);
    s.on('error', () => resolve());
    s.on('message', (buf, rinfo) => {
      let msg;
      try { msg = osc.readPacket(buf, { metadata: true }); } catch (e) { return; }
      const info = probe.parse(msg);
      if (info && !found.has(rinfo.address)) found.set(rinfo.address, { host: rinfo.address, port: probe.port, via: iface.name, ...info });
    });
    s.bind({ address: iface.address, port: 0 }, () => {
      try {
        s.setBroadcast(true);
        s.send(packet, probe.port, iface.broadcast);
        s.send(packet, probe.port, '255.255.255.255');
      } catch (e) { /* interface went away */ }
      resolve();
    });
  })));

  await new Promise((r) => setTimeout(r, timeoutMs));
  sockets.forEach((s) => { try { s.close(); } catch (e) { /* already closed */ } });
  return [...found.values()];
}

/**
 * Explains, in plain language, why `host` might not be reachable.
 * @returns {string|null} null if nothing obviously wrong
 */
function diagnose(host, interfaces = localInterfaces()) {
  if (!isIPv4(host)) return `"${host}" isn't an IP address — it should look like 192.168.0.64.`;
  const describe = (i) => `${i.name} ${i.address}`;
  const own = interfaces.find((i) => i.address === host);
  if (own) {
    return `${host} is this computer's own address (${own.name}), not the console's. `
      + 'The console shows its IP under Setup → Network (or use Find).';
  }
  const usable = interfaces.filter((i) => !i.linkLocal);
  const linkLocal = interfaces.filter((i) => i.linkLocal && /ethernet|eth|en\d/i.test(i.name));
  if (usable.some((i) => sameSubnet(i, host))) return null;

  const suggestion = intToIp(((ipToInt(host) & ipToInt('255.255.255.0')) | 200) >>> 0);
  let msg = `This computer isn't on the same network as ${host}. `;
  if (linkLocal.length) {
    msg += `${linkLocal.map((i) => i.name).join(', ')} has no address (169.254.x.x) — nothing on the cable handed one out (no DHCP). `;
  } else if (usable.length) {
    msg += `It is on ${usable.map(describe).join(' and ')}. `;
  }
  msg += `For a cable straight to the console, give this computer's Ethernet port a fixed IP in the console's range, e.g. ${suggestion} with subnet mask 255.255.255.0 `
    + '(Windows: Settings → Network → Ethernet → IP assignment → Edit → Manual).';
  return msg;
}

module.exports = { localInterfaces, discover, diagnose, sameSubnet, _test: { ipToInt, intToIp, isIPv4 } };
