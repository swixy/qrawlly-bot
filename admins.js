// admins.js
// Parse admins from ENV or optional config.js
function parseAdminIdsFromString(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function getConfigAdmins() {
  try {
    const cfg = require('./config');
    if (Array.isArray(cfg.ADMIN_IDS)) return cfg.ADMIN_IDS.map((n) => parseInt(n, 10)).filter(Number.isFinite);
    if (cfg.ADMIN_ID) {
      const n = parseInt(cfg.ADMIN_ID, 10);
      return Number.isFinite(n) ? [n] : [];
    }
  } catch (_) {}
  return [];
}

let cachedAdmins = null;
function getAdmins() {
  if (cachedAdmins) return cachedAdmins;
  const envList = parseAdminIdsFromString(process.env.ADMIN_IDS);
  const envSingle = parseAdminIdsFromString(process.env.ADMIN_ID);
  const cfg = getConfigAdmins();
  const all = [...envList, ...envSingle, ...cfg];
  // unique
  cachedAdmins = Array.from(new Set(all));
  return cachedAdmins;
}

function isAdmin(userId) {
  return getAdmins().includes(Number(userId));
}

module.exports = { getAdmins, isAdmin }; 