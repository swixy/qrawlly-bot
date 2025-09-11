const { Markup } = require('telegraf');
const { WizardScene } = require('telegraf/scenes');
const db = require('../db');
const { logCtx } = require('../logger');
const { getAdmins } = require('../admins');

function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function getWeekdayShortRu(dateStr) {
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const [y, m, d] = dateStr.split('-');
  const date = new Date(`${y}-${m}-${d}`);
  return days[date.getDay()];
}

function getWeekdayFullRu(dateStr) {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const [y, m, d] = dateStr.split('-');
  const date = new Date(`${y}-${m}-${d}`);
  return days[date.getDay()];
}

// Функция для получения доступных дат
function getAvailableDates() {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT date FROM slots WHERE is_booked=0 ORDER BY date`, [], (err, rows) => {
      if (err || !rows) {
        resolve([]);
        return;
      }
      const availableDates = rows.map(row => row.date);
      resolve(availableDates);
    });
  });
}

// Функция для создания горизонтального календаря дат
function createHorizontalDatePicker(availableDates, selectedDate = null) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  
  // Получаем даты на ближайшие 14 дней
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().split('T')[0];
    dates.push(dateStr);
  }
  
  const keyboard = [];
  let currentRow = [];
  
  dates.forEach((dateStr, index) => {
    const isAvailable = availableDates.includes(dateStr);
    const isSelected = selectedDate === dateStr;
    const isToday = dateStr === todayStr;
    const isWeekend = new Date(dateStr).getDay() === 0 || new Date(dateStr).getDay() === 6;
    
    let buttonText = `${getWeekdayShortRu(dateStr)}\n${dateStr.split('-')[2]}`;
    let callbackData = 'ignore';
    
    if (isAvailable) {
      callbackData = `date_${dateStr}`;
      if (isSelected) {
        buttonText = `✅ ${buttonText}`;
      } else if (isToday) {
        buttonText = `📅 ${buttonText}`;
      } else if (isWeekend) {
        buttonText = `🔴 ${buttonText}`;
      } else {
        buttonText = `⚪ ${buttonText}`;
      }
    } else {
      buttonText = `❌ ${buttonText}`;
    }
    
    currentRow.push(Markup.button.callback(buttonText, callbackData));
    
    // Размещаем по 4 даты в ряду
    if (currentRow.length === 4 || index === dates.length - 1) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  
  return Markup.inlineKeyboard(keyboard);
}

// Функция для группировки времени по периодам
function groupTimeByPeriods(times) {
  const periods = {
    'Утро': [],
    'День': [],
    'Вечер': []
  };
  
  times.forEach(time => {
    const hour = parseInt(time.split(':')[0]);
    if (hour >= 6 && hour < 12) {
      periods['Утро'].push(time);
    } else if (hour >= 12 && hour < 18) {
      periods['День'].push(time);
    } else {
      periods['Вечер'].push(time);
    }
  });
  
  return periods;
}

// Функция для создания клавиатуры времени
function createTimeKeyboard(times, selectedTime = null) {
  const periods = groupTimeByPeriods(times);
  const keyboard = [];
  
  Object.keys(periods).forEach(period => {
    if (periods[period].length > 0) {
      // Заголовок периода
      keyboard.push([Markup.button.callback(`🕐 ${period}`, 'ignore')]);
      
      // Кнопки времени для этого периода
      const timeButtons = periods[period].map(time => {
        const isSelected = selectedTime === time;
        const buttonText = isSelected ? `✅ ${time}` : time;
        return Markup.button.callback(buttonText, `time_${time}`);
      });
      
      // Размещаем по 3 времени в ряду
      for (let i = 0; i < timeButtons.length; i += 3) {
        keyboard.push(timeButtons.slice(i, i + 3));
      }
      
      // Пустая строка между периодами
      keyboard.push([]);
    }
  });
  
  // Убираем последнюю пустую строку
  if (keyboard.length > 0 && keyboard[keyboard.length - 1].length === 0) {
    keyboard.pop();
  }
  
  return Markup.inlineKeyboard(keyboard);
}

const modernBookingScene = new WizardScene(
  'modern-booking',
  // Шаг 1: выбор даты
  async (ctx) => {
    const availableDates = await getAvailableDates();
    
    if (availableDates.length === 0) {
      await ctx.reply('😔 К сожалению, свободных слотов нет.\n\nОбратитесь к администратору для добавления новых слотов.', 
        Markup.keyboard([['🏠 Главное меню']]).resize());
      return ctx.scene.leave();
    }
    
    const dateKeyboard = createHorizontalDatePicker(availableDates);
    
    await ctx.reply('📅 Выберите дату и время', 
      Markup.keyboard([['🏠 Главное меню', 'ℹ️ Помощь']]).resize());
    
    // Добавляем Web App кнопку
    const webAppUrl = process.env.WEBAPP_URL || 'https://gallant-perception-production.up.railway.app';
    await ctx.reply('Или откройте приложение для записи:', Markup.inlineKeyboard([
      Markup.button.webApp('📱 Открыть приложение', webAppUrl)
    ]));
    
    await ctx.reply('🗓️ Выберите дату:', dateKeyboard);
    
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
    
    // Игнорируем неактивные кнопки
    if (action === 'ignore') {
      return;
    }
    
    // Обработка выбора даты
    if (action.startsWith('date_')) {
      const dateIso = action.replace('date_', '');
      ctx.wizard.state.data.date = dateIso;
      
      // Получаем доступное время для выбранной даты
      db.all(`SELECT time FROM slots WHERE date=? AND is_booked=0 ORDER BY time`, [dateIso], (err, rows) => {
        if (err || !rows || rows.length === 0) {
          ctx.editMessageText(`😔 На ${formatDateDMY(dateIso)} нет свободных слотов.\n\nВыберите другую дату.`);
          return;
        }
        
        const times = rows.map(row => row.time);
        const timeKeyboard = createTimeKeyboard(times);
        
        const weekday = getWeekdayFullRu(dateIso);
        const isWeekend = new Date(dateIso).getDay() === 0 || new Date(dateIso).getDay() === 6;
        const dateEmoji = isWeekend ? '🔴' : '📅';
        
        ctx.editMessageText(
          `${dateEmoji} Выбрана дата: ${formatDateDMY(dateIso)} (${weekday})\n\n⏰ Выберите время:`,
          timeKeyboard
        );
        
        return ctx.wizard.next();
      });
    }
  },
  
  // Шаг 3: обработка выбора времени
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
    
    // Игнорируем неактивные кнопки
    if (action === 'ignore') {
      return;
    }
    
    // Выбор времени
    if (action.startsWith('time_')) {
      const time = action.replace('time_', '');
      const { date } = ctx.wizard.state.data;
      
      ctx.wizard.state.data.time = time;
      
      const weekday = getWeekdayFullRu(date);
      const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
      const dateEmoji = isWeekend ? '🔴' : '📅';
      
      await ctx.editMessageText(
        `✅ Подтверждение записи\n\n${dateEmoji} Дата: ${formatDateDMY(date)} (${weekday})\n⏰ Время: ${time}\n\nПодтверждаете запись?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Подтвердить', 'confirm'), Markup.button.callback('❌ Отменить', 'cancel')],
          [Markup.button.callback('⬅️ Выбрать другое время', 'back_to_time')]
        ])
      );
      
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
    
    // Ожидание нажатия на кнопку
  }
);

