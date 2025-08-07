// Тестовый скрипт для проверки базы данных
const { Pool } = require('pg');

console.log('🧪 Тестирование базы данных...\n');

// Проверяем переменные окружения
console.log('🔍 Переменные окружения:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ Найдена' : '❌ Не найдена');
console.log('NODE_ENV:', process.env.NODE_ENV || 'не установлена');

if (!process.env.DATABASE_URL) {
  console.log('\n❌ DATABASE_URL не найден. Запускаем SQLite тест...');
  
  // Тест SQLite
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database('./test.db');
  
  db.serialize(() => {
    // Создаем тестовую таблицу
    db.run(`CREATE TABLE IF NOT EXISTS test_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Добавляем тестовую запись
    db.run(`INSERT INTO test_table (message) VALUES ('Тест SQLite - ${new Date().toISOString()}')`);
    
    // Читаем записи
    db.all('SELECT * FROM test_table ORDER BY created_at DESC LIMIT 5', [], (err, rows) => {
      if (err) {
        console.error('❌ Ошибка SQLite:', err);
      } else {
        console.log('✅ SQLite записи:');
        rows.forEach(row => {
          console.log(`   ID: ${row.id}, Сообщение: ${row.message}, Время: ${row.created_at}`);
        });
      }
      db.close();
    });
  });
  
} else {
  console.log('\n✅ DATABASE_URL найден. Запускаем PostgreSQL тест...');
  
  // Тест PostgreSQL
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
  
  async function testPostgreSQL() {
    const client = await pool.connect();
    try {
      // Создаем тестовую таблицу
      await client.query(`
        CREATE TABLE IF NOT EXISTS test_table (
          id SERIAL PRIMARY KEY,
          message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Добавляем тестовую запись
      await client.query(
        'INSERT INTO test_table (message) VALUES ($1)',
        [`Тест PostgreSQL - ${new Date().toISOString()}`]
      );
      
      // Читаем записи
      const result = await client.query('SELECT * FROM test_table ORDER BY created_at DESC LIMIT 5');
      
      console.log('✅ PostgreSQL записи:');
      result.rows.forEach(row => {
        console.log(`   ID: ${row.id}, Сообщение: ${row.message}, Время: ${row.created_at}`);
      });
      
    } catch (error) {
      console.error('❌ Ошибка PostgreSQL:', error);
    } finally {
      client.release();
      await pool.end();
    }
  }
  
  testPostgreSQL();
}

console.log('\n🎯 Тест завершен!');
console.log('💡 Если записи сохраняются между деплоями, база работает правильно.'); 