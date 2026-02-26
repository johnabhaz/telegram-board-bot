import 'reflect-metadata';
import { createConnection, getRepository } from 'typeorm';
import { Ad } from './entities/Ad';
import { Telegraf, Context, session, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import * as dotenv from 'dotenv';

dotenv.config();

// ========== Интерфейсы ==========
interface SessionData {
  step?: 'idle' | 'awaiting_text' | 'awaiting_photo';
  adText?: string;
}

interface MyContext extends Context {
  session: SessionData;
}

// ========== Конфигурация ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN не указан в .env');
}

const bot = new Telegraf<MyContext>(BOT_TOKEN);

// Подключаем сессии
bot.use(session({ defaultSession: (): SessionData => ({ step: 'idle' }) }));

// ========== Функции публикации и модерации ==========

// Прямая публикация (если модерация отключена)
async function publishAd(ctx: MyContext, text: string, photoFileId?: string) {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    await ctx.reply('❌ Ошибка: канал не настроен (CHANNEL_ID отсутствует)');
    return;
  }
  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(channelId, photoFileId, { caption: text });
    } else {
      await bot.telegram.sendMessage(channelId, text);
    }
    await ctx.reply('✅ Ваше объявление опубликовано!');
  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Не удалось опубликовать объявление.');
  }
}

// Отправка на модерацию
async function sendToModeration(ctx: MyContext, text: string, photoFileId?: string) {
  const modGroupId = process.env.MODERATION_GROUP_ID;

  // Сохраняем объявление в БД (если используете)
  const adRepository = getRepository(Ad);
  const ad = new Ad();
  ad.userId = ctx.from!.id;
  ad.text = text;
  ad.photoFileId = photoFileId;
  ad.published = false;
  await adRepository.save(ad);

  // Если группа модерации не задана – публикуем сразу
  if (!modGroupId) {
    return publishAd(ctx, text, photoFileId);
  }

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Ошибка: не удалось определить ваш ID');
    return;
  }

  const caption = `📬 Новое объявление от @${ctx.from?.username || 'пользователь'} (ID: ${userId}):\n\n${text}`;
  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('✅ Одобрить', `approve_${userId}`),
    Markup.button.callback('❌ Отклонить', `reject_${userId}`)
  ]);

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(modGroupId, photoFileId, { caption, ...keyboard });
    } else {
      await bot.telegram.sendMessage(modGroupId, caption, keyboard);
    }
    await ctx.reply('📨 Ваше объявление отправлено на модерацию. Мы уведомим вас о результате.');
  } catch (err) {
    console.error('Ошибка отправки в группу модерации:', err);
    await ctx.reply('❌ Не удалось отправить объявление на модерацию. Попробуйте позже.');
  }
}

// ========== Команды бота ==========

bot.start((ctx) => {
  ctx.reply('Бот работает! Используйте /add для подачи объявления.');
});

bot.command('add', (ctx) => {
  ctx.session.step = 'awaiting_text';
  ctx.reply('Отправьте текст вашего объявления:');
});

bot.command('test_channel', async (ctx) => {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    return ctx.reply('CHANNEL_ID не задан в .env');
  }
  try {
    await bot.telegram.sendMessage(channelId, '🧪 Тестовое сообщение от бота');
    await ctx.reply('✅ Сообщение отправлено в канал');
  } catch (error) {
    console.error(error);
    let errorMessage = 'Неизвестная ошибка';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null && 'description' in error) {
      errorMessage = (error as any).description;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    await ctx.reply(`❌ Ошибка: ${errorMessage}`);
  }
});

// ========== Обработчики сообщений ==========

bot.on(message('text'), async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  switch (ctx.session.step) {
    case 'awaiting_text':
      ctx.session.adText = ctx.message.text;
      ctx.session.step = 'awaiting_photo';
      await ctx.reply('Теперь отправьте фото (или отправьте "пропустить")');
      break;
    case 'awaiting_photo':
      if (ctx.message.text.toLowerCase() === 'пропустить') {
        await sendToModeration(ctx, ctx.session.adText!);
        ctx.session.step = 'idle';
        ctx.session.adText = undefined;
      } else {
        await ctx.reply('Пожалуйста, отправьте фото или напишите "пропустить"');
      }
      break;
    default:
      break;
  }
});

bot.on(message('photo'), async (ctx) => {
  if (ctx.session.step === 'awaiting_photo' && ctx.session.adText) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    await sendToModeration(ctx, ctx.session.adText, photo.file_id);
    ctx.session.step = 'idle';
    ctx.session.adText = undefined;
  } else {
    await ctx.reply('Сначала начните добавление через /add');
  }
});

// ========== Обработка нажатий на кнопки модерации ==========

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) {
    await ctx.answerCbQuery('Это не кнопка с данными');
    return;
  }
  const callbackData = ctx.callbackQuery.data;
  const [action, userIdStr] = callbackData.split('_');
  const userId = parseInt(userIdStr, 10);
  if (isNaN(userId)) {
    await ctx.answerCbQuery('Ошибка данных');
    return;
  }

  const message = ctx.callbackQuery.message;
  if (!message) {
    await ctx.answerCbQuery('Сообщение не найдено');
    return;
  }

  // Извлекаем текст и фото
  let text = '';
  let photoFileId: string | undefined;

  if ('caption' in message && message.caption) {
    text = message.caption.replace(/^📬 Новое объявление от @[^:]+:\n\n/, '');
  } else if ('text' in message && message.text) {
    text = message.text.replace(/^📬 Новое объявление от @[^:]+:\n\n/, '');
  }

  if ('photo' in message && message.photo) {
    photoFileId = message.photo[message.photo.length - 1].file_id;
  }

  try {
    if (action === 'approve') {
      const channelId = process.env.CHANNEL_ID;
      if (!channelId) throw new Error('CHANNEL_ID не задан');

      if (photoFileId) {
        await bot.telegram.sendPhoto(channelId, photoFileId, { caption: text });
      } else {
        await bot.telegram.sendMessage(channelId, text);
      }
      await bot.telegram.sendMessage(userId, '✅ Ваше объявление одобрено и опубликовано!');

      if ('caption' in message) {
        await ctx.editMessageCaption('✅ Одобрено');
      } else {
        await ctx.editMessageText('✅ Одобрено');
      }
    } else if (action === 'reject') {
      await bot.telegram.sendMessage(userId, '❌ Ваше объявление отклонено модератором.');

      if ('caption' in message) {
        await ctx.editMessageCaption('❌ Отклонено');
      } else {
        await ctx.editMessageText('❌ Отклонено');
      }
    }
  } catch (err) {
    console.error('Ошибка обработки модерации:', err);
    await ctx.answerCbQuery('Произошла ошибка');
  }

  await ctx.answerCbQuery();
});

// ========== Подключение к БД и ЗАПУСК (единственный) ==========

createConnection({
  type: 'sqlite',
  database: 'database.sqlite',
  entities: [Ad],
  synchronize: true,
  logging: false
})
  .then(async connection => {
  console.log('База данных подключена');
  console.log('✅ Бот успешно запущен и слушает сообщения');
  await bot.launch();
})
  .catch(error => console.log('Ошибка БД:', error));

// ========== Корректное завершение ==========
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));