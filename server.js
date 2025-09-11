const express = require('express');
const { Telegraf, session, Scenes, Markup } = require('telegraf');
const cron = require('node-cron');
const { logCtx, safeStr } = require('./logger');
const { getAdmins, isAdmin } = require('./admins');
const path = require('path');

// Импортируем основной код бота
const { startBot } = require('./index');

// Создаем Express приложение для Web App
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для Web App
app.use(express.json());
app.use(express.static(path.join(__dirname, 'webapp')));

// CORS для Telegram Web App
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Выбираем базу данных в зависимости от окружения
let db;
if (process.env.DATABASE_URL) {
  // Используем PostgreSQL на Railway
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
  
  // Создаем обертку для совместимости с SQLite API
  db = {
    all: (sql, params, callback) => {
      pool.query(sql, params)
        .then(result => callback(null, result.rows))
        .catch(err => callback(err));
    },
    get: (sql, params, callback) => {
      pool.query(sql, params)
        .then(result => callback(null, result.rows[0] || null))
        .catch(err => callback(err));
    },
    run: (sql, params, callback) => {
      pool.query(sql, params)
        .then(result => {
          if (callback) callback(null, { changes: result.rowCount, lastID: result.insertId });
        })
        .catch(err => callback ? callback(err) : console.error(err));
    }
  };
} else {
  // Используем SQLite локально
  const sqlite3 = require('sqlite3').verbose();
  const dbPath = path.join(__dirname, 'barber.db');
  db = new sqlite3.Database(dbPath);
}

// API для получения доступных слотов
app.get('/api/slots', (req, res) => {
  const sql = process.env.DATABASE_URL 
    ? `SELECT date, time FROM slots WHERE is_booked=false ORDER BY date, time`
    : `SELECT date, time FROM slots WHERE is_booked=0 ORDER BY date, time`;
    
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching slots:', err);
      return res.json({ success: false, error: 'Database error' });
    }

    // Группируем слоты по датам
    const slots = {};
    rows.forEach(row => {
      // Нормализуем дату в ISO формат (YYYY-MM-DD)
      let dateStr = row.date;
      if (typeof dateStr === 'string' && dateStr.includes('GMT')) {
        // Если дата в формате JavaScript Date, конвертируем в ISO
        const date = new Date(dateStr);
        dateStr = date.toISOString().split('T')[0];
      }
      
      if (!slots[dateStr]) {
        slots[dateStr] = [];
      }
      slots[dateStr].push(row.time);
    });

    console.log('Available slots:', Object.keys(slots));
    res.json({ success: true, slots });
  });
});

// API для бронирования
app.post('/api/book', (req, res) => {
  const { date, time, user_id, username, first_name } = req.body;

  if (!date || !time || !user_id) {
    return res.json({ success: false, error: 'Missing required fields' });
  }

  const isPostgres = !!process.env.DATABASE_URL;
  const slotCheckSql = isPostgres 
    ? `SELECT id FROM slots WHERE date=$1 AND time=$2 AND is_booked=false`
    : `SELECT id FROM slots WHERE date=? AND time=? AND is_booked=0`;
  const updateSlotSql = isPostgres
    ? `UPDATE slots SET is_booked=true WHERE id=$1`
    : `UPDATE slots SET is_booked=1 WHERE id=?`;
  const insertBookingSql = isPostgres
    ? `INSERT INTO bookings (user_id, username, full_name, slot_id, created_at, status) VALUES ($1,$2,$3,$4,NOW(),'confirmed')`
    : `INSERT INTO bookings (user_id, username, full_name, slot_id, created_at, status) VALUES (?,?,?,?,datetime('now'),'confirmed')`;
  const rollbackSql = isPostgres
    ? `UPDATE slots SET is_booked=false WHERE id=$1`
    : `UPDATE slots SET is_booked=0 WHERE id=?`;

  // Проверяем доступность слота
  db.get(slotCheckSql, [date, time], (err, slot) => {
    if (err) {
      console.error('Error checking slot:', err);
      return res.json({ success: false, error: 'Database error' });
    }

    if (!slot) {
      return res.json({ success: false, error: 'Slot is no longer available' });
    }

    // Бронируем слот
    db.run(updateSlotSql, [slot.id], function(err) {
      if (err) {
        console.error('Error updating slot:', err);
        return res.json({ success: false, error: 'Database error' });
      }

      // Создаем запись
      db.run(insertBookingSql, [user_id, username || '', first_name || '', slot.id], function(err) {
        if (err) {
          console.error('Error creating booking:', err);
          // Откатываем изменения в слоте
          db.run(rollbackSql, [slot.id]);
          return res.json({ success: false, error: 'Database error' });
        }

        res.json({ success: true, booking_id: this.lastID });
      });
    });
  });
});

// Главная страница Web App
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

// Запускаем сервер
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📱 Web App доступен по адресу: http://localhost:${PORT}`);
  
  // Запускаем бота
  startBot();
});

// Экспортируем для использования в основном боте
module.exports = { app, db };
