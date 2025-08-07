const db = require('./db');

console.log('Инициализация базы данных...');

// Создаем тестовые слоты на ближайшие дни
const today = new Date();
const slots = [];

// Создаем слоты на следующие 7 дней
for (let i = 0; i < 7; i++) {
  const date = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
  const dateStr = date.toISOString().split('T')[0];
  
  // Добавляем слоты с 9:00 до 18:00 каждый час
  for (let hour = 9; hour <= 18; hour++) {
    const timeStr = `${hour.toString().padStart(2, '0')}:00`;
    slots.push([dateStr, timeStr]);
  }
}

// Вставляем слоты в базу данных
const insertSlots = () => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR IGNORE INTO slots (date, time, is_booked) VALUES (?, ?, 0)');
    
    slots.forEach(([date, time]) => {
      stmt.run([date, time]);
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('Ошибка при добавлении слотов:', err);
        reject(err);
      } else {
        console.log(`✅ Добавлено ${slots.length} слотов`);
        resolve();
      }
    });
  });
};

// Проверяем существующие слоты
const checkSlots = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT COUNT(*) as count FROM slots', [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        console.log(`📊 Всего слотов в базе: ${rows[0].count}`);
        resolve(rows[0].count);
      }
    });
  });
};

// Основная функция инициализации
async function initDatabase() {
  try {
    console.log('🔍 Проверяем существующие слоты...');
    const existingSlots = await checkSlots();
    
    if (existingSlots === 0) {
      console.log('📝 База данных пуста, добавляем тестовые слоты...');
      await insertSlots();
      console.log('✅ Инициализация завершена успешно!');
    } else {
      console.log('✅ База данных уже содержит слоты, инициализация не требуется.');
    }
    
    // Показываем примеры слотов
    db.all('SELECT date, time FROM slots ORDER BY date, time LIMIT 10', [], (err, rows) => {
      if (!err && rows.length > 0) {
        console.log('\n📅 Примеры доступных слотов:');
        rows.forEach(row => {
          console.log(`  ${row.date} ${row.time}`);
        });
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка инициализации:', error);
  } finally {
    // Закрываем соединение с базой данных
    db.close((err) => {
      if (err) {
        console.error('Ошибка при закрытии базы данных:', err);
      } else {
        console.log('🔒 Соединение с базой данных закрыто');
      }
    });
  }
}

// Запускаем инициализацию
initDatabase(); 