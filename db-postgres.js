const { Pool } = require('pg');

// Конфигурация подключения к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
    if (callback) {
      // SQLite-style callback
      pool.query(query, params, (err, result) => {
        callback(err, result.rows);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(query, params, (err, result) => {
          if (err) reject(err);
          else resolve(result.rows);
        });
      });
    }
  },

  // Получить одну запись
  get: (query, params = [], callback) => {
    if (callback) {
      // SQLite-style callback
      pool.query(query, params, (err, result) => {
        callback(err, result.rows[0]);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(query, params, (err, result) => {
          if (err) reject(err);
          else resolve(result.rows[0]);
        });
      });
    }
  },

  // Выполнить запрос без возврата данных
  run: (query, params = [], callback) => {
    if (callback) {
      // SQLite-style callback
      pool.query(query, params, (err, result) => {
        callback(err, result);
      });
    } else {
      // Promise-style
      return new Promise((resolve, reject) => {
        pool.query(query, params, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    }
  },

  // Подготовленный запрос (для совместимости)
  prepare: (query) => {
    return {
      run: (params) => pool.query(query, params),
      finalize: (callback) => callback && callback()
    };
  },

  // Инициализация
  init: initTables
};

module.exports = db; 