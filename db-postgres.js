const { Pool } = require('pg');

// Конфигурация подключения к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Преобразование плейсхолдеров из SQLite-стиля `?` в PostgreSQL `$1..$n`
function toPgPlaceholders(query, params) {
  if (!Array.isArray(params) || params.length === 0) {
    return { text: query, values: [] };
  }
  let index = 0;
  const text = query.replace(/\?/g, () => `$${++index}`);
  return { text, values: params };
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
        callback(err, result ? result.rows : undefined);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(text, values, (err, result) => {
          if (err) reject(err);
          else resolve(result.rows);
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
        callback(err, result ? result.rows[0] : undefined);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(text, values, (err, result) => {
          if (err) reject(err);
          else resolve(result.rows[0]);
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