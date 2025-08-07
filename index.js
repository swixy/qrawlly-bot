const { Telegraf, session, Scenes, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const bookingScene = require('./scenes/booking');
const addslotScene = require('./scenes/addslot');

// Конфигурация - приоритет переменным окружения, затем config.js
let config;
try {
  config = require('./config');
} catch (error) {
  // Если config.js не найден, используем переменные окружения
  config = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ADMIN_ID: parseInt(process.env.ADMIN_ID),
    REMINDER_HOURS: parseInt(process.env.REMINDER_HOURS) || 2
  };
}

const { BOT_TOKEN, ADMIN_ID, REMINDER_HOURS } = config;

// Проверка обязательных переменных
if (!BOT_TOKEN) {
  console.error('❌ Ошибка: BOT_TOKEN не найден!');
  console.error('Добавьте BOT_TOKEN в config.js или переменные окружения');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('❌ Ошибка: ADMIN_ID не найден!');
  console.error('Добавьте ADMIN_ID в config.js или переменные окружения');
  process.exit(1);
}

console.log('Запуск бота...');
console.log(`🤖 Токен бота: ${BOT_TOKEN.substring(0, 10)}...`);
console.log(`👤 Админ ID: ${ADMIN_ID}`);
console.log(`⏰ Напоминания за ${REMINDER_HOURS} часов`);

// Функция инициализации базы данных
function initDatabase() {
  return new Promise((resolve, reject) => {
    // Проверяем, есть ли слоты в базе
    db.get('SELECT COUNT(*) as count FROM slots', [], (err, row) => {
      if (err) {
        console.error('Ошибка проверки базы данных:', err);
        reject(err);
        return;
      }
      
      // Добавляем тестовые слоты только локально, не на Railway
      if (row.count === 0 && !process.env.DATABASE_URL) {
        console.log('📝 База данных пуста, добавляем тестовые слоты...');
        
        // Создаем слоты на следующие 7 дней
        const today = new Date();
        const slots = [];
        
        for (let i = 0; i < 7; i++) {
          const date = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
          const dateStr = date.toISOString().split('T')[0];
          
          // Добавляем слоты с 9:00 до 18:00 каждый час
          for (let hour = 9; hour <= 18; hour++) {
            const timeStr = `${hour.toString().padStart(2, '0')}:00`;
            slots.push([dateStr, timeStr]);
          }
        }
        
        // Вставляем слоты
        const stmt = db.prepare('INSERT OR IGNORE INTO slots (date, time, is_booked) VALUES (?, ?, 0)');
        slots.forEach(([date, time]) => {
          stmt.run([date, time]);
        });
        
        stmt.finalize((err) => {
          if (err) {
            console.error('Ошибка при добавлении слотов:', err);
            reject(err);
          } else {
            console.log(`✅ Добавлено ${slots.length} тестовых слотов`);
            resolve();
          }
        });
      } else if (row.count === 0 && process.env.DATABASE_URL) {
        console.log('📝 База данных пуста. На Railway слоты нужно добавлять вручную через админское меню.');
        resolve();
      } else {
        console.log(`✅ База данных содержит ${row.count} слотов`);
        resolve();
      }
    });
  });
}

// Создаем экземпляр бота с дополнительными настройками
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    // Отключаем webhook по умолчанию
    webhookReply: false
  }
});

// Настройка сцен
const stage = new Scenes.Stage([bookingScene, addslotScene]);
bot.use(session());
bot.use(stage.middleware());

// Главное меню
bot.start((ctx) => {
  ctx.reply('Привет! Я бот для записи на стрижку. Выберите действие:', Markup.keyboard([
    ['✂️ Записаться на стрижку'],
    ['📋 Мои записи', '❌ Отменить запись'],
    ['ℹ️ Помощь']
  ]).resize());
});

