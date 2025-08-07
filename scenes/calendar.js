const { Scenes } = require('telegraf');
const bookingScene = new Scenes.BaseScene('booking');

bookingScene.enter((ctx) => {
  const now = new Date();
  ctx.reply('Выберите дату:', generateCalendar(now.getFullYear(), now.getMonth()));
});

// Вместо on('callback_query') — используем action
bookingScene.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bookingScene.action(/^(prev|next)_(\d+)_(\d+)$/, async (ctx) => {
  const [, direction, yearStr, monthStr] = ctx.match;
  let year = parseInt(yearStr);
  let month = parseInt(monthStr);

  if (direction === 'prev') {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  } else {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  await ctx.editMessageReplyMarkup(generateCalendar(year, month).reply_markup);
  await ctx.answerCbQuery();
});

bookingScene.action(/^date_(.+)$/, async (ctx) => {
  const dateIso = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Дата выбрана: ${dateIso}`);
  await showTimes(ctx, dateIso);
  // Если нужно — выход из сцены:
  // await ctx.scene.leave();
});

module.exports = bookingScene;
