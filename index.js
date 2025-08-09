const { Telegraf, session, Scenes, Markup } = require('telegraf');
const cron = require('node-cron');
const { logCtx, safeStr } = require('./logger');
const { getAdmins, isAdmin } = require('./admins');

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is required in production. Set it in Railway Variables or add a Postgres add-on.');
  process.exit(1);
}

// Выбираем базу данных в зависимости от окружения
let db;
if (process.env.DATABASE_URL) {
  // Используем PostgreSQL на Railway
  console.log('🗄️ Используем PostgreSQL базу данных');
  db = require('./db-postgres');
} else {
  // Используем SQLite локально
  console.log('🗄️ Используем SQLite базу данных');
  db = require('./db');
}
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
const ADMINS = getAdmins();
console.log(`👤 Админы: ${ADMINS.join(', ') || 'нет'}`);
console.log(`⏰ Напоминания за ${REMINDER_HOURS} часов`);

// Функция инициализации базы данных
function initDatabase() {
  return new Promise((resolve, reject) => {
    // Инициализируем таблицы только для PostgreSQL
    if (process.env.DATABASE_URL && db.init) {
      db.init().then(() => {
        checkSlots();
      }).catch(reject);
    } else {
      checkSlots();
    }
    
    function checkSlots() {
      // Проверяем, есть ли слоты в базе
      db.get('SELECT COUNT(*) as count FROM slots', [], (err, row) => {
        if (err) {
          console.error('Ошибка проверки базы данных:', err);
          reject(err);
          return;
        }
        
        // Не создаем тестовые слоты автоматически
        if (row.count === 0) {
          console.log('📝 База данных пуста. Добавьте слоты через админское меню (/admin → ➕ Добавить слот)');
        } else {
          console.log(`✅ База данных содержит ${row.count} слотов`);
        }
        resolve();
      });
    }
  });
}

// Создаем экземпляр бота с дополнительными настройками
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    // Отключаем webhook по умолчанию
    webhookReply: false
  }
});

// Global logging middleware
bot.use((ctx, next) => {
  const text = ctx.message?.text;
  const data = ctx.callbackQuery?.data;
  logCtx(ctx, 'update', { text: safeStr(text), action: safeStr(data) });
  return next();
});

