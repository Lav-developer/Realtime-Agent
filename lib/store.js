const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadRooms() {
  try {
    ensureDir();
    if (!fs.existsSync(ROOMS_FILE)) return { rooms: {}, meta: {} };
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    const meta = obj.meta || {};
    Object.keys(meta).forEach((r) => {
      if (!meta[r] || typeof meta[r] !== 'object') meta[r] = {};
      if (!meta[r].lastSeen || typeof meta[r].lastSeen !== 'object') meta[r].lastSeen = {};
    });
    return { rooms: obj.rooms || {}, meta };
  } catch (e) {
    console.error('store.loadRooms failed:', e.message);
    return { rooms: {}, meta: {} };
  }
}

function saveRooms(storeObj) {
  try {
    ensureDir();
    const out = { rooms: storeObj.rooms || {}, meta: storeObj.meta || {} };
    const tmp = `${ROOMS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, ROOMS_FILE);
  } catch (e) {
    console.error('store.saveRooms failed:', e.message);
  }
}

module.exports = { loadRooms, saveRooms };