bot.hears('✂️ Записаться на стрижку', (ctx) => ctx.scene.enter('booking'));
bot.hears('📋 Мои записи', (ctx) => {
  db.all(
    `SELECT s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.user_id=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [ctx.from.id],
    (err, rows) => {
      if (rows.length === 0) return ctx.reply('У вас нет записей.');
      const list = rows.map(r => `📅 ${formatDateDMY(r.date)} ⏰ ${r.time}`).join('\n');
      ctx.reply(`Ваши записи:\n${list}`);
    }
  );
});

// Помощь
bot.hears('ℹ️ Помощь', (ctx) => ctx.reply('/start - перезапуск бота\n@streetnoiser - связаться'));

// Админ команды
bot.command('addslot', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Формат: /addslot YYYY-MM-DD HH:MM');
  db.run(`INSERT INTO slots (date,time) VALUES (?,?)`, [args[1], args[2]]);
  ctx.reply(`Слот добавлен: ${args[1]} ${args[2]}`);
});

// Напоминания (каждый час)
cron.schedule('0 * * * *', () => {
  const now = new Date();
  const reminderTime = new Date(now.getTime() + REMINDER_HOURS * 60 * 60 * 1000);
  const dateStr = reminderTime.toISOString().split('T')[0];
  const timeStr = reminderTime.toTimeString().slice(0, 5);
  db.all(`SELECT b.user_id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND s.time=?`,
    [dateStr, timeStr], (err, rows) => {
      rows.forEach(r => {
        bot.telegram.sendMessage(r.user_id, `Напоминание! Ваша стрижка ${r.date} в ${r.time}`);
      });
    });
});

bot.hears('❌ Отменить запись', (ctx) => {
    db.all(
      `SELECT b.id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.user_id=? AND b.status='confirmed' ORDER BY s.date, s.time`,
      [ctx.from.id],
      (err, rows) => {
        if (!rows || rows.length === 0) {
          return ctx.reply('У вас нет активных записей для отмены.');
        }
        // Показываем список записей для отмены
        const buttons = rows.map(r =>
          [Markup.button.callback(`❌ ${formatDateDMY(r.date)} ${r.time}`, `cancel_${r.id}`)]
        );
        ctx.reply('Выберите запись для отмены:', Markup.inlineKeyboard(buttons));
      }
    );
  });

// Обработка нажатия на inline-кнопку отмены
bot.action(/cancel_(\d+)/, (ctx) => {
  const bookingId = ctx.match[1];
  db.get(
    `SELECT slot_id, date, time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.id=? AND b.user_id=? AND b.status='confirmed'`,
    [bookingId, ctx.from.id],
    (err, booking) => {
      if (!booking) {
        ctx.answerCbQuery();
        return ctx.editMessageText('Запись не найдена или уже отменена.');
      }
      db.run(`UPDATE bookings SET status='cancelled' WHERE id=?`, [bookingId]);
      db.run(`UPDATE slots SET is_booked=0 WHERE id=?`, [booking.slot_id]);
      ctx.answerCbQuery();
      ctx.editMessageText('Запись отменена.');
      ctx.reply(
        `❌ Запись отменена!\n\n📅 Дата: ${formatDateDMY(booking.date)} (${getWeekdayFullRu(booking.date)})\n⏰ Время: ${booking.time}\n\nВы можете выбрать новую запись.`,
        Markup.keyboard([
          ['✂️ Записаться на стрижку'],
          ['📋 Мои записи', '❌ Отменить запись'],
          ['ℹ️ Помощь']
        ]).resize()
      );
      // Уведомление админу
      ctx.telegram.sendMessage(
        require('./config').ADMIN_ID,
        `❌ Отмена записи!\n\n👤 Пользователь: @${ctx.from.username || ''} (${ctx.from.first_name || ''})\n📅 Дата: ${formatDateDMY(booking.date)} (${getWeekdayFullRu(booking.date)})\n⏰ Время: ${booking.time}`
      );
    }
  );
});

// === Админ-команды ===

// Показать все записи на сегодня
bot.command('today', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const today = new Date().toISOString().split('T')[0];
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [today],
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('На сегодня записей нет.');
      const list = rows.map(r => `@${r.username || ''} (${r.full_name || ''}) — ${formatDateDMY(r.date)} ${r.time}`).join('\n');
      ctx.reply('Записи на сегодня:\n' + list);
    }
  );
});

// Показать все записи на завтра
bot.command('tomorrow', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [tomorrow],
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('На завтра записей нет.');
      const list = rows.map(r => `@${r.username || ''} (${r.full_name || ''}) — ${formatDateDMY(r.date)} ${r.time}`).join('\n');
      ctx.reply('Записи на завтра:\n' + list);
    }
  );
});

// Показать все свободные слоты
bot.command('freeslots', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    db.all(`SELECT date, time FROM slots WHERE is_booked=0 ORDER BY date, time`, [], (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('Свободных слотов нет.');
      const list = rows.map(r => `${formatDateDMY(r.date)} ${r.time}`).join('\n');
      ctx.reply('Свободные слоты:\n' + list);
    });
  });
// Добавить слот
  bot.command('addslot', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;  // Проверка админа
    ctx.scene.enter('addslot');
  })

// Удалить слот по дате и времени
bot.command('deleteslot', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Формат: /deleteslot YYYY-MM-DD HH:MM');
  db.run(`DELETE FROM slots WHERE date=? AND time=?`, [args[1], args[2]], function(err) {
    if (this.changes === 0) return ctx.reply('Слот не найден.');
    ctx.reply('Слот удалён.');
  });
});

// Массовая рассылка
bot.command('broadcast', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Текст рассылки не указан.');
  db.all(`SELECT DISTINCT user_id FROM bookings`, [], (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Нет пользователей для рассылки.');
    rows.forEach(r => {
      bot.telegram.sendMessage(r.user_id, text).catch(() => {});
    });
    ctx.reply('Рассылка отправлена.');
  });
});


// Статистика
bot.command('stats', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  db.get(`SELECT COUNT(DISTINCT user_id) as users FROM bookings`, [], (err, row1) => {
    db.get(`SELECT COUNT(*) as total FROM bookings WHERE status='confirmed'`, [], (err, row2) => {
      db.get(`SELECT COUNT(*) as free FROM slots WHERE is_booked=0`, [], (err, row3) => {
        ctx.reply(`Статистика:\nПользователей: ${row1.users}\nАктивных записей: ${row2.total}\nСвободных слотов: ${row3.free}`);
      });
    });
  });
});

// Админ-меню
bot.command('admin', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply('Админ-меню:', Markup.keyboard([
    ['📅 Записи на сегодня', '🟢 Свободные слоты'],
    ['📆 Записи на завтра', '➕ Добавить слот'],
    ['📅 Записи на неделю', '❌ Удалить слот'],
    ['📆 Записи на месяц', '📊 Статистика'],
    ['📢 Рассылка']
  ]).resize());
});

// Записи на неделю
bot.hears('📅 Записи на неделю', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const today = new Date();
  const weekDates = Array.from({length: 7}, (_, i) => {
    const d = new Date(today.getTime() + i * 24*60*60*1000);
    return d.toISOString().split('T')[0];
  });
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date IN (${weekDates.map(() => '?').join(',')}) AND b.status='confirmed' ORDER BY s.date, s.time`,
    weekDates,
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('На этой неделе записей нет.');
      // Группируем записи по дням и времени
      const groupedByDate = {};
      rows.forEach(r => {
        const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
        if (!groupedByDate[dateKey]) {
          groupedByDate[dateKey] = {};
        }
        if (!groupedByDate[dateKey][r.time]) {
          groupedByDate[dateKey][r.time] = [];
        }
        groupedByDate[dateKey][r.time].push(`@${r.username || ''} (${r.full_name || ''})`);
      });
      
      const list = Object.keys(groupedByDate).sort().map(date => {
        const timesList = Object.keys(groupedByDate[date]).sort().map(time => 
          `  ${time}: ${groupedByDate[date][time].join(', ')}`
        ).join('\n');
        return `${date}:\n${timesList}`;
      }).join('\n\n');
      
      ctx.reply('Записи на неделю:\n' + list);
    }
  );
});

