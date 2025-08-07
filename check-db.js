const db = require('./db');

console.log('🔍 Проверка базы данных...\n');

// Проверяем количество слотов
db.get('SELECT COUNT(*) as count FROM slots', [], (err, row) => {
  if (err) {
    console.error('❌ Ошибка при проверке слотов:', err);
    return;
  }
  console.log(`📊 Всего слотов в базе: ${row.count}`);
  
  // Проверяем свободные слоты
  db.get('SELECT COUNT(*) as count FROM slots WHERE is_booked=0', [], (err, freeRow) => {
    if (err) {
      console.error('❌ Ошибка при проверке свободных слотов:', err);
      return;
    }
    console.log(`🟢 Свободных слотов: ${freeRow.count}`);
    
    // Проверяем забронированные слоты
    db.get('SELECT COUNT(*) as count FROM slots WHERE is_booked=1', [], (err, bookedRow) => {
      if (err) {
        console.error('❌ Ошибка при проверке забронированных слотов:', err);
        return;
      }
      console.log(`🔴 Забронированных слотов: ${bookedRow.count}`);
      
      // Проверяем записи
      db.get('SELECT COUNT(*) as count FROM bookings', [], (err, bookingsRow) => {
        if (err) {
          console.error('❌ Ошибка при проверке записей:', err);
          return;
        }
        console.log(`📋 Всего записей: ${bookingsRow.count}`);
        
        // Показываем последние 5 слотов
        console.log('\n📅 Последние 5 слотов:');
        db.all('SELECT date, time, is_booked FROM slots ORDER BY date DESC, time DESC LIMIT 5', [], (err, slots) => {
          if (err) {
            console.error('❌ Ошибка при получении слотов:', err);
            return;
          }
          
          if (slots.length === 0) {
            console.log('   Нет слотов в базе');
          } else {
            slots.forEach(slot => {
              const status = slot.is_booked ? '🔴' : '🟢';
              console.log(`   ${status} ${slot.date} ${slot.time}`);
            });
          }
          
          // Показываем последние 5 записей
          console.log('\n📋 Последние 5 записей:');
          db.all(`
            SELECT b.user_id, b.username, b.full_name, s.date, s.time 
            FROM bookings b 
            JOIN slots s ON b.slot_id = s.id 
            ORDER BY b.created_at DESC 
            LIMIT 5
          `, [], (err, bookings) => {
            if (err) {
              console.error('❌ Ошибка при получении записей:', err);
              return;
            }
            
            if (bookings.length === 0) {
              console.log('   Нет записей в базе');
            } else {
              bookings.forEach(booking => {
                console.log(`   👤 @${booking.username || 'unknown'} (${booking.full_name || 'Unknown'}) - ${booking.date} ${booking.time}`);
              });
            }
            
            console.log('\n✅ Проверка завершена!');
            process.exit(0);
          });
        });
      });
    });
  });
}); 