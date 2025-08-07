const { Markup } = require('telegraf');
const { WizardScene } = require('telegraf/scenes');
const db = require('../db');

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

// Функция для создания календаря
function createCalendarKeyboard(year, month, availableDates = []) {
  // Проверяем корректность параметров
  if (typeof year !== 'number' || typeof month !== 'number' || month < 0 || month > 11) {
    throw new Error('Некорректные параметры календаря');
  }
  
  const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 
                     'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  
  const keyboard = [];
  
  // Заголовок с месяцем и годом
  keyboard.push([Markup.button.callback(`${monthNames[month]} ${year}`, 'ignore')]);
  
  // Дни недели
  keyboard.push([
    Markup.button.callback('Пн', 'ignore'),
    Markup.button.callback('Вт', 'ignore'),
    Markup.button.callback('Ср', 'ignore'),
    Markup.button.callback('Чт', 'ignore'),
    Markup.button.callback('Пт', 'ignore'),
    Markup.button.callback('Сб', 'ignore'),
    Markup.button.callback('Вс', 'ignore')
  ]);
  
  // Получаем первый день месяца и количество дней
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startWeekday = firstDay.getDay() || 7; // 1 = понедельник, 7 = воскресенье
  
  let currentRow = [];
  
  // Добавляем пустые ячейки до первого дня месяца
  for (let i = 1; i < startWeekday; i++) {
    currentRow.push(Markup.button.callback(' ', 'ignore'));
  }
  
  // Добавляем дни месяца
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const isAvailable = availableDates.includes(dateStr);
    const isPast = dateStr < todayStr;
    
    let buttonText = String(day);
    let callbackData = 'ignore';
    
    if (isAvailable && !isPast) {
      callbackData = `date_${dateStr}`;
    } else {
      buttonText = `❌${day}`; // И прошедшие, и недоступные даты
    }
    
    currentRow.push(Markup.button.callback(buttonText, callbackData));
    
    if (currentRow.length === 7) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  }
  
  // Добавляем оставшиеся дни в последнюю строку
  if (currentRow.length > 0) {
    while (currentRow.length < 7) {
      currentRow.push(Markup.button.callback(' ', 'ignore'));
    }
    keyboard.push(currentRow);
  }
  
  // Навигация по месяцам
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  
  keyboard.push([
    Markup.button.callback('◀️', `month_${prevYear}_${prevMonth}`),
    Markup.button.callback('▶️', `month_${nextYear}_${nextMonth}`)
  ]);
  
  // Кнопка назад
  keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')]);
  
  return Markup.inlineKeyboard(keyboard);
}

