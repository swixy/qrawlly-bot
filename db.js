const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./barber.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    is_booked INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    full_name TEXT,
    slot_id INTEGER,
    created_at TEXT,
    status TEXT
  )`);
});

module.exports = db;
