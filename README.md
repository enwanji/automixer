# DIALLD Desktop

Capture 10 seconds of every channel from your console, get an instrument +
EQ/dynamics preset recommendation for each one, adjust it if you like, and
apply it to the desk in one click.

```
console ──USB / Dante / SoundGrid──▶ DIALLD ──OSC/UDP──▶ console
           (ASIO / WASAPI / Core Audio)   capture 10 s
                                          → level per channel, names read from the desk
                                          → instrument (YAMNet, on-device)
                                          → review / edit presets, Apply
```

## Quick start

Requires Node.js 20+ (LTS recommended).

```
npm install
npm start
```

1. **Console** (top right): pick the console type. For an X32/M32, DIALLD
   searches the network on start-up and connects by itself; press **Find**
   to search again, or type the IP and press **Connect**. If the IP doesn't
   answer, DIALLD looks for the console, switches to it if it finds one, and
   otherwise explains what's wrong (wrong IP, this computer's own IP, or
   not on the same network).
2. **Input device**: pick the console's USB/Dante/SoundGrid interface. Set
   how many channels to listen to, which input to start from, and which
   console channel that input feeds (defaults: 1 → 1).
3. Have the band play and press **Capture 10 s** (or the **Space** bar).
   Meters show every channel as it records; results fill in as each
   channel is identified (typically under a second for 32 channels).
4. Check the suggestions. Click a chip or use the dropdown to change an
   instrument; untick channels you don't want touched. Each row shows the
   channel's name from the console's scribble strip (X32/M32, WING).
