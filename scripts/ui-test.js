/**
 * Drives the real UI end to end and saves screenshots:
 *   node scripts/fake-console.js [--wing]   (in another terminal)
 *   electron . --ui-test=<folder of WAV stems> --ui-shots=<output folder> [--ui-profile=wing]
 */
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ win, folder, outDir, setTestFiles, quit, connectOnly, profile = 'x32' }) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
  };
  const waitFor = async (code, timeoutMs = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js(code)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${code}`);
  };

  win.webContents.on('console-message', (e, level, message) => {
    console.log(`[renderer] ${e.message || message}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log(`[preload error] ${err}`));

  fs.mkdirSync(outDir, { recursive: true });
  setTestFiles(fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.wav')).map((f) => path.join(folder, f)));

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await waitFor(`document.getElementById('device').options.length > 0 && !document.getElementById('device').options[0].textContent.startsWith('Scanning')`);

  if (connectOnly) {
    // Read-only check against a real console: connect (queries /info) and stop. Never applies anything.
    await sleep(500);
    await waitFor(`document.getElementById('connDot').className !== 'dot warn'`, 15000); // startup search done
    const startup = await js(`document.getElementById('connLabel').textContent`);
    console.log('after startup search:', startup);
    if (await js(`state.connected`)) {
      await js(`document.getElementById('connectBtn').click()`);
      await waitFor(`!state.connected`);
    }
    await js(`document.getElementById('host').value = ${JSON.stringify(connectOnly)}; document.getElementById('connectBtn').click();`);
    await sleep(200);
    await waitFor(`document.getElementById('connectBtn').textContent === 'Disconnect' || document.getElementById('connDot').className === 'dot off'`, 15000);
    await sleep(300);
    await shot('connect.png');
    console.log(JSON.stringify(await js(`({ host: document.getElementById('host').value, status: document.getElementById('connLabel').textContent, banner: document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent })`), null, 1));
    await js(`document.getElementById('connectBtn').click()`);
    return quit(0);
  }
  const port = profile === 'wing' ? 2223 : 10023;
  await sleep(1500); // let the start-up console search finish
  await js(`if (state.connected) document.getElementById('connectBtn').click()`);
  await waitFor(`!state.connected`);
  await js(`const p = document.getElementById('profile'); p.value = '${profile}'; p.dispatchEvent(new Event('change'));
    document.getElementById('host').value = '127.0.0.1'; document.getElementById('port').value = '${port}'; document.getElementById('connectBtn').click();`);
  await waitFor(`document.getElementById('connectBtn').textContent === 'Disconnect'`);
  // This test writes to the console: never let it run against anything but the local fake.
  const host = await js(`document.getElementById('host').value`);
  if (host !== '127.0.0.1') {
    await js(`document.getElementById('connectBtn').click()`);
    throw new Error(`Connected to ${host} instead of the local fake console — aborting before anything is sent.`);
  }
  await sleep(300);
  await shot('1-start.png');

  const t0 = Date.now();
  await js(`document.getElementById('filesBtn').click()`);
  await waitFor(`!document.getElementById('resultsPanel').hidden && document.getElementById('progressPanel').hidden`);
  const analyzeMs = Date.now() - t0;
  await sleep(300);
  await shot('2-results.png');
  console.log('after analysis:', await js(`JSON.stringify({ rows: document.querySelectorAll('#rows tr').length, channels: state.channels.length, busy: state.busy, apply: document.getElementById('applyBtn').textContent, applyDisabled: document.getElementById('applyBtn').disabled, progressHidden: document.getElementById('progressPanel').hidden })`));

  const statuses = () => js(`[...document.querySelectorAll('#rows tr[data-index]')].map(r => r.querySelector('.ch-num').textContent + ' ' + ((r.querySelector('.status > div') || {}).textContent || ''))`);
  await js(`document.getElementById('auditionBtn').click()`);
  await waitFor(`state.auditioning && !state.busy`);
  await sleep(300);
  await shot('3-audition.png');
  const auditioning = await statuses();
  const auditionLabel = await js(`document.getElementById('auditionBtn').textContent + ' | ' + document.getElementById('applyBtn').textContent`);
  // Change one auditioned channel's instrument: should re-apply live.
  await js(`(() => { const sel = document.querySelector('#rows tr select'); sel.value = 'tom'; sel.dispatchEvent(new Event('change')); })()`);
  await waitFor(`!state.busy`);
  // Edit the first channel's preset while auditioning: the change should be sent once typing pauses.
  await js(`document.querySelector('#rows tr[data-index="0"] .preset .btn').click()`);
  await waitFor(`document.querySelector('#rows tr.editor-row')`);
  await js(`(() => {
    const input = document.querySelector('#rows tr.editor-row .pe-eq .pe-field input');
    input.value = '150'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`state.channels[0].edited && state.channels[0].status && state.channels[0].status.text.includes('edited') && !state.busy`, 5000);
  await sleep(300);
  await shot('3b-editor.png');
  const edited = await js(`({ hpf: state.channels[0].preset.hpf, status: state.channels[0].status.text, sentToDesk: [...document.querySelectorAll('#logBody .log-row')].filter(r => r.querySelector('.dir').textContent === '→' && /^\\/ch\\/0?1\\/(preamp\\/hpf|flt\\/lcf)$/.test(r.querySelector('.addr').textContent)).map(r => r.querySelector('.args').textContent) })`);
  console.log('edited preset:', JSON.stringify(edited));
  await js(`document.getElementById('auditionBtn').click()`);
  await waitFor(`!state.auditioning && !state.busy`);
  await sleep(300);
  const restored = await statuses();
  console.log(JSON.stringify({ auditionLabel, auditioning: auditioning.slice(0, 4), restored: restored.slice(0, 4) }, null, 1));

  await js(`document.getElementById('applyBtn').click()`);
  await waitFor(`[...document.querySelectorAll('#rows tr[data-index]')].filter(r => r.querySelector('input').checked).every(r => r.querySelector('.status > div'))`);
  await sleep(300);
  await shot('4-applied.png');

  const rows = await js(`[...document.querySelectorAll('#rows tr[data-index]')].map(r => [r.querySelector('.ch-num').textContent, (r.querySelector('.ch-name') || {}).textContent || '(no name)', r.querySelector('select').selectedOptions[0].textContent.trim(), (r.querySelector('.status') || {}).innerText || ''].join(' | '))`);
  const banner = await js(`document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent`);
  console.log(JSON.stringify({ analyzeMs, banner, rows }, null, 1));
  quit(0);
}

module.exports = { run };