// Записи на месяц
bot.hears('📆 Записи на месяц', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const firstDay = `${year}-${month}-01`;
  const nextMonth = new Date(year, today.getMonth() + 1, 1);
  const lastDay = new Date(nextMonth - 1).toISOString().split('T')[0];
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date >= ? AND s.date <= ? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [firstDay, lastDay],
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('В этом месяце записей нет.');
      // Группируем записи по дням и времени
      const groupedByDate = {};
      rows.forEach(r => {
        const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
        if (!groupedByDate[dateKey]) {
          groupedByDate[dateKey] = {};
        }
        if (!groupedByDate[dateKey][r.time]) {
          groupedByDate[dateKey][r.time] = [];
        }
        groupedByDate[dateKey][r.time].push(`@${r.username || ''} (${r.full_name || ''})`);
      });
      
      const list = Object.keys(groupedByDate).sort().map(date => {
        const timesList = Object.keys(groupedByDate[date]).sort().map(time => 
          `  ${time}: ${groupedByDate[date][time].join(', ')}`
        ).join('\n');
        return `${date}:\n${timesList}`;
      }).join('\n\n');
      
      ctx.reply('Записи на месяц:\n' + list);
    }
  );
});

// Удаление слота по кнопке
bot.hears('❌ Удалить слот', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  db.all(`SELECT id, date, time FROM slots ORDER BY date, time`, [], (err, rows) => {
    if (!rows || rows.length === 0) return ctx.reply('Слотов нет.');
    
    // Группируем слоты по дням
    const groupedByDate = {};
    rows.forEach(r => {
      const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = [];
      }
      groupedByDate[dateKey].push({ id: r.id, time: r.time });
    });
    
    // Создаем кнопки, сгруппированные по дням
    const buttons = [];
    Object.keys(groupedByDate).sort().forEach(date => {
      // Добавляем заголовок дня (неактивная кнопка)
      buttons.push([Markup.button.callback(`📅 ${date}`, 'ignore')]);
      
      // Добавляем кнопки времени для этого дня
      const timeButtons = groupedByDate[date].sort((a, b) => a.time.localeCompare(b.time)).map(slot => 
        Markup.button.callback(`❌ ${slot.time}`, `delete_slot_${slot.id}`)
      );
      
      // Разбиваем кнопки времени на ряды по 3
      for (let i = 0; i < timeButtons.length; i += 3) {
        buttons.push(timeButtons.slice(i, i + 3));
      }
      
      // Добавляем пустую строку между днями
      buttons.push([]);
    });
    
    // Убираем последнюю пустую строку
    if (buttons.length > 0 && buttons[buttons.length - 1].length === 0) {
      buttons.pop();
    }
    
    ctx.reply('Выберите слот для удаления:', Markup.inlineKeyboard(buttons));
  });
});
bot.action(/delete_slot_(\d+)/, (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Нет доступа');
  const slotId = ctx.match[1];
  
  // Сначала получаем информацию о слоте перед удалением
  db.get(`SELECT date, time FROM slots WHERE id=?`, [slotId], (err, slot) => {
    if (!slot) {
      ctx.answerCbQuery('Слот не найден.');
      return ctx.editMessageText('Слот не найден.');
    }
    
    // Удаляем слот
    db.run(`DELETE FROM slots WHERE id=?`, [slotId], function(err) {
      if (this.changes === 0) {
        ctx.answerCbQuery('Ошибка при удалении.');
        return ctx.editMessageText('Ошибка при удалении слота.');
      }
      
      ctx.answerCbQuery('Слот удалён.');
      
      // Показываем информацию об удаленном слоте
      const deletedInfo = `❌ Слот удалён!\n\n📅 Дата: ${formatDateDMY(slot.date)} (${getWeekdayFullRu(slot.date)})\n⏰ Время: ${slot.time}`;
      
      // Предлагаем посмотреть оставшиеся слоты
      ctx.editMessageText(deletedInfo, Markup.inlineKeyboard([
        [Markup.button.callback('📋 Посмотреть оставшиеся слоты', 'show_remaining_slots')],
        [Markup.button.callback('⬅️ Назад к удалению', 'back_to_delete_slots')]
      ]));
    });
  });
});

