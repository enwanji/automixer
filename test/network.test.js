const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const osc = require('osc');
const { diagnose, discover, sameSubnet } = require('../src/consoles/network');
const x32 = require('../src/consoles/x32');

const ethernet = { name: 'Ethernet', address: '192.168.0.111', netmask: '255.255.255.0', broadcast: '192.168.0.255', linkLocal: false };
const wifi = { name: 'Wi-Fi', address: '192.168.178.122', netmask: '255.255.255.0', broadcast: '192.168.178.255', linkLocal: false };
const noDhcp = { name: 'Ethernet', address: '169.254.12.34', netmask: '255.255.0.0', broadcast: '169.254.255.255', linkLocal: true };

test('subnet check', () => {
  assert.ok(sameSubnet(ethernet, '192.168.0.110'));
  assert.ok(!sameSubnet(ethernet, '192.168.1.10'));
});

test('diagnose: console on the same network is fine', () => {
  assert.equal(diagnose('192.168.0.110', [ethernet, wifi]), null);
});

test("diagnose: typing this computer's own address", () => {
  assert.match(diagnose('192.168.0.111', [ethernet, wifi]), /this computer's own address \(Ethernet\)/);
});

test('diagnose: console on a different 192.168 network', () => {
  const msg = diagnose('192.168.1.64', [ethernet, wifi]);
  assert.match(msg, /isn't on the same network/);
  assert.match(msg, /Ethernet 192\.168\.0\.111 and Wi-Fi 192\.168\.178\.122/);
  assert.match(msg, /192\.168\.1\.200 with subnet mask 255\.255\.255\.0/);
});

test('diagnose: direct cable with no DHCP (169.254)', () => {
  const msg = diagnose('192.168.0.64', [noDhcp, wifi]);
  assert.match(msg, /169\.254/);
  assert.match(msg, /no DHCP/);
  assert.match(msg, /192\.168\.0\.200/);
});

test('diagnose: not an IP', () => {
  assert.match(diagnose('x32.local', [ethernet]), /isn't an IP address/);
});

test('discover finds an X32 answering /xinfo', async () => {
  const server = dgram.createSocket('udp4');
  await new Promise((r) => server.bind({ address: '127.0.0.1', port: 0 }, r));
  server.on('message', (buf, rinfo) => {
    const msg = osc.readPacket(buf, { metadata: true });
    if (msg.address !== '/xinfo') return;
    const reply = osc.writePacket({ address: '/xinfo', args: ['127.0.0.1', 'FOH-X32', 'X32', '4.13'].map((value) => ({ type: 's', value })) });
    server.send(Buffer.from(reply), rinfo.port, rinfo.address);
  });
  const loopback = { name: 'loopback', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.0.0.1', linkLocal: false };
  const found = await discover({ ...x32.discovery, port: server.address().port }, { timeoutMs: 300, interfaces: [loopback] });
  server.close();
  assert.equal(found.length, 1);
  assert.deepEqual(
    { host: found[0].host, name: found[0].name, model: found[0].model, firmware: found[0].firmware, via: found[0].via },
    { host: '127.0.0.1', name: 'FOH-X32', model: 'X32', firmware: '4.13', via: 'loopback' }
  );
});
