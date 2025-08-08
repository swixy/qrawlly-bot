// Lightweight structured logger for Telegraf context
function safeStr(value, max = 256) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function baseFromCtx(ctx) {
  return {
    ts: new Date().toISOString(),
    chatId: ctx.chat?.id,
    userId: ctx.from?.id,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    updateType: ctx.updateType,
  };
}

function logCtx(ctx, event, extra = {}) {
  const payload = { event, ...baseFromCtx(ctx), ...extra };
  // Single-line JSON for easy ingestion in platform logs
  try {
    console.log('LOG', JSON.stringify(payload));
  } catch {
    console.log('LOG', payload);
  }
}

module.exports = { logCtx, safeStr }; 