// Обработчик для просмотра оставшихся слотов
bot.action('show_remaining_slots', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Нет доступа');
  
  db.all(`SELECT date, time FROM slots ORDER BY date, time`, [], (err, rows) => {
    if (!rows || rows.length === 0) {
      ctx.answerCbQuery();
      return ctx.editMessageText('Слотов не осталось.');
    }
    
    // Группируем слоты по дням
    const groupedByDate = {};
    rows.forEach(r => {
      const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = [];
      }
      groupedByDate[dateKey].push(r.time);
    });
    
    const list = Object.keys(groupedByDate).sort().map(date => {
      const timesList = groupedByDate[date].sort().join(', ');
      return `${date}:\n  ${timesList}`;
    }).join('\n\n');
    
    ctx.answerCbQuery();
    ctx.editMessageText(`📋 Оставшиеся слоты:\n\n${list}`, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Назад к удалению', 'back_to_delete_slots')]
    ]));
  });
});

// Обработчик для возврата к удалению слотов
bot.action('back_to_delete_slots', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Нет доступа');
  
  db.all(`SELECT id, date, time FROM slots ORDER BY date, time`, [], (err, rows) => {
    if (!rows || rows.length === 0) {
      ctx.answerCbQuery();
      return ctx.editMessageText('Слотов нет.');
    }
    
    // Группируем слоты по дням
    const groupedByDate = {};
    rows.forEach(r => {
      const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = [];
      }
      groupedByDate[dateKey].push({ id: r.id, time: r.time });
    });
    
    // Создаем кнопки, сгруппированные по дням
    const buttons = [];
    Object.keys(groupedByDate).sort().forEach(date => {
      // Добавляем заголовок дня (неактивная кнопка)
      buttons.push([Markup.button.callback(`📅 ${date}`, 'ignore')]);
      
      // Добавляем кнопки времени для этого дня
      const timeButtons = groupedByDate[date].sort((a, b) => a.time.localeCompare(b.time)).map(slot => 
        Markup.button.callback(`❌ ${slot.time}`, `delete_slot_${slot.id}`)
      );
      
      // Разбиваем кнопки времени на ряды по 3
      for (let i = 0; i < timeButtons.length; i += 3) {
        buttons.push(timeButtons.slice(i, i + 3));
      }
      
      // Добавляем пустую строку между днями
      buttons.push([]);
    });
    
    // Убираем последнюю пустую строку
    if (buttons.length > 0 && buttons[buttons.length - 1].length === 0) {
      buttons.pop();
    }
    
    ctx.answerCbQuery();
    ctx.editMessageText('Выберите слот для удаления:', Markup.inlineKeyboard(buttons));
  });
});

