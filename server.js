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

// ------------------------------
// Helpers: DB utils and schema
// ------------------------------

const isPostgres = !!process.env.DATABASE_URL;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureColumn(table, column, type) {
  if (!isPostgres) {
    // SQLite: check pragma
    const cols = await all(`PRAGMA table_info(${table})`);
    const exists = cols.some(c => c.name === column);
    if (!exists) {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    return;
  }
  // Postgres: ADD COLUMN IF NOT EXISTS
  await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
}

async function initSchema() {
  // organizations
  await run(
    isPostgres
      ? `CREATE TABLE IF NOT EXISTS organizations (
           id SERIAL PRIMARY KEY,
           name TEXT NOT NULL,
           bot_token TEXT,
           webapp_url TEXT,
           created_at TIMESTAMP DEFAULT NOW()
         )`
      : `CREATE TABLE IF NOT EXISTS organizations (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           bot_token TEXT,
           webapp_url TEXT,
           created_at TEXT DEFAULT (datetime('now'))
         )`
  );

  // specialists
  await run(
    isPostgres
      ? `CREATE TABLE IF NOT EXISTS specialists (
           id SERIAL PRIMARY KEY,
           organization_id INTEGER REFERENCES organizations(id),
           name TEXT NOT NULL,
           specialty TEXT,
           is_active BOOLEAN DEFAULT true
         )`
      : `CREATE TABLE IF NOT EXISTS specialists (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           organization_id INTEGER,
           name TEXT NOT NULL,
           specialty TEXT,
           is_active INTEGER DEFAULT 1
         )`
  );

  // admins
  await run(
    isPostgres
      ? `CREATE TABLE IF NOT EXISTS admins (
           id SERIAL PRIMARY KEY,
           organization_id INTEGER,
           telegram_id BIGINT,
           role TEXT
         )`
      : `CREATE TABLE IF NOT EXISTS admins (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           organization_id INTEGER,
           telegram_id INTEGER,
           role TEXT
         )`
  );

  // org_settings
  await run(
    isPostgres
      ? `CREATE TABLE IF NOT EXISTS org_settings (
           organization_id INTEGER PRIMARY KEY REFERENCES organizations(id),
           assign_mode TEXT DEFAULT 'first_free'
         )`
      : `CREATE TABLE IF NOT EXISTS org_settings (
           organization_id INTEGER PRIMARY KEY,
           assign_mode TEXT DEFAULT 'first_free'
         )`
  );

  // Extend existing tables
  await ensureColumn('slots', 'organization_id', isPostgres ? 'INTEGER' : 'INTEGER');
  await ensureColumn('slots', 'specialist_id', isPostgres ? 'INTEGER' : 'INTEGER');
  await ensureColumn('bookings', 'organization_id', isPostgres ? 'INTEGER' : 'INTEGER');
  await ensureColumn('bookings', 'specialist_id', isPostgres ? 'INTEGER' : 'INTEGER');

  // Seed default organization
  const defaultOrgId = parseInt(process.env.ORG_ID || '1', 10);
  const existingOrg = await get(
    isPostgres ? 'SELECT id FROM organizations WHERE id=$1' : 'SELECT id FROM organizations WHERE id=?',
    [defaultOrgId]
  );
  if (!existingOrg) {
    if (isPostgres) {
      await run('INSERT INTO organizations (id, name, webapp_url) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
        defaultOrgId,
        'Default Organization',
        process.env.WEBAPP_URL || ''
      ]);
    } else {
      await run('INSERT OR IGNORE INTO organizations (id, name, webapp_url) VALUES (?,?,?)', [
        defaultOrgId,
        'Default Organization',
        process.env.WEBAPP_URL || ''
      ]);
    }
  }

  // Backfill existing rows
  await run(
    isPostgres
      ? `UPDATE slots SET organization_id=$1 WHERE organization_id IS NULL`
      : `UPDATE slots SET organization_id=? WHERE organization_id IS NULL`,
    [defaultOrgId]
  );
  await run(
    isPostgres
      ? `UPDATE bookings SET organization_id=$1 WHERE organization_id IS NULL`
      : `UPDATE bookings SET organization_id=? WHERE organization_id IS NULL`,
    [defaultOrgId]
  );
}

// Initialize schema on startup
initSchema().catch(err => console.error('Schema init error:', err));