// Глобальный обработчик ошибок Telegraf
bot.catch((err, ctx) => {
  console.error('Telegraf error for', ctx.updateType, err);
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

bot.hears('✂️ Записаться на стрижку', (ctx) => {
  logCtx(ctx, 'enter_booking');
  return ctx.scene.enter('booking');
});
bot.hears('📋 Мои записи', (ctx) => {
  logCtx(ctx, 'my_bookings_request');
  db.all(
    `SELECT s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.user_id=? AND b.status='confirmed' ORDER BY s.date, s.time`,
    [ctx.from.id],
    (err, rows) => {
      if (err) {
        logCtx(ctx, 'my_bookings_error', { error: safeStr(err.message) });
        return ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
      if (!rows || rows.length === 0) {
        logCtx(ctx, 'my_bookings_empty');
        return ctx.reply('У вас нет записей.');
      }
      const list = rows.map(r => `📅 ${formatDateDMY(r.date)} ⏰ ${r.time}`).join('\n');
      ctx.reply(`Ваши записи:\n${list}`);
      logCtx(ctx, 'my_bookings_success', { count: rows.length });
    }
  );
});

// Помощь
bot.hears('ℹ️ Помощь', (ctx) => ctx.reply('/start - перезапуск бота\n@streetnoiser - связаться'));

// Админ команды
bot.command('addslot', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Формат: /addslot YYYY-MM-DD HH:MM');
  db.run(`INSERT INTO slots (date,time) VALUES (?,?)`, [args[1], args[2]]);
  ctx.reply(`Слот добавлен: ${args[1]} ${args[2]}`);
});

// Напоминания (каждый час)
cron.schedule('*/10 * * * *', () => {
  const tzOffsetMin = parseInt(process.env.TZ_OFFSET_MINUTES || '0', 10);
  const now = new Date(Date.now() + tzOffsetMin * 60 * 1000);
  const windowStart = now;
  const windowEnd = new Date(now.getTime() + REMINDER_HOURS * 60 * 60 * 1000);
  const y1 = windowStart.getFullYear();
  const m1 = String(windowStart.getMonth() + 1).padStart(2, '0');
  const d1 = String(windowStart.getDate()).padStart(2, '0');
  const y2 = windowEnd.getFullYear();
  const m2 = String(windowEnd.getMonth() + 1).padStart(2, '0');
  const d2 = String(windowEnd.getDate()).padStart(2, '0');
  const t1 = `${String(windowStart.getHours()).padStart(2, '0')}:${String(windowStart.getMinutes()).padStart(2, '0')}`;
  const t2 = `${String(windowEnd.getHours()).padStart(2, '0')}:${String(windowEnd.getMinutes()).padStart(2, '0')}`;

  // Если интервал в пределах одного дня — простой BETWEEN по времени; иначе — два запроса по краям
  const queries = [];
  if (`${y1}-${m1}-${d1}` === `${y2}-${m2}-${d2}`) {
    queries.push({ sql: `SELECT b.id as booking_id, b.user_id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND s.time>=? AND s.time<? AND b.status='confirmed' AND b.reminded_at IS NULL`, params: [`${y1}-${m1}-${d1}`, t1, t2] });
  } else {
    queries.push({ sql: `SELECT b.id as booking_id, b.user_id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND s.time>=? AND b.status='confirmed' AND b.reminded_at IS NULL`, params: [`${y1}-${m1}-${d1}`, t1] });
    queries.push({ sql: `SELECT b.id as booking_id, b.user_id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE s.date=? AND s.time<? AND b.status='confirmed' AND b.reminded_at IS NULL`, params: [`${y2}-${m2}-${d2}`, t2] });
  }

  const sendAndMark = (rows) => {
    rows.forEach(r => {
      const prettyDate = formatDateDMY(r.date);
      bot.telegram.sendMessage(r.user_id, `Напоминание! Ваша стрижка ${prettyDate} в ${r.time}`)
        .then(() => db.run(`UPDATE bookings SET reminded_at=CURRENT_TIMESTAMP WHERE id=?`, [r.booking_id]))
        .catch(() => {});
    });
  };

  // Выполняем очередно все запросы окна
  (async () => {
    for (const q of queries) {
      const result = await db.all(q.sql, q.params);
      if (Array.isArray(result)) sendAndMark(result);
    }
  })();
});

bot.hears('❌ Отменить запись', (ctx) => {
  logCtx(ctx, 'cancel_request_list');
    db.all(
      `SELECT b.id, s.date, s.time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.user_id=? AND b.status='confirmed' ORDER BY s.date, s.time`,
      [ctx.from.id],
      (err, rows) => {
        if (!rows || rows.length === 0) {
          logCtx(ctx, 'cancel_request_empty');
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
  logCtx(ctx, 'cancel_click', { bookingId });
  db.get(
    `SELECT slot_id, date, time FROM bookings b JOIN slots s ON b.slot_id=s.id WHERE b.id=? AND b.user_id=? AND b.status='confirmed'`,
    [bookingId, ctx.from.id],
    (err, booking) => {
      if (!booking) {
        logCtx(ctx, 'cancel_not_found', { bookingId });
        ctx.answerCbQuery();
        return ctx.editMessageText('Запись не найдена или уже отменена.');
      }
      db.run(`UPDATE bookings SET status='cancelled' WHERE id=?`, [bookingId]);
      db.run(`UPDATE slots SET is_booked=0 WHERE id=?`, [booking.slot_id]);
      ctx.answerCbQuery();
      ctx.editMessageText('Запись отменена.');
      logCtx(ctx, 'cancel_success', { bookingId, slotId: booking.slot_id });
      ctx.reply(
        `❌ Запись отменена!\n\n📅 Дата: ${formatDateDMY(booking.date)} (${getWeekdayFullRu(booking.date)})\n⏰ Время: ${booking.time}\n\nВы можете выбрать новую запись.`,
        Markup.keyboard([
          ['✂️ Записаться на стрижку'],
          ['📋 Мои записи', '❌ Отменить запись'],
          ['ℹ️ Помощь']
        ]).resize()
      );
      // Уведомление админу
      ADMINS.forEach((adminId) => ctx.telegram.sendMessage(
        adminId,
        `❌ Отмена записи!\n\n👤 Пользователь: @${ctx.from.username || ''} (${ctx.from.first_name || ''})\n📅 Дата: ${formatDateDMY(booking.date)} (${getWeekdayFullRu(booking.date)})\n⏰ Время: ${booking.time}`
      ));
    }
  );
});

// No-op for read-only inline buttons
bot.action('ignore', (ctx) => {
  try { ctx.answerCbQuery(); } catch {}
});

// === Админ-команды ===

// Показать все записи на сегодня
bot.command('today', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
    db.all(`SELECT date, time FROM slots WHERE is_booked=0 ORDER BY date, time`, [], (err, rows) => {
      if (!rows || rows.length === 0) return ctx.reply('Свободных слотов нет.');
      const list = rows.map(r => `${formatDateDMY(r.date)} ${r.time}`).join('\n');
      ctx.reply('Свободные слоты:\n' + list);
    });
  });
// Добавить слот
  bot.command('addslot', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;  // Проверка админа
    ctx.scene.enter('addslot');
  })

// Удалить слот по дате и времени
bot.command('deleteslot', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Формат: /deleteslot YYYY-MM-DD HH:MM');
  db.run(`DELETE FROM slots WHERE date=? AND time=?`, [args[1], args[2]], function(err) {
    if (this.changes === 0) return ctx.reply('Слот не найден.');
    ctx.reply('Слот удалён.');
  });
});

// Массовая рассылка
bot.command('broadcast', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
  db.all(`SELECT id, date, time FROM slots ORDER BY date, time`, [], (err, rows) => {
  if (err) {
    console.error('Ошибка получения слотов для удаления:', err);
    return ctx.reply('Ошибка при получении слотов.');
  }
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
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
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
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  
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
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');
  
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
    if (!isAdmin(ctx.from.id)) return;
    ctx.scene.enter('addslot');
  });

// Рассылка — запрашиваем текст
let adminBroadcastStep = {};
bot.hears('📢 Рассылка', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  adminBroadcastStep[ctx.from.id] = true;
  ctx.reply('Введите текст рассылки:', Markup.keyboard([['❌ Отменить рассылку']]).resize());
});

// Отмена рассылки
bot.hears('❌ Отменить рассылку', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
  db.get(`SELECT COUNT(DISTINCT user_id) as users FROM bookings`, [], (err, row1) => {
    db.get(`SELECT COUNT(*) as total FROM bookings WHERE status='confirmed'`, [], (err, row2) => {
      db.get(`SELECT COUNT(*) as free FROM slots WHERE is_booked=0`, [], (err, row3) => {
        ctx.reply(`Статистика:\nПользователей: ${row1.users}\nАктивных записей: ${row2.total}\nСвободных слотов: ${row3.free}`);
      });
    });
  });
});

bot.hears('🟢 Свободные слоты', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    db.all(`SELECT date, time FROM slots WHERE is_booked=0 ORDER BY date, time`, [], (err, rows) => {
      if (err) {
        console.error('Ошибка запроса свободных слотов:', err);
        return ctx.reply('Ошибка при получении свободных слотов.');
      }
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

      // Строим инлайн-клавиатуру: заголовок дня и кнопки времени без действий
      const buttons = [];
      Object.keys(groupedByDate).sort().forEach(date => {
        buttons.push([Markup.button.callback(`📅 ${date}`, 'ignore')]);
        const times = groupedByDate[date].sort().map(t => Markup.button.callback(t, 'ignore'));
        for (let i = 0; i < times.length; i += 3) {
          buttons.push(times.slice(i, i + 3));
        }
        buttons.push([]);
      });
      if (buttons.length > 0 && buttons[buttons.length - 1].length === 0) {
        buttons.pop();
      }

      ctx.reply('Свободные слоты:', Markup.inlineKeyboard(buttons));
    });
  });

bot.hears('📅 Записи на сегодня', (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
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
  if (!isAdmin(ctx.from.id)) return;
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



function normalizeDateYMD(dateVal) {
  if (!dateVal) return '';
  if (typeof dateVal === 'string') {
    const s = dateVal.includes('T') ? dateVal.split('T')[0] : dateVal;
    return s;
  }
  if (dateVal instanceof Date) {
    const y = dateVal.getFullYear();
    const m = String(dateVal.getMonth() + 1).padStart(2, '0');
    const d = String(dateVal.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Fallback
  try {
    const d = new Date(dateVal);
    if (!isNaN(d)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    }
  } catch {}
  return String(dateVal);
}

function formatDateDMY(dateStr) {
  const ymd = normalizeDateYMD(dateStr);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

function getWeekdayFullRu(dateStr) {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const ymd = normalizeDateYMD(dateStr);
  const [y, m, d] = ymd.split('-');
  const date = new Date(`${y}-${m}-${d}`);
  return days[date.getDay()];
}

// Обработчик текстовых сообщений для рассылки (должен быть в конце)
bot.on('text', (ctx, next) => {
  if (isAdmin(ctx.from.id) && adminBroadcastStep[ctx.from.id]) {
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