// Добавить слот по кнопке  
bot.hears('➕ Добавить слот', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.scene.enter('addslot');
  });

// Рассылка — запрашиваем текст
let adminBroadcastStep = {};
bot.hears('📢 Рассылка', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminBroadcastStep[ctx.from.id] = true;
  ctx.reply('Введите текст рассылки:', Markup.keyboard([['❌ Отменить рассылку']]).resize());
});

// Отмена рассылки
bot.hears('❌ Отменить рассылку', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminBroadcastStep[ctx.from.id] = false;
  ctx.reply('Рассылка отменена.', Markup.keyboard([
    ['📅 Записи на сегодня', '🟢 Свободные слоты'],
    ['📆 Записи на завтра', '➕ Добавить слот'],
    ['📅 Записи на неделю', '❌ Удалить слот'],
    ['📆 Записи на месяц', '📊 Статистика'],
    ['📢 Рассылка']
  ]).resize());
});

bot.hears('📊 Статистика', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  db.get(`SELECT COUNT(DISTINCT user_id) as users FROM bookings`, [], (err, row1) => {
    db.get(`SELECT COUNT(*) as total FROM bookings WHERE status='confirmed'`, [], (err, row2) => {
      db.get(`SELECT COUNT(*) as free FROM slots WHERE is_booked=0`, [], (err, row3) => {
        ctx.reply(`Статистика:\nПользователей: ${row1.users}\nАктивных записей: ${row2.total}\nСвободных слотов: ${row3.free}`);
      });
    });
  });
});

bot.hears('🟢 Свободные слоты', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    db.all(`SELECT date, time FROM slots WHERE is_booked=0 ORDER BY date, time`, [], (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('Свободных слотов нет.');
      // Группируем слоты по дням
      const groupedByDate = {};
      rows.forEach(r => {
        const dateKey = `${formatDateDMY(r.date)} (${getWeekdayFullRu(r.date)})`;
        if (!groupedByDate[dateKey]) {
          groupedByDate[dateKey] = [];
        }
        groupedByDate[dateKey].push(r.time);
      });
      
      const list = Object.keys(groupedByDate).sort().map(date => {
        const timesList = groupedByDate[date].sort().join(', ');
        return `${date}:\n  ${timesList}`;
      }).join('\n\n');
      
      ctx.reply('Свободные слоты:\n' + list);
    });
  });

bot.hears('📅 Записи на сегодня', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const today = new Date().toISOString().split('T')[0];
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [today],
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('На сегодня записей нет.');
      // Группируем записи по времени
      const groupedByTime = {};
      rows.forEach(r => {
        if (!groupedByTime[r.time]) {
          groupedByTime[r.time] = [];
        }
        groupedByTime[r.time].push(`@${r.username || ''} (${r.full_name || ''})`);
      });
      
      const list = Object.keys(groupedByTime).sort().map(time => 
        `${time}: ${groupedByTime[time].join(', ')}`
      ).join('\n');
      
      ctx.reply(`Записи на сегодня (${formatDateDMY(today)} ${getWeekdayFullRu(today)}):\n${list}`);
    }
  );
});

bot.hears('📆 Записи на завтра', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
  db.all(
    `SELECT b.id, b.user_id, b.username, b.full_name, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [tomorrow],
    (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('На завтра записей нет.');
      // Группируем записи по времени
      const groupedByTime = {};
      rows.forEach(r => {
        if (!groupedByTime[r.time]) {
          groupedByTime[r.time] = [];
        }
        groupedByTime[r.time].push(`@${r.username || ''} (${r.full_name || ''})`);
      });
      
      const list = Object.keys(groupedByTime).sort().map(time => 
        `${time}: ${groupedByTime[time].join(', ')}`
      ).join('\n');
      
      ctx.reply(`Записи на завтра (${formatDateDMY(tomorrow)} ${getWeekdayFullRu(tomorrow)}):\n${list}`);
    }
  );
});



function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function getWeekdayFullRu(dateStr) {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const [y, m, d] = dateStr.split('-');
  const date = new Date(`${y}-${m}-${d}`);
  return days[date.getDay()];
}

// Обработчик текстовых сообщений для рассылки (должен быть в конце)
bot.on('text', (ctx, next) => {
  if (ctx.from.id === ADMIN_ID && adminBroadcastStep[ctx.from.id]) {
    const text = ctx.message.text.trim();
    
    // Проверяем, не является ли сообщение командой или кнопкой отмены
    if (text.startsWith('/') || text.includes('📊') || text.includes('🟢') || text.includes('📆') || text.includes('➕') || text.includes('➖') || text.includes('📢') || text === '❌ Отменить рассылку') {
      // Это команда или кнопка отмены, сбрасываем режим рассылки и передаем управление дальше
      adminBroadcastStep[ctx.from.id] = false;
      return next();
    }
    
    if (!text) {
      ctx.reply('Текст рассылки не может быть пустым.');
      return;
    }
    
    db.all(`SELECT DISTINCT user_id FROM bookings`, [], (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('Нет пользователей для рассылки.');
      rows.forEach(r => {
        bot.telegram.sendMessage(r.user_id, text).catch(() => {});
      });
      ctx.reply('Рассылка отправлена.');
      adminBroadcastStep[ctx.from.id] = false;
    });
    return;
  }
  return next();
});

// Сброс webhook и запуск бота с polling
async function startBot() {
  try {
    // Сначала инициализируем базу данных
    console.log('🔧 Инициализация базы данных...');
    await initDatabase();
    
    // Сбрасываем webhook
    await bot.telegram.deleteWebhook();
    console.log('Webhook сброшен');
    
    // Запускаем бота с polling
    await bot.launch({ polling: true });
    console.log('Бот успешно запущен с polling');
  } catch (error) {
    console.error('Ошибка запуска бота:', error.message);
    if (error.message.includes('409')) {
      console.log('Конфликт с другим экземпляром бота. Повторная попытка через 5 секунд...');
      setTimeout(startBot, 5000);
    } else {
      console.error('Критическая ошибка:', error);
      process.exit(1);
    }
  }
}

// Запускаем бота
startBot();

// Graceful stop
process.once('SIGINT', () => {
  console.log('Получен SIGINT, останавливаем бота...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Получен SIGTERM, останавливаем бота...');
  bot.stop('SIGTERM');
});
