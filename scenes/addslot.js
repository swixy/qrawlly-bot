// scenes/addslot.js
const { Markup } = require('telegraf');
const { WizardScene } = require('telegraf/scenes');
const db = require('../db');
const { logCtx } = require('../logger');

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

function showAdminMenu(ctx) {
  return ctx.reply('Админ-меню:', Markup.keyboard([
    ['📅 Записи на сегодня', '🟢 Свободные слоты'],
    ['📆 Записи на завтра', '➕ Добавить слот'],
    ['📅 Записи на неделю', '❌ Удалить слот'],
    ['📆 Записи на месяц', '📊 Статистика'],
    ['📢 Рассылка']
  ]).resize());
}

// Функция для создания календаря (аналогично booking.js)
function createCalendarKeyboard(year, month, existingDates = []) {
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
    const isPast = dateStr < todayStr;
    const hasSlots = existingDates.includes(dateStr);
    
    let buttonText = String(day);
    let callbackData = 'ignore';
    
    if (!isPast) {
      callbackData = `date_${dateStr}`;
      if (hasSlots) {
        buttonText = `📅${day}`; // Дата с уже добавленными слотами
      }
    } else {
      buttonText = `❌${day}`; // Прошедшие даты
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

// Функция для получения дат с существующими слотами
function getExistingSlotDates() {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT date FROM slots`, [], (err, rows) => {
      if (err || !rows) {
        resolve([]);
        return;
      }
      const existingDates = rows.map(row => row.date);
      resolve(existingDates);
    });
  });
}

const addslotScene = new WizardScene(
  'addslot',
  // Шаг 1: выбор даты через календарь
  async (ctx) => {
    logCtx(ctx, 'admin_addslot_enter');
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    
    const existingDates = await getExistingSlotDates();
    const calendarKeyboard = createCalendarKeyboard(year, month, existingDates);
    
    // Показываем календарь без скрытия меню для админов
    await ctx.reply('Выберите дату для добавления слотов:', calendarKeyboard);
    ctx.wizard.state.data = {};
    return ctx.wizard.next();
  },
  // Шаг 2: обработка выбора даты
  async (ctx) => {
    // Дополнительно позволим выйти текстом
    const text = ctx.message?.text;
    if (text === '❌ Отмена' || text === 'Отмена') {
      logCtx(ctx, 'admin_addslot_cancel_on_date');
      await ctx.reply('Добавление слотов отменено.');
      await showAdminMenu(ctx);
      return ctx.scene.leave();
    }

    if (!ctx.callbackQuery) return;
    
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();
    
    // Обработка навигации по месяцам
    if (action.startsWith('month_')) {
      try {
        const [, year, month] = action.split('_');
        const existingDates = await getExistingSlotDates();
        const calendarKeyboard = createCalendarKeyboard(parseInt(year), parseInt(month), existingDates);
        await ctx.editMessageText('Выберите дату для добавления слотов:', calendarKeyboard);
      } catch (error) {
        console.error('Ошибка при навигации по месяцам:', error);
        await ctx.editMessageText('Произошла ошибка. Попробуйте еще раз.');
      }
      return;
    }
    
    // Обработка кнопки "Назад"
    if (action === 'back_to_main') {
      logCtx(ctx, 'admin_addslot_back_from_date');
      await ctx.editMessageText('Добавление слотов отменено.');
      await showAdminMenu(ctx);
      return ctx.scene.leave();
    }
    
    // Игнорируем другие кнопки
    if (action === 'ignore') {
      return;
    }
    
    // Обработка выбора даты
    if (action.startsWith('date_')) {
      const dateIso = action.replace('date_', '');
      ctx.wizard.state.data.date = dateIso;
      logCtx(ctx, 'admin_addslot_date_selected', { date: dateIso });
      
      // Получаем существующие слоты на эту дату
      db.all(`SELECT time, is_booked FROM slots WHERE date=? ORDER BY time`, [dateIso], (err, rows) => {
        let message = `Выбрана дата: ${formatDateDMY(dateIso)} (${getWeekdayFullRu(dateIso)})\n\n`;
        
        if (rows && rows.length > 0) {
          const bookedSlots = rows.filter(slot => slot.is_booked === 1).map(slot => slot.time);
          const freeSlots = rows.filter(slot => slot.is_booked === 0).map(slot => slot.time);
          
          if (bookedSlots.length > 0) {
            message += `📅 Уже забронированы: ${bookedSlots.join(', ')}\n`;
          }
          if (freeSlots.length > 0) {
            message += `🟢 Свободные слоты: ${freeSlots.join(', ')}\n`;
          }
          message += `\n`;
        } else {
          message += `📝 На эту дату пока нет слотов\n\n`;
        }
        
        message += `Введите одно или несколько времён через пробел (формат HH:MM) или нажмите «❌ Отмена».\n\nПример: 10:00 12:30 15:45`;
        
        ctx.editMessageText(message);
        // Показать клавиатуру для выхода/возврата во время ввода времени
        ctx.reply('Ожидаю время(ена) слотов:', Markup.keyboard([[
          '⬅️ Назад к выбору даты', '❌ Отмена'
        ]]).resize());
        return ctx.wizard.next();
      });
    }
  },
  // Шаг 3: ввод времени
  async (ctx) => {
    const text = ctx.message?.text?.trim();

    // Обработка выхода/возврата
    if (text === '❌ Отмена' || text === 'Отмена') {
      logCtx(ctx, 'admin_addslot_cancel_on_time');
      await ctx.reply('Добавление слотов отменено.', Markup.removeKeyboard());
      await showAdminMenu(ctx);
      return ctx.scene.leave();
    }
    if (text === '⬅️ Назад к выбору даты' || text === 'Назад') {
      logCtx(ctx, 'admin_addslot_back_to_date');
      await ctx.reply('Возврат к выбору даты...', Markup.removeKeyboard());
      await ctx.scene.leave();
      await ctx.scene.enter('addslot');
      return;
    }

    if (!text) {
      return ctx.reply('Пожалуйста, введите время или нажмите «❌ Отмена».');
    }

    const times = text.split(' ').filter(t => /^\d{2}:\d{2}$/.test(t));
    if (times.length === 0) {
      return ctx.reply('Неверный формат. Введите хотя бы одно время в формате HH:MM или нажмите «❌ Отмена».');
    }

    const { date } = ctx.wizard.state.data;
    
    // Проверяем существующие слоты на эту дату
    db.all(`SELECT time FROM slots WHERE date=?`, [date], (err, existingSlots) => {
      if (err) {
        return ctx.reply('Ошибка при проверке существующих слотов.', Markup.removeKeyboard());
      }
      
      const existingTimes = existingSlots.map(slot => slot.time);
      const duplicateTimes = times.filter(time => existingTimes.includes(time));
      const newTimes = times.filter(time => !existingTimes.includes(time));
      
      let message = `Вы собираетесь добавить следующие слоты:\n📅 ${formatDateDMY(date)} (${getWeekdayFullRu(date)})\n\n`;
      
      if (newTimes.length > 0) {
        message += `✅ Новые слоты: ${newTimes.join(', ')}\n`;
      }
      
      if (duplicateTimes.length > 0) {
        message += `⚠️ Уже существуют: ${duplicateTimes.join(', ')}\n`;
      }
      
      if (newTimes.length === 0) {
        const slotText = duplicateTimes.length === 1 ? 'Указанный слот' : 'Указанные слоты';
        const timeText = duplicateTimes.length === 1 ? 'время' : 'времена';
        return ctx.reply(`${slotText} уже существуют. Введите другое ${timeText} или нажмите «❌ Отмена».`);
      }
      
      ctx.wizard.state.data.times = newTimes; // Сохраняем только новые слоты
      logCtx(ctx, 'admin_addslot_times_input', { date, times: newTimes });
      
      message += `\nПодтверждаете?`;
      
      ctx.reply(message, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да', 'confirm'), Markup.button.callback('❌ Отмена', 'cancel')]
      ]));
      return ctx.wizard.next();
    });
  },
  // Шаг 4: подтверждение
  async (ctx) => {
    if (!ctx.callbackQuery) return;

    const action = ctx.callbackQuery.data;
    const { date, times } = ctx.wizard.state.data;

    if (action === 'cancel') {
      await ctx.answerCbQuery();
      logCtx(ctx, 'admin_addslot_cancel_on_confirm');
      await ctx.editMessageText('Добавление отменено.');
      await showAdminMenu(ctx);
      return ctx.scene.leave();
    }

    if (action === 'confirm') {
      await ctx.answerCbQuery();

      let added = 0;
      for (const time of times) {
        await new Promise(resolve => {
          db.run(`INSERT INTO slots (date, time) VALUES (?, ?)`, [date, time], function (err) {
            if (!err) added++;
            resolve();
          });
        });
      }

      logCtx(ctx, 'admin_addslot_confirm', { date, times, added });

      // Получаем все слоты на эту дату после добавления
      db.all(`SELECT time, is_booked FROM slots WHERE date=? ORDER BY time`, [date], (err, rows) => {
        let message = `✅ Добавлено ${added} слотов на ${formatDateDMY(date)} (${getWeekdayFullRu(date)}): ${times.join(', ')}\n\n`;
        message += `📋 Итого на ${formatDateDMY(date)}:\n`;
        
        if (rows && rows.length > 0) {
          const bookedSlots = rows.filter(slot => slot.is_booked === 1).map(slot => slot.time);
          const freeSlots = rows.filter(slot => slot.is_booked === 0).map(slot => slot.time);
          
          if (bookedSlots.length > 0) {
            message += `📅 Забронированы: ${bookedSlots.join(', ')}\n`;
          }
          if (freeSlots.length > 0) {
            message += `🟢 Свободные слоты: ${freeSlots.join(', ')}\n`;
          }
          message += `\nВсего слотов: ${rows.length}`;
        }
        
        ctx.editMessageText(message);
        showAdminMenu(ctx);
        return ctx.scene.leave();
      });
    }
  }
);

module.exports = addslotScene;
