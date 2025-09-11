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
      
      // Если это объект Date или строка с GMT, конвертируем в ISO
      if (dateStr instanceof Date) {
        dateStr = dateStr.toISOString().split('T')[0];
      } else if (typeof dateStr === 'string') {
        if (dateStr.includes('GMT') || dateStr.includes('T')) {
          // Если дата в формате JavaScript Date или ISO, конвертируем
          const date = new Date(dateStr);
          dateStr = date.toISOString().split('T')[0];
        }
        // Если уже в формате YYYY-MM-DD, оставляем как есть
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

// API для админ-панели
app.get('/api/admin/stats', (req, res) => {
  const isPostgres = !!process.env.DATABASE_URL;
  
  // Общее количество записей
  const totalBookingsSql = 'SELECT COUNT(*) as count FROM bookings';
  
  // Записи на сегодня
  const today = new Date().toISOString().split('T')[0];
  const todayBookingsSql = isPostgres 
    ? 'SELECT COUNT(*) as count FROM bookings WHERE date=$1'
    : 'SELECT COUNT(*) as count FROM bookings WHERE date=?';
  
  // Доступные слоты
  const availableSlotsSql = isPostgres
    ? 'SELECT COUNT(*) as count FROM slots WHERE is_booked=false'
    : 'SELECT COUNT(*) as count FROM slots WHERE is_booked=0';
  
  db.get(totalBookingsSql, [], (err, totalBookings) => {
    if (err) {
      console.error('Error fetching total bookings:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    db.get(todayBookingsSql, [today], (err, todayBookings) => {
      if (err) {
        console.error('Error fetching today bookings:', err);
        return res.json({ success: false, error: 'Database error' });
      }
      
      db.get(availableSlotsSql, [], (err, availableSlots) => {
        if (err) {
          console.error('Error fetching available slots:', err);
          return res.json({ success: false, error: 'Database error' });
        }
        
        res.json({
          success: true,
          stats: {
            totalBookings: totalBookings.count,
            todayBookings: todayBookings.count,
            availableSlots: availableSlots.count
          }
        });
      });
    });
  });
});

app.get('/api/admin/bookings', (req, res) => {
  const sql = 'SELECT id, date, time, user_id, username, full_name FROM bookings ORDER BY date, time';
  
  db.all(sql, [], (err, bookings) => {
    if (err) {
      console.error('Error fetching bookings:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    res.json({ success: true, bookings });
  });
});

app.post('/api/admin/add-slots', (req, res) => {
  const { date, times } = req.body;
  
  if (!date || !times || !Array.isArray(times)) {
    return res.status(400).json({ success: false, error: 'Неверные данные' });
  }
  
  const isPostgres = !!process.env.DATABASE_URL;
  const insertSql = isPostgres
    ? 'INSERT INTO slots (date, time, is_booked) VALUES ($1, $2, false) ON CONFLICT (date, time) DO NOTHING'
    : 'INSERT OR IGNORE INTO slots (date, time, is_booked) VALUES (?, ?, 0)';
  
  let completed = 0;
  let errors = [];
  
  times.forEach(time => {
    db.run(insertSql, [date, time], (err) => {
      if (err) {
        console.error('Error adding slot:', err);
        errors.push(err.message);
      }
      completed++;
      
      if (completed === times.length) {
        if (errors.length > 0) {
          res.json({ success: false, error: errors.join(', ') });
        } else {
          res.json({ success: true, message: `Добавлено ${times.length} слотов` });
        }
      }
    });
  });
});

app.get('/api/admin/available-times', (req, res) => {
  const { date } = req.query;
  
  if (!date) {
    return res.status(400).json({ success: false, error: 'Дата не указана' });
  }
  
  const isPostgres = !!process.env.DATABASE_URL;
  const sql = isPostgres
    ? 'SELECT time FROM slots WHERE date=$1 AND is_booked=false ORDER BY time'
    : 'SELECT time FROM slots WHERE date=? AND is_booked=0 ORDER BY time';
  
  db.all(sql, [date], (err, rows) => {
    if (err) {
      console.error('Error fetching available times:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    const times = rows.map(row => row.time);
    res.json({ success: true, times });
  });
});

app.post('/api/admin/remove-slot', (req, res) => {
  const { date, time } = req.body;
  
  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Дата и время не указаны' });
  }
  
  const isPostgres = !!process.env.DATABASE_URL;
  const sql = isPostgres
    ? 'DELETE FROM slots WHERE date=$1 AND time=$2'
    : 'DELETE FROM slots WHERE date=? AND time=?';
  
  db.run(sql, [date, time], function(err) {
    if (err) {
      console.error('Error removing slot:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ success: false, error: 'Слот не найден' });
    }
    
    res.json({ success: true, message: 'Слот удален' });
  });
});

app.post('/api/admin/delete-booking', (req, res) => {
  const { bookingId } = req.body;
  
  if (!bookingId) {
    return res.status(400).json({ success: false, error: 'ID записи не указан' });
  }
  
  const isPostgres = !!process.env.DATABASE_URL;
  
  // Получаем данные записи для освобождения слота
  const bookingSql = 'SELECT slot_id FROM bookings WHERE id=?';
  
  db.get(bookingSql, [bookingId], (err, booking) => {
    if (err) {
      console.error('Error fetching booking:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Запись не найдена' });
    }
    
    // Удаляем запись
    const deleteBookingSql = 'DELETE FROM bookings WHERE id=?';
    db.run(deleteBookingSql, [bookingId], (err) => {
      if (err) {
        console.error('Error deleting booking:', err);
        return res.json({ success: false, error: 'Database error' });
      }
      
      // Освобождаем слот
      const updateSlotSql = isPostgres
        ? 'UPDATE slots SET is_booked=false WHERE id=$1'
        : 'UPDATE slots SET is_booked=0 WHERE id=?';
      
      db.run(updateSlotSql, [booking.slot_id], (err) => {
        if (err) {
          console.error('Error updating slot:', err);
          return res.json({ success: false, error: 'Database error' });
        }
        
        res.json({ success: true, message: 'Запись удалена' });
      });
    });
  });
});

// Главная страница Web App
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

// Админ-панель
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'admin.html'));
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