// API для получения доступных слотов
app.get('/api/slots', (req, res) => {
  const { specialist_id, organization_id, anySpecialist } = req.query;
  const filters = [];
  const params = [];

  if (specialist_id) {
    filters.push('specialist_id = ' + (isPostgres ? '$' + (params.push(Number(specialist_id))) : '?'));
  }
  if (organization_id) {
    filters.push('organization_id = ' + (isPostgres ? '$' + (params.push(Number(organization_id))) : '?'));
  }
  filters.push(`is_booked=${isPostgres ? 'false' : '0'}`);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `SELECT date, time FROM slots ${where} ORDER BY date, time`;

  db.all(sql, params, (err, rows) => {
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

    res.json({ success: true, slots });
  });
});

// API для бронирования
app.post('/api/book', (req, res) => {
  const { date, time, user_id, username, first_name, specialist_id, organization_id, anySpecialist } = req.body;

  if (!date || !time || !user_id) {
    return res.json({ success: false, error: 'Missing required fields' });
  }

  // Determine specialist assignment
  const assignForOrg = async (orgId) => {
    const settings = await get(
      isPostgres
        ? 'SELECT assign_mode FROM org_settings WHERE organization_id=$1'
        : 'SELECT assign_mode FROM org_settings WHERE organization_id=?',
      [orgId]
    );
    const mode = (settings && settings.assign_mode) || 'first_free';

    if (mode === 'random') {
      const avail = await all(
        isPostgres
          ? `SELECT id, specialist_id FROM slots WHERE organization_id=$1 AND date=$2 AND time=$3 AND is_booked=false AND specialist_id IS NOT NULL`
          : `SELECT id, specialist_id FROM slots WHERE organization_id=? AND date=? AND time=? AND is_booked=0 AND specialist_id IS NOT NULL`,
        [orgId, date, time]
      );
      if (avail.length === 0) return null;
      return avail[Math.floor(Math.random() * avail.length)];
    }

    // first_free or default
    const first = await get(
      isPostgres
        ? `SELECT id, specialist_id FROM slots WHERE organization_id=$1 AND date=$2 AND time=$3 AND is_booked=false AND specialist_id IS NOT NULL ORDER BY id ASC LIMIT 1`
        : `SELECT id, specialist_id FROM slots WHERE organization_id=? AND date=? AND time=? AND is_booked=0 AND specialist_id IS NOT NULL ORDER BY id ASC LIMIT 1`,
      [orgId, date, time]
    );
    return first;
  };

  const orgId = Number(organization_id || process.env.ORG_ID || 1);

  const slotCheckSql = isPostgres 
    ? `SELECT id, specialist_id FROM slots WHERE date=$1 AND time=$2 AND ${specialist_id ? 'specialist_id=$3 AND ' : ''}is_booked=false ${organization_id ? 'AND organization_id=$' + (specialist_id ? 4 : 3) : ''}`
    : `SELECT id, specialist_id FROM slots WHERE date=? AND time=? AND ${specialist_id ? 'specialist_id=? AND ' : ''}is_booked=0 ${organization_id ? 'AND organization_id=' + '?' : ''}`;
  const updateSlotSql = isPostgres
    ? `UPDATE slots SET is_booked=true WHERE id=$1`
    : `UPDATE slots SET is_booked=1 WHERE id=?`;
  const insertBookingSql = isPostgres
    ? `INSERT INTO bookings (organization_id, specialist_id, user_id, username, full_name, slot_id, created_at, status) VALUES ($1,$2,$3,$4,$5,$6,NOW(),'confirmed')`
    : `INSERT INTO bookings (organization_id, specialist_id, user_id, username, full_name, slot_id, created_at, status) VALUES (?,?,?,?,?,?,datetime('now'),'confirmed')`;
  const rollbackSql = isPostgres
    ? `UPDATE slots SET is_booked=false WHERE id=$1`
    : `UPDATE slots SET is_booked=0 WHERE id=?`;

  const checkParams = [];
  if (isPostgres) {
    checkParams.push(date, time);
    if (specialist_id) checkParams.push(Number(specialist_id));
    if (organization_id) checkParams.push(Number(orgId));
  } else {
    checkParams.push(date, time);
    if (specialist_id) checkParams.push(Number(specialist_id));
    if (organization_id) checkParams.push(Number(orgId));
  }

  // Проверяем доступность слота / назначаем специалиста при anySpecialist
  db.get(slotCheckSql, checkParams, async (err, slot) => {
    if (err) {
      console.error('Error checking slot:', err);
      return res.json({ success: false, error: 'Database error' });
    }

    if (!slot) {
      if (anySpecialist) {
        try {
          const assigned = await assignForOrg(orgId);
          if (!assigned) return res.json({ success: false, error: 'No specialists available' });
          slot = assigned; // { id, specialist_id }
        } catch (e) {
          console.error('Assignment error:', e);
          return res.json({ success: false, error: 'Assignment error' });
        }
      } else {
        return res.json({ success: false, error: 'Slot is no longer available' });
      }
    }

    // Бронируем слот
    db.run(updateSlotSql, [slot.id], function(err) {
      if (err) {
        console.error('Error updating slot:', err);
        return res.json({ success: false, error: 'Database error' });
      }

      // Создаем запись
      const bookingParams = isPostgres
        ? [orgId, slot.specialist_id || (specialist_id ? Number(specialist_id) : null), user_id, username || '', first_name || '', slot.id]
        : [orgId, slot.specialist_id || (specialist_id ? Number(specialist_id) : null), user_id, username || '', first_name || '', slot.id];
      db.run(insertBookingSql, bookingParams, function(err) {
        if (err) {
          console.error('Error creating booking:', err);
          // Откатываем изменения в слоте
          db.run(rollbackSql, [slot.id]);
          return res.json({ success: false, error: 'Database error' });
        }

        res.json({ success: true, booking_id: this.lastID, specialist_id: slot.specialist_id || specialist_id || null });
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
    ? 'SELECT COUNT(*) as count FROM bookings b JOIN slots s ON b.slot_id = s.id WHERE s.date=$1'
    : 'SELECT COUNT(*) as count FROM bookings b JOIN slots s ON b.slot_id = s.id WHERE s.date=?';
  
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
  const sql = `
    SELECT 
      b.id,
      s.date,
      s.time,
      b.user_id,
      b.username,
      b.full_name,
      b.specialist_id,
      sp.name AS specialist_name
    FROM bookings b
    JOIN slots s ON b.slot_id = s.id
    LEFT JOIN specialists sp ON b.specialist_id = sp.id
    ORDER BY s.date, s.time
  `;
  
  db.all(sql, [], (err, bookings) => {
    if (err) {
      console.error('Error fetching bookings:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    res.json({ success: true, bookings });
  });
});

app.post('/api/admin/add-slots', (req, res) => {
  const { date, times, specialist_id, organization_id } = req.body;
  
  if (!date || !times || !Array.isArray(times)) {
    return res.status(400).json({ success: false, error: 'Неверные данные' });
  }
  
  const orgId = Number(organization_id || process.env.ORG_ID || 1);
  const insertSql = isPostgres
    ? 'INSERT INTO slots (organization_id, specialist_id, date, time, is_booked) VALUES ($1, $2, $3, $4, false) ON CONFLICT DO NOTHING'
    : 'INSERT OR IGNORE INTO slots (organization_id, specialist_id, date, time, is_booked) VALUES (?, ?, ?, ?, 0)';
  
  let completed = 0;
  let errors = [];
  
  times.forEach(time => {
    db.run(insertSql, [orgId, specialist_id || null, date, time], (err) => {
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
  const { date, specialist_id, organization_id } = req.query;
  
  if (!date) {
    return res.status(400).json({ success: false, error: 'Дата не указана' });
  }
  
  const filters = ['date = ' + (isPostgres ? '$1' : '?'), `is_booked=${isPostgres ? 'false' : '0'}`];
  const params = [date];
  if (specialist_id) {
    filters.push('specialist_id = ' + (isPostgres ? '$' + (params.push(Number(specialist_id))) : '?'));
  }
  if (organization_id) {
    filters.push('organization_id = ' + (isPostgres ? '$' + (params.push(Number(organization_id))) : '?'));
  }
  const sql = `SELECT time FROM slots WHERE ${filters.join(' AND ')} ORDER BY time`;
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching available times:', err);
      return res.json({ success: false, error: 'Database error' });
    }
    
    const times = rows.map(row => row.time);
    res.json({ success: true, times });
  });
});

app.post('/api/admin/remove-slot', (req, res) => {
  const { date, time, specialist_id, organization_id } = req.body;
  
  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Дата и время не указаны' });
  }
  
  const filters = ['date', 'time'];
  const params = [date, time];
  let idx = 3;
  if (specialist_id) {
    filters.push('specialist_id');
    params.push(Number(specialist_id));
    idx++;
  }
  if (organization_id) {
    filters.push('organization_id');
    params.push(Number(organization_id));
    idx++;
  }
  const where = filters
    .map((f, i) => `${f}=${isPostgres ? '$' + (i + 1) : '?'}`)
    .join(' AND ');
  const sql = `DELETE FROM slots WHERE ${where}`;
  
  db.run(sql, params, function(err) {
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

// ------------------------------
// Admin: specialists and settings
// ------------------------------

app.get('/api/admin/specialists', (req, res) => {
  const sql = `SELECT id, name, specialty, is_active FROM specialists ORDER BY name`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true, specialists: rows });
  });
});

app.post('/api/admin/add-specialist', (req, res) => {
  const { name, specialty, is_active, organization_id } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
  const orgId = Number(organization_id || process.env.ORG_ID || 1);
  const sql = isPostgres
    ? 'INSERT INTO specialists (organization_id, name, specialty, is_active) VALUES ($1,$2,$3,$4)'
    : 'INSERT INTO specialists (organization_id, name, specialty, is_active) VALUES (?,?,?,?)';
  const active = is_active === undefined ? (isPostgres ? true : 1) : is_active;
  db.run(sql, [orgId, name, specialty || '', isPostgres ? !!active : active ? 1 : 0], function(err) {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true, specialist_id: this.lastID });
  });
});

app.post('/api/admin/remove-specialist', (req, res) => {
  const { specialist_id } = req.body;
  if (!specialist_id) return res.status(400).json({ success: false, error: 'specialist_id required' });
  const sql = isPostgres ? 'UPDATE specialists SET is_active=false WHERE id=$1' : 'UPDATE specialists SET is_active=0 WHERE id=?';
  db.run(sql, [Number(specialist_id)], function(err) {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true });
  });
});

app.post('/api/admin/settings', (req, res) => {
  const { organization_id, assignMode } = req.body;
  const orgId = Number(organization_id || process.env.ORG_ID || 1);
  const mode = ['first_free', 'random', 'balanced', 'priority'].includes(assignMode) ? assignMode : 'first_free';
  if (isPostgres) {
    run('INSERT INTO org_settings (organization_id, assign_mode) VALUES ($1,$2) ON CONFLICT (organization_id) DO UPDATE SET assign_mode=EXCLUDED.assign_mode', [orgId, mode])
      .then(() => res.json({ success: true }))
      .catch(() => res.json({ success: false, error: 'Database error' }));
  } else {
    run('INSERT OR REPLACE INTO org_settings (organization_id, assign_mode) VALUES (?,?)', [orgId, mode])
      .then(() => res.json({ success: true }))
      .catch(() => res.json({ success: false, error: 'Database error' }));
  }
});

// ------------------------------
// Superadmin endpoints (minimal)
// ------------------------------

app.get('/api/superadmin/organizations', (req, res) => {
  db.all('SELECT id, name, webapp_url, created_at FROM organizations ORDER BY id', [], (err, rows) => {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true, organizations: rows });
  });
});

app.post('/api/superadmin/add-organization', (req, res) => {
  const { id, name, bot_token, webapp_url } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const sql = isPostgres
    ? 'INSERT INTO organizations (id, name, bot_token, webapp_url) VALUES ($1,$2,$3,$4)'
    : 'INSERT INTO organizations (id, name, bot_token, webapp_url) VALUES (?,?,?,?)';
  db.run(sql, [id || null, name, bot_token || '', webapp_url || ''], function(err) {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true, organization_id: this.lastID || id });
  });
});