// Обработчики действий
modernBookingScene.action('confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const { date, time } = ctx.wizard.state.data;
  const user = ctx.from;
  
  logCtx(ctx, 'modern_booking_confirm_click', { date, time });
  
  db.get(`SELECT id FROM slots WHERE date=? AND time=? AND is_booked=0`, [date, time], (err, slot) => {
    if (!slot) {
      logCtx(ctx, 'modern_booking_confirm_slot_taken', { date, time });
      ctx.editMessageText('😔 Этот слот уже занят. Выберите другое время.');
      
      // Возвращаемся к выбору времени
      db.all(`SELECT time FROM slots WHERE date=? AND is_booked=0 ORDER BY time`, [date], (err, rows) => {
        if (rows && rows.length > 0) {
          const times = rows.map(row => row.time);
          const timeKeyboard = createTimeKeyboard(times);
          const weekday = getWeekdayFullRu(date);
          const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
          const dateEmoji = isWeekend ? '🔴' : '📅';
          
          ctx.reply(
            `${dateEmoji} Выбрана дата: ${formatDateDMY(date)} (${weekday})\n\n⏰ Выберите время:`,
            timeKeyboard
          );
        }
      });
      return;
    }
    
    // Бронируем слот
    db.run(`UPDATE slots SET is_booked=1 WHERE id=?`, [slot.id]);
    db.run(`INSERT INTO bookings (user_id, username, full_name, slot_id, created_at, status) VALUES (?,?,?,?,datetime('now'),'confirmed')`,
      [user.id, user.username || '', user.first_name || '', slot.id]);
    
    logCtx(ctx, 'modern_booking_confirm_success', { slotId: slot.id, date, time });
    
    const weekday = getWeekdayFullRu(date);
    const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
    const dateEmoji = isWeekend ? '🔴' : '📅';
    
    ctx.editMessageText(
      `🎉 Запись подтверждена!\n\n${dateEmoji} Дата: ${formatDateDMY(date)} (${weekday})\n⏰ Время: ${time}\n\n📱 Вы получите напоминание за 2 часа до записи.`
    );
    
    // Уведомление админам
    const ADMINS = getAdmins();
    ADMINS.forEach((adminId) => {
      ctx.telegram.sendMessage(adminId,
        `📝 Новая запись!\n\n👤 Пользователь: ${user.first_name} @${user.username || ''}\n${dateEmoji} Дата: ${formatDateDMY(date)} (${weekday})\n⏰ Время: ${time}`
      ).catch(() => {});
    });
    
    ctx.reply('Выберите действие:', Markup.keyboard([
      ['✂️ Записаться на стрижку'],
      ['📋 Мои записи', '❌ Отменить запись'],
      ['ℹ️ Помощь']
    ]).resize());
    
    return ctx.scene.leave();
  });
});

modernBookingScene.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  logCtx(ctx, 'modern_booking_cancel_click');
  
  ctx.editMessageText('❌ Запись отменена.');
  ctx.reply('Выберите действие:', Markup.keyboard([
    ['✂️ Записаться на стрижку'],
    ['📋 Мои записи', '❌ Отменить запись'],
    ['ℹ️ Помощь']
  ]).resize());
  
  return ctx.scene.leave();
});

modernBookingScene.action('back_to_time', async (ctx) => {
  await ctx.answerCbQuery();
  const { date } = ctx.wizard.state.data;
  
  // Возвращаемся к выбору времени
  db.all(`SELECT time FROM slots WHERE date=? AND is_booked=0 ORDER BY time`, [date], (err, rows) => {
    if (rows && rows.length > 0) {
      const times = rows.map(row => row.time);
      const timeKeyboard = createTimeKeyboard(times);
      const weekday = getWeekdayFullRu(date);
      const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
      const dateEmoji = isWeekend ? '🔴' : '📅';
      
      ctx.editMessageText(
        `${dateEmoji} Выбрана дата: ${formatDateDMY(date)} (${weekday})\n\n⏰ Выберите время:`,
        timeKeyboard
      );
    }
  });
  
  return ctx.wizard.back();
});

module.exports = modernBookingScene;