// Функция для получения доступных дат
function getAvailableDates() {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT date FROM slots WHERE is_booked=0`, [], (err, rows) => {
      if (err || !rows) {
        resolve([]);
        return;
      }
      const availableDates = rows.map(row => row.date);
      resolve(availableDates);
    });
  });
}

const bookingScene = new WizardScene(
  'booking',
  // Шаг 1: выбор даты через календарь
  async (ctx) => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    
    const availableDates = await getAvailableDates();
    const calendarKeyboard = createCalendarKeyboard(year, month, availableDates);
    
    // Показываем календарь с кнопками возврата в главное меню и помощи
    await ctx.reply('Выберите дату:', Markup.keyboard([['🏠 Главное меню', 'ℹ️ Помощь']]).resize());
    await ctx.reply('Выберите дату:', calendarKeyboard);
    ctx.wizard.state.data = {};
    return ctx.wizard.next();
  },
  // Шаг 2: обработка выбора даты и показ времени
  async (ctx) => {
    // Обработка кнопки "Главное меню"
    if (ctx.message && ctx.message.text === '🏠 Главное меню') {
      await ctx.reply('Выберите действие:', Markup.keyboard([
        ['✂️ Записаться на стрижку'],
        ['📋 Мои записи', '❌ Отменить запись'],
        ['ℹ️ Помощь']
      ]).resize());
      return ctx.scene.leave();
    }
    
    // Обработка кнопки "Помощь"
    if (ctx.message && ctx.message.text === 'ℹ️ Помощь') {
      await ctx.reply('@streetnoiser - связаться');
      return;
    }
    
    if (!ctx.callbackQuery) return;
    
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();
    
    // Обработка навигации по месяцам
    if (action.startsWith('month_')) {
      try {
        const [, year, month] = action.split('_');
        const availableDates = await getAvailableDates();
        const calendarKeyboard = createCalendarKeyboard(parseInt(year), parseInt(month), availableDates);
        await ctx.editMessageText('Выберите дату:', calendarKeyboard);
      } catch (error) {
        console.error('Ошибка при навигации по месяцам:', error);
        await ctx.editMessageText('Произошла ошибка. Попробуйте еще раз.');
      }
      return;
    }
    

    
    // Обработка кнопки "Назад"
    if (action === 'back_to_main') {
      await ctx.editMessageText('Выберите действие:');
      await ctx.reply('Выберите действие:', Markup.keyboard([
        ['✂️ Записаться на стрижку'],
        ['📋 Мои записи', '❌ Отменить запись'],
        ['ℹ️ Помощь']
      ]).resize());
      return ctx.scene.leave();
    }
    
    // Игнорируем другие кнопки
    if (action === 'ignore') {
      return;
    }
    
    // Обработка выбора даты
    if (action.startsWith('date_')) {
      const dateIso = action.replace('date_', '');
      // Очищаем предыдущее состояние и устанавливаем новую дату
      ctx.wizard.state.data = { date: dateIso };
      
      // Показываем доступное время
      db.all(`SELECT time FROM slots WHERE date=? AND is_booked=0 ORDER BY time`, [dateIso], (err, rows) => {
        if (rows.length === 0) {
          ctx.editMessageText(`На ${formatDateDMY(dateIso)} нет свободных слотов. Выберите другую дату.`);
          return;
        }
        
        const timeButtons = rows.map(r => [Markup.button.callback(r.time, `time_${r.time}`)]);
        timeButtons.push([Markup.button.callback('⬅️ Назад к календарю', 'back_to_calendar')]);
        
        ctx.editMessageText(`Выбрана дата: ${formatDateDMY(dateIso)} (${getWeekdayFullRu(dateIso)})\nВыберите время:`, 
          Markup.inlineKeyboard(timeButtons));
        return ctx.wizard.next();
      });
    }
  },
  // Шаг 3: обработка выбора времени и подтверждение
  async (ctx) => {
    // Обработка кнопки "Главное меню"
    if (ctx.message && ctx.message.text === '🏠 Главное меню') {
      await ctx.reply('Выберите действие:', Markup.keyboard([
        ['✂️ Записаться на стрижку'],
        ['📋 Мои записи', '❌ Отменить запись'],
        ['ℹ️ Помощь']
      ]).resize());
      return ctx.scene.leave();
    }
    
    // Обработка кнопки "Помощь"
    if (ctx.message && ctx.message.text === 'ℹ️ Помощь') {
      await ctx.reply('@streetnoiser - связаться');
      return;
    }
    
    if (!ctx.callbackQuery) return;
    
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();
    
    // Возврат к календарю
    if (action === 'back_to_calendar') {
      // Перезапускаем сцену полностью
      await ctx.scene.leave();
      await ctx.scene.enter('booking');
      return;
    }
    
    // Выбор времени
    if (action.startsWith('time_')) {
      const time = action.replace('time_', '');
      ctx.wizard.state.data.time = time;
      const { date } = ctx.wizard.state.data;
      
      await ctx.editMessageText(`Вы выбрали ${formatDateDMY(date)} в ${time}. Подтверждаете?`, 
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да', 'confirm'), Markup.button.callback('❌ Нет', 'cancel')]
        ]));
      return ctx.wizard.next();
    }
  },
  // Шаг 4: ожидание подтверждения
  async (ctx) => {
    // Обработка кнопки "Главное меню"
    if (ctx.message && ctx.message.text === '🏠 Главное меню') {
      await ctx.reply('Выберите действие:', Markup.keyboard([
        ['✂️ Записаться на стрижку'],
        ['📋 Мои записи', '❌ Отменить запись'],
        ['ℹ️ Помощь']
      ]).resize());
      return ctx.scene.leave();
    }
    
    // Обработка кнопки "Помощь"
    if (ctx.message && ctx.message.text === 'ℹ️ Помощь') {
      await ctx.reply('@streetnoiser - связаться');
      return;
    }
    
    // Ожидание нажатия на кнопку, ничего не делаем
  }
);

bookingScene.action('confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const { date, time } = ctx.wizard.state.data;
  const user = ctx.from;
  db.get(`SELECT id FROM slots WHERE date=? AND time=? AND is_booked=0`, [date, time], (err, slot) => {
    if (!slot) {
      ctx.editMessageText('Этот слот уже занят.');
      ctx.reply('Выберите действие:', Markup.keyboard([
        ['✂️ Записаться на стрижку'],
        ['📋 Мои записи', '❌ Отменить запись'],
        ['ℹ️ Помощь']
      ]).resize());
      return ctx.scene.leave();
    }
    db.run(`UPDATE slots SET is_booked=1 WHERE id=?`, [slot.id]);
    db.run(`INSERT INTO bookings (user_id, username, full_name, slot_id, created_at, status) VALUES (?,?,?,?,datetime('now'),'confirmed')`,
      [user.id, user.username || '', user.first_name || '', slot.id]);
    ctx.editMessageText(`✅ Запись подтверждена!\n\n📅 Дата: ${formatDateDMY(date)} (${getWeekdayFullRu(date)})\n⏰ Время: ${time}`);
    ctx.telegram.sendMessage(process.env.ADMIN_ID || require('../config').ADMIN_ID,
      `Новая запись: ${user.first_name} @${user.username}\n${formatDateDMY(date)} ${time}`);
    ctx.reply('Выберите действие:', Markup.keyboard([
      ['✂️ Записаться на стрижку'],
      ['📋 Мои записи', '❌ Отменить запись'],
      ['ℹ️ Помощь']
    ]).resize());
    return ctx.scene.leave();
  });
});

bookingScene.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Запись отменена.');
  await ctx.reply('Выберите действие:', Markup.keyboard([
    ['✂️ Записаться на стрижку'],
    ['📋 Мои записи', '❌ Отменить запись'],
    ['ℹ️ Помощь']
  ]).resize());
  return ctx.scene.leave();
});

module.exports = bookingScene;