app.get('/api/superadmin/stats', async (req, res) => {
  try {
    const orgs = await all('SELECT id, name FROM organizations');
    const results = [];
    for (const org of orgs) {
      const b = await get(isPostgres ? 'SELECT COUNT(*) as count FROM bookings WHERE organization_id=$1' : 'SELECT COUNT(*) as count FROM bookings WHERE organization_id=?', [org.id]);
      const s = await get(isPostgres ? 'SELECT COUNT(*) as count FROM slots WHERE organization_id=$1' : 'SELECT COUNT(*) as count FROM slots WHERE organization_id=?', [org.id]);
      results.push({ organization_id: org.id, name: org.name, bookings: b ? b.count : 0, slots: s ? s.count : 0 });
    }
    res.json({ success: true, stats: results });
  } catch (e) {
    console.error(e);
    res.json({ success: false, error: 'Database error' });
  }
});

// ------------------------------
// Public specialists list for client
// ------------------------------
app.get('/api/specialists', (req, res) => {
  const { organization_id } = req.query;
  const params = [];
  let where = 'WHERE is_active=' + (isPostgres ? 'true' : '1');
  if (organization_id) {
    where += ' AND organization_id=' + (isPostgres ? '$1' : '?');
    params.push(Number(organization_id));
  }
  const sql = `SELECT id, name, specialty FROM specialists ${where} ORDER BY name`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.json({ success: false, error: 'Database error' });
    res.json({ success: true, specialists: rows });
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
