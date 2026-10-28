/**
 * Minimal WAV reader (PCM 16/24/32-bit int and 32/64-bit float, incl.
 * WAVE_FORMAT_EXTENSIBLE). Used by "Test with audio files" so the whole
 * pipeline can be tried with multitrack stems instead of a live console.
 */
const fs = require('fs');

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath}: not a WAV file`);
  }

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24); // extensible: sub-format GUID
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || dataOffset < 0) throw new Error(`${filePath}: missing fmt or data chunk`);

  const { format, channels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frameCount));

  let read;
  if (format === 1 && bitsPerSample === 16) read = (o) => buf.readInt16LE(o) / 32768;
  else if (format === 1 && bitsPerSample === 24) read = (o) => buf.readIntLE(o, 3) / 8388608;
  else if (format === 1 && bitsPerSample === 32) read = (o) => buf.readInt32LE(o) / 2147483648;
  else if (format === 3 && bitsPerSample === 32) read = (o) => buf.readFloatLE(o);
  else if (format === 3 && bitsPerSample === 64) read = (o) => buf.readDoubleLE(o);
  else throw new Error(`${filePath}: unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit)`);

  let o = dataOffset;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = read(o);
      o += bytesPerSample;
    }
  }
  return { sampleRate, channels: out };
}

/** Mixes a multichannel file down to mono (stems are often stereo). */
function readWavMono(filePath, maxSeconds = Infinity) {
  const { sampleRate, channels } = readWav(filePath);
  const len = Math.min(channels[0].length, Math.floor(maxSeconds * sampleRate));
  const mono = new Float32Array(len);
  for (const ch of channels) {
    for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
  }
  return { sampleRate, pcm: mono };
}

module.exports = { readWav, readWavMono };