5. Press **Edit** (or click the EQ curve) to adjust a channel's high-pass,
   EQ bands, gate and compressor (see [Editing presets](#editing-presets)).
6. Press **Audition** (or **A**) to hear the presets on the desk. Change an
   instrument or edit a preset while auditioning and the desk follows live.
   Press **Undo audition** to put every touched parameter back exactly as it
   was, or **Keep audition** to keep it.
7. Or go straight to **Apply** (or **Ctrl+Enter**). **Preview OSC** shows
   exactly what would be sent without sending it.

**Apply sets high-pass, EQ, gate and compressor only. It never changes input
gain, never moves faders and never mutes or unmutes anything.**

All settings are remembered between sessions.

## Editing presets

**Edit** opens the channel's preset under its row:

- **Filter & EQ**: high-pass frequency and up to 4 bell bands (frequency,
  gain, Q). Add or remove bands; a removed band is set flat on the desk.
- **Gate**: on/off, threshold, range, attack, hold, release.
- **Compressor**: on/off, threshold, ratio, attack, release, makeup.

Values are kept to the range the X32 accepts (e.g. EQ ±15 dB, HPF 20–400 Hz).
An edit applies to that channel only and is marked **edited**. Changing the
channel's instrument starts it again from that instrument's preset.

- **Reset** goes back to the instrument's preset.
- **Save as my … preset** makes the edit the starting point for every channel
  of that instrument, now and in future sessions. Other channels of that
  instrument that you haven't edited pick it up straight away.
- **Restore stock preset** forgets your saved version.

## Channel names

When the console answers (X32/M32 `/ch/NN/config/name`, WING `/ch/N/name`),
DIALLD reads the names of the captured channels while the band is playing, and
again after analysis. Press **↻ Channel names** after renaming channels on the
desk. Names are only read and displayed. DIALLD never writes them, and they
don't affect the instrument suggestion.

### No console handy?

- **Test with audio files…** analyzes WAV stems (one file per channel)
  instead of a live capture.
- `node scripts/fake-console.js` runs a pretend X32 on this computer
  (`--wing` for a WING). Connect DIALLD to `127.0.0.1` and it prints what was set.

## Connecting to the console

- **Through a router or switch** with DHCP: set the console's network to DHCP (or
  a fixed address in the router's range) and press **Find**.
- **Cable straight from the computer to the console**: there's no router, so
  nothing hands out addresses (no DHCP). The console keeps its fixed IP (shown
  under *Setup → Network* on the X32/M32), and the computer's Ethernet port
  needs a fixed IP in the same range. If the console is 192.168.0.64, for
  example, use 192.168.0.200 with subnet mask 255.255.255.0 (Windows:
  *Settings → Network & internet → Ethernet → IP assignment → Edit → Manual*).
  Without this the port gets a 169.254.x.x address and can't reach the desk.
- Don't enter the computer's own IP; DIALLD will tell you if you do.

## Audio input

| Platform | What to pick |
|---|---|
| Windows + X32/M32 X-USB, DN32, most console USB cards | the **[ASIO]** driver — WASAPI only shows those cards as stereo pairs |
| Windows + Dante Virtual Soundcard / Waves SoundGrid | their ASIO driver, or WASAPI |
| macOS | the Core Audio device — USB, Dante VSC and SoundGrid all appear there |

The sample rate follows the device; if a driver refuses its preferred rate,
DIALLD tries the device's other rates automatically.

**Where to tap the signal:** the capture should be *post-gain, pre-fader*,
which is what console USB cards send by default (e.g. X32 card outputs fed
from the local inputs). The level column shows each channel's peak and
average level over the take (and flags clipping) so you can set gain on the
desk yourself; DIALLD doesn't change it. The preset gate and compressor
thresholds assume peaks around −12 dBFS.

## Instrument recognition

DIALLD runs Google's YAMNet audio model on-device (ONNX Runtime, CPU). YAMNet
already recognises the 521 AudioSet sound classes ("Bass drum", "Snare drum",
"Electric guitar", "Singing", "Trumpet", …), which `src/classifier/audioset-map.js`
maps onto the 13 presets (kick, snare, tom, hi-hat, overheads, bass, electric
and acoustic guitar, vocal, speech/MC, keys, pad/strings, horns). This works
out of the box with no training.

Each suggestion shows a confidence and up to three alternatives. Hover over the
alternatives to see what the model actually heard.

**For better accuracy on your rig**, train a small custom head on your own
recordings (a virtual soundcheck multitrack is ideal). The app picks it up
automatically. See [training/README.md](training/README.md).

## Presets and console profiles

- Stock presets (HPF, up to 4 EQ bands, gate, compressor per instrument)
  and the allowed range of each value are in [src/presets.js](src/presets.js).
  Gates are only enabled on kick, snare and toms. Your saved versions live
  in the app's local storage and don't change this file.
- Console profiles are in [src/consoles/](src/consoles/):
  - **Behringer X32 / Midas M32**: normalized OSC values per the X32 OSC
    protocol. Channel names and Audition supported.
  - **Behringer WING** (UDP 2223): real-unit OSC per the WING OSC
    documentation. Sets the default plugin models (low cut, STD EQ, GATE,
    COMP) and their parameters. Channel names and Audition supported. Built
    from the documentation, not yet tried on a real WING.
  - **Generic OSC**: plain units (Hz, dB, ms) under `/dialld/ch/NN/...`,
    for bridging to other desks via Bitfocus Companion, TouchOSC, Max etc.
  - To add a console, copy `generic.js`, implement `presetMessages()` (and
    `channelName` if the desk can report names), and register it in `index.js`.

## Development

```
npm test            # unit tests (DSP, levels, console encoding, presets, apply logic, model)
npm run smoke       # loads native modules + model inside Electron, lists devices
node scripts/analyze-files.js <folder of WAVs>   # headless recognition report
npm run dist        # installer via electron-builder (.exe / .dmg / .AppImage)
```

The YAMNet model (`models/yamnet.onnx`, `models/yamnet_class_map.csv`) is
included. To regenerate it, see `training/README.md`.

Note for VS Code users: VS Code sets `ELECTRON_RUN_AS_NODE=1` for some
child processes. If `npm start` prints a Node version instead of opening a
window, unset that variable first.

### Layout

```
main.js, preload.js          Electron main process + IPC bridge
renderer/                    UI
src/audio/                   capture (audify/RtAudio), resampler, levels, WAV reader
src/classifier/              YAMNet runner, AudioSet → instrument mapping, optional trained head
src/consoles/                OSC client, apply logic, console profiles
src/presets.js               processing presets
models/                      YAMNet ONNX model + class map (+ your classifier-head.json)
training/                    model conversion and custom-head training (Python 3.11)
scripts/                     fake X32, headless analysis, UI test driver
test/                        node:test unit tests
```

## Audition

Before auditioning, DIALLD reads every parameter it's about to change from
the console, then applies the presets. Undo writes those exact values back.
If any value on a channel can't be read, that channel is left untouched
rather than changed without a way back. It needs a console that reports
its settings over OSC (X32/M32, WING); for Generic OSC the button is disabled.

## Known limitations

- Zero-shot recognition is weakest at telling drums apart from each other
  (tom vs. snare vs. kick) and on very dry, synthetic or unusual sources.
  A trained head fixes most of this.
- Stereo sources are treated as two mono channels.
- **Yamaha DM3/DM7**: Yamaha's published OSC spec only covers faders, sends,
  labels, head-amp gain and scenes. It has no EQ, HPF or dynamics, and no
  read-back. CL/QL/TF don't speak OSC.
- **DiGiCo**: OSC is supported on SD/Quantum/S-series, but the address list is
  only shown on the console (Extensions → OSC Control → OSC Commands) and
  isn't published.
- Allen & Heath and others: no profile yet; use Generic OSC with a bridge.
