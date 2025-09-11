const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'barber.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Проверка базы данных...');

// Проверяем количество слотов
db.get("SELECT COUNT(*) as count FROM slots", [], (err, row) => {
  if (err) {
    console.error('❌ Ошибка:', err.message);
    return;
  }
  
  console.log(`📊 Всего слотов в базе: ${row.count}`);
  
  // Проверяем свободные слоты
  db.get("SELECT COUNT(*) as count FROM slots WHERE is_booked=0", [], (err, row) => {
    if (err) {
      console.error('❌ Ошибка:', err.message);
      return;
    }
    
    console.log(`🟢 Свободных слотов: ${row.count}`);
    
    // Показываем несколько примеров слотов
    db.all("SELECT date, time, is_booked FROM slots ORDER BY date, time LIMIT 5", [], (err, rows) => {
      if (err) {
        console.error('❌ Ошибка:', err.message);
        return;
      }
      
      console.log('\n📅 Примеры слотов:');
      rows.forEach(row => {
        const status = row.is_booked ? '🔴 Занят' : '🟢 Свободен';
        console.log(`  ${row.date} ${row.time} - ${status}`);
      });
      
      db.close();
    });
  });
});
