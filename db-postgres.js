const { Pool } = require('pg');

// Конфигурация подключения к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Переписываем SQLite-специфичный SQL под PostgreSQL
function rewriteForPostgres(query) {
  let q = query;
  // Boolean сравнения
  q = q.replace(/\bis_booked\s*=\s*0\b/gi, 'is_booked=false');
  q = q.replace(/\bis_booked\s*=\s*1\b/gi, 'is_booked=true');
  // Текущая дата/время
  q = q.replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP');
  return q;
}

// Преобразование плейсхолдеров из SQLite-стиля `?` в PostgreSQL `$1..$n`
function toPgPlaceholders(query, params) {
  const rewritten = rewriteForPostgres(query);
  if (!Array.isArray(params) || params.length === 0) {
    return { text: rewritten, values: [] };
  }
  let index = 0;
  const text = rewritten.replace(/\?/g, () => `$${++index}`);
  return { text, values: params };
}

// Приводим результат к совместимому формату (например, boolean -> 0/1)
function normalizeRows(rows) {
  if (!rows) return rows;
  return rows.map(row => {
    const copy = { ...row };
    if (Object.prototype.hasOwnProperty.call(copy, 'is_booked')) {
      // В SQLite is_booked INTEGER(0/1); в PG BOOLEAN(true/false)
      if (typeof copy.is_booked === 'boolean') {
        copy.is_booked = copy.is_booked ? 1 : 0;
      }
    }
    return copy;
  });
}

// Инициализация таблиц
async function initTables() {
  const client = await pool.connect();
  try {
    // Создаем таблицу слотов
    await client.query(`
      CREATE TABLE IF NOT EXISTS slots (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        time TIME NOT NULL,
        is_booked BOOLEAN DEFAULT FALSE,
        UNIQUE(date, time)
      )
    `);

    // Создаем таблицу записей
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        slot_id INTEGER REFERENCES slots(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL,
        username VARCHAR(255),
        full_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Таблицы PostgreSQL инициализированы');
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц PostgreSQL:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Функции для работы с базой данных (совместимые с SQLite API)
const db = {
  // Получить все записи
  all: (query, params = [], callback) => {
    const { text, values } = toPgPlaceholders(query, params);
    if (callback) {
      // SQLite-style callback
      pool.query(text, values, (err, result) => {
        const rows = result ? normalizeRows(result.rows) : undefined;
        callback(err, rows);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(text, values, (err, result) => {
          if (err) reject(err);
          else resolve(normalizeRows(result.rows));
        });
      });
    }
  },

  // Получить одну запись
  get: (query, params = [], callback) => {
    const { text, values } = toPgPlaceholders(query, params);
    if (callback) {
      // SQLite-style callback
      pool.query(text, values, (err, result) => {
        const row = result ? normalizeRows(result.rows)[0] : undefined;
        callback(err, row);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(text, values, (err, result) => {
          if (err) reject(err);
          else resolve(normalizeRows(result.rows)[0]);
        });
      });
    }
  },

  // Выполнить запрос без возврата данных
  run: (query, params = [], callback) => {
    const { text, values } = toPgPlaceholders(query, params);
    if (callback) {
      // SQLite-style callback
      pool.query(text, values, (err, result) => {
        callback(err, result);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(text, values, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    }
  },

  // Подготовленный запрос (для совместимости)
  prepare: (query) => {
    return {
      run: (params) => {
        const { text, values } = toPgPlaceholders(query, params);
        return pool.query(text, values);
      },
      finalize: (callback) => callback && callback()
    };
  },

  // Инициализация
  init: initTables
};

module.exports = db; 