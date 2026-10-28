const x32 = require('./x32');
const wing = require('./wing');
const generic = require('./generic');

const PROFILES = { [x32.id]: x32, [wing.id]: wing, [generic.id]: generic };

function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new Error(`Unknown console profile "${id}"`);
  return p;
}

function listProfiles() {
  return Object.values(PROFILES).map((p) => ({
    id: p.id,
    label: p.label,
    defaultPort: p.defaultPort,
    maxChannels: p.maxChannels,
    canDiscover: !!p.discovery,
    canAudition: !!p.readback,
    canReadNames: !!p.channelName,
  }));
}

module.exports = { getProfile, listProfiles };
