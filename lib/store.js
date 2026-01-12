const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadRooms() {
  try {
    ensureDir();
    if (!fs.existsSync(ROOMS_FILE)) return { rooms: {}, meta: {} };
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    // normalize meta shape to include lastSeen mapping
    const meta = obj.meta || {};
    Object.keys(meta).forEach(r => {
      if (!meta[r].lastSeen) meta[r].lastSeen = {};
    });
    return { rooms: obj.rooms || {}, meta };
  } catch (e) { return { rooms: {}, meta: {} }; }
}

function saveRooms(storeObj) {
  try {
    ensureDir();
    const out = { rooms: storeObj.rooms || {}, meta: storeObj.meta || {} };
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    // ignore write failures for demo
  }
}

module.exports = { loadRooms, saveRooms };
