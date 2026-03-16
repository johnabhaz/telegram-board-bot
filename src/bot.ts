import 'reflect-metadata';
import { createConnection, getRepository } from 'typeorm';
import { Ad } from './entities/Ad';
import { Category } from './entities/Category';
import { Telegraf, Context, session, Markup } from 'telegraf';
import { message as tgMessage } from 'telegraf/filters'; // переименовываем импорт, чтобы избежать конфликта имён
import * as dotenv from 'dotenv';

dotenv.config();
console.log('=== ДИАГНОСТИКА: Все переменные окружения ===');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN);
console.log('CHANNEL_ID:', process.env.CHANNEL_ID);
console.log('MODERATION_GROUP_ID:', process.env.MODERATION_GROUP_ID);
console.log('ADMIN_ID:', process.env.ADMIN_ID);
console.log('============================================');

// ========== Интерфейсы ==========
interface PhotoAccumulator {
  photos: { fileId: string; fileUniqueId: string }[];
  timeout: NodeJS.Timeout | null;
  userId: number;
  categoryId: number;
  adText: string;
  ctx: MyContext;
}

const photoAccumulators: Record<string, PhotoAccumulator> = {};

interface SessionData {
  step?: 'idle' | 'awaiting_category' | 'awaiting_text' | 'awaiting_photo';
  adText?: string;
  categoryId?: number;
  accumulatorMediaGroupId?: string; // ID текущего альбома
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

bot.use(session({ defaultSession: (): SessionData => ({ step: 'idle' }) }));

// ========== Функции ==========

// Прямая публикация
async function publishAd(ctx: MyContext, text: string, photoFileIds?: string[]) {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    await ctx.reply('❌ Ошибка: канал не настроен (CHANNEL_ID отсутствует)');
    return;
  }
  try {
    if (photoFileIds && photoFileIds.length > 0) {
      const mediaGroup = photoFileIds.map((fileId, index) => ({
        type: 'photo' as const,
        media: fileId,
        ...(index === 0 ? { caption: text } : {}),
      }));
      await bot.telegram.sendMediaGroup(channelId, mediaGroup);
    } else {
      await bot.telegram.sendMessage(channelId, text);
    }
    await ctx.reply('✅ Ваше объявление опубликовано!');
  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Не удалось опубликовать объявление.');
  }
}

// Отправка на модерацию (одно фото)
async function sendToModeration(ctx: MyContext, text: string, categoryId: number, photoFileId?: string) {
  const modGroupId = process.env.MODERATION_GROUP_ID;
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Ошибка: не удалось определить ваш ID');
    return;
  }

  if (!modGroupId) {
    const adRepository = getRepository(Ad);
    const ad = new Ad();
    ad.userId = userId;
    ad.text = text;
    ad.photoFileIds = photoFileId ? [photoFileId] : [];
    ad.status = 'approved';
    ad.categoryId = categoryId;
    await adRepository.save(ad);
    return publishAd(ctx, text, photoFileId ? [photoFileId] : []);
  }

  const categoryRepository = getRepository(Category);
  const category = await categoryRepository.findOne({ where: { id: categoryId } });
  const categoryName = category ? category.name : 'без категории';

  const adRepository = getRepository(Ad);
  const ad = new Ad();
  ad.userId = userId;
  ad.text = text;
  ad.photoFileIds = photoFileId ? [photoFileId] : [];
  ad.status = 'moderation';
  ad.categoryId = categoryId;
  await adRepository.save(ad);

  const caption = `📬 Новое объявление от @${ctx.from?.username || 'пользователь'} (ID: ${userId})\n🏷️ Категория: ${categoryName}\n\n${text}`;
  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('✅ Одобрить', `approve_${ad.id}`),
    Markup.button.callback('❌ Отклонить', `reject_${ad.id}`)
  ]);

  try {
    let sentMessage;
    if (photoFileId) {
      sentMessage = await bot.telegram.sendPhoto(modGroupId, photoFileId, {
        caption,
        ...keyboard
      });
    } else {
      sentMessage = await bot.telegram.sendMessage(modGroupId, caption, keyboard);
    }

    ad.moderationMessageId = sentMessage.message_id;
    await adRepository.save(ad);
    await ctx.reply('📨 Ваше объявление отправлено на модерацию. Мы уведомим вас о результате.');
  } catch (err) {
    console.error('Ошибка отправки в группу модерации:', err);
    await ctx.reply('❌ Не удалось отправить объявление на модерацию. Попробуйте позже.');
  }
}

// Отправка на модерацию нескольких фото
async function sendToModerationMultiplePhotos(
  ctx: MyContext,
  text: string,
  categoryId: number,
  photoFileIds: string[]
) {
  const modGroupId = process.env.MODERATION_GROUP_ID;
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Ошибка: не удалось определить ваш ID');
    return;
  }

  const categoryRepository = getRepository(Category);
  const category = await categoryRepository.findOne({ where: { id: categoryId } });
  const categoryName = category ? category.name : 'без категории';

  const adRepository = getRepository(Ad);
  const ad = new Ad();
  ad.userId = userId;
  ad.text = text;
  ad.photoFileIds = photoFileIds;
  ad.status = 'moderation';
  ad.categoryId = categoryId;
  await adRepository.save(ad);

  if (!modGroupId) {
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) {
      await ctx.reply('❌ Канал не настроен');
      return;
    }

    const mediaGroup = photoFileIds.map((fileId, index) => ({
      type: 'photo' as const,
      media: fileId,
      ...(index === 0 ? { caption: text } : {}),
    }));

    try {
      await ctx.telegram.sendMediaGroup(channelId, mediaGroup);
      ad.status = 'approved';
      await adRepository.save(ad);
      await ctx.reply('✅ Ваше объявление опубликовано!');
    } catch (err) {
      console.error('Ошибка публикации в канал:', err);
      await ctx.reply('❌ Не удалось опубликовать объявление.');
    }
    return;
  }

  const mediaGroup = photoFileIds.map((fileId, index) => ({
    type: 'photo' as const,
    media: fileId,
    ...(index === 0
      ? {
          caption: `📬 Новое объявление от @${ctx.from?.username || 'пользователь'} (ID: ${userId})\n🏷️ Категория: ${categoryName}\n\n${text}`,
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ Одобрить', `approve_${ad.id}`),
            Markup.button.callback('❌ Отклонить', `reject_${ad.id}`),
          ]).reply_markup,
        }
      : {}),
  }));

  try {
    const sentMessages = await ctx.telegram.sendMediaGroup(modGroupId, mediaGroup);
    if (sentMessages.length > 0) {
      ad.moderationMessageId = sentMessages[0].message_id;
      await adRepository.save(ad);
    }
    await ctx.reply('📨 Ваше объявление отправлено на модерацию. Мы уведомим вас о результате.');
  } catch (err) {
    console.error('Ошибка отправки в группу модерации:', err);
    await ctx.reply('❌ Не удалось отправить объявление на модерацию. Попробуйте позже.');
  }
}

// ========== Команды ==========

bot.start((ctx) => {
  ctx.reply('Бот работает! Используйте /add для подачи объявления.');
});

bot.command('myads', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    return ctx.reply('Не удалось определить ваш ID');
  }

  try {
    const adRepository = getRepository(Ad);
    const ads = await adRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: ['category']
    });

    if (ads.length === 0) {
      return ctx.reply('📭 У вас пока нет объявлений.');
    }

    let message = '📋 **Ваши объявления:**\n\n';
    const statusEmoji = {
      moderation: '⏳ На модерации',
      approved: '✅ Опубликовано',
      rejected: '❌ Отклонено'
    };

    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i];
      const date = new Date(ad.createdAt).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const status = statusEmoji[ad.status as keyof typeof statusEmoji] || '❓ Неизвестно';
      const shortText = ad.text.length > 50 ? ad.text.substring(0, 47) + '…' : ad.text;
      const categoryName = ad.category ? ad.category.name : 'Без категории';
      const photoCount = ad.photoFileIds ? ad.photoFileIds.length : 0;

      message += `${i + 1}. ${status}\n   📝 ${shortText}\n   🏷️ Категория: ${categoryName}\n   🕒 ${date}\n`;
      message += `   📷 Фото: ${photoCount}\n`;
      message += '\n';
    }

    if (message.length > 4096) {
      const parts = message.match(/(.|[\r\n]){1,4096}/g) || [];
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Ошибка в /myads:', error);
    await ctx.reply('❌ Произошла ошибка при получении списка объявлений.');
  }
});

bot.command('add', async (ctx) => {
  // Очищаем старый аккумулятор, если был
  if (ctx.session.accumulatorMediaGroupId) {
    delete photoAccumulators[ctx.session.accumulatorMediaGroupId];
    ctx.session.accumulatorMediaGroupId = undefined;
  }

  const categoryRepository = getRepository(Category);
  const categories = await categoryRepository.find();
  if (categories.length === 0) {
    return ctx.reply('❌ Категории временно недоступны. Попробуйте позже.');
  }

  const buttons = categories.map(cat =>
    Markup.button.callback(cat.name, `cat_${cat.id}`)
  );
  const keyboard = Markup.inlineKeyboard(buttons, { columns: 2 });

  await ctx.reply('📂 Выберите категорию:', keyboard);
  ctx.session.step = 'awaiting_category';
});

bot.command('webapp', (ctx) => {
  ctx.reply('Открыть доску объявлений', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Открыть приложение', web_app: { url: 'https://johnabhaz.github.io/telegram-board-webapp/' } }]
      ]
    }
  });
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

bot.on(tgMessage('text'), async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  switch (ctx.session.step) {
    case 'awaiting_text':
      ctx.session.adText = ctx.message.text;
      ctx.session.step = 'awaiting_photo';
      await ctx.reply('Теперь отправьте фото (или отправьте "пропустить")');
      break;
    case 'awaiting_photo':
      if (ctx.message.text.toLowerCase() === 'пропустить') {
        await sendToModeration(ctx, ctx.session.adText!, ctx.session.categoryId!);
        ctx.session.step = 'idle';
        ctx.session.adText = undefined;
        ctx.session.categoryId = undefined;
      } else {
        await ctx.reply('Пожалуйста, отправьте фото или напишите "пропустить"');
      }
      break;
    default:
      break;
  }
});

bot.on(tgMessage('photo'), async (ctx) => {
  if (ctx.session.step === 'awaiting_photo' && ctx.session.adText && ctx.session.categoryId) {
    const mediaGroupId = ctx.message.media_group_id;
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const userId = ctx.from?.id;
    const currentPhotoData = { fileId: photo.file_id, fileUniqueId: photo.file_unique_id };

    if (!userId) {
      await ctx.reply('Ошибка идентификации пользователя.');
      return;
    }

    // Одиночное фото (не альбом)
    if (!mediaGroupId) {
      console.log('📷 Получено одно фото');
      await sendToModerationMultiplePhotos(ctx, ctx.session.adText, ctx.session.categoryId, [photo.file_id]);
      ctx.session.step = 'idle';
      ctx.session.adText = undefined;
      ctx.session.categoryId = undefined;
      return;
    }

    // Работа с альбомом
    // Если это первое фото в новом альбоме
    if (!ctx.session.accumulatorMediaGroupId) {
      ctx.session.accumulatorMediaGroupId = mediaGroupId;
      photoAccumulators[mediaGroupId] = {
        photos: [currentPhotoData],
        userId,
        categoryId: ctx.session.categoryId,
        adText: ctx.session.adText,
        ctx,
        timeout: null,
      };
      await ctx.reply('📸 Фото добавляются. Нажмите кнопку, когда закончите.', {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('✅ Завершить загрузку', 'finish_upload')
        ]).reply_markup
      });
    }
    // Если это продолжение того же альбома
    else if (ctx.session.accumulatorMediaGroupId === mediaGroupId) {
      const accumulator = photoAccumulators[mediaGroupId];
      if (accumulator) {
        if (!accumulator.photos.some(p => p.fileUniqueId === currentPhotoData.fileUniqueId)) {
          accumulator.photos.push(currentPhotoData);
          console.log(`📷 Добавлено фото ${accumulator.photos.length} в группу ${mediaGroupId}`);
        }
      } else {
        // Восстанавливаем аккумулятор (на случай сбоя)
        photoAccumulators[mediaGroupId] = {
          photos: [currentPhotoData],
          userId,
          categoryId: ctx.session.categoryId,
          adText: ctx.session.adText,
          ctx,
          timeout: null,
        };
      }
    }
    // Если пришло фото с другим media_group_id – сбрасываем предыдущий сбор
    else {
      const oldGroupId = ctx.session.accumulatorMediaGroupId;
      if (oldGroupId && photoAccumulators[oldGroupId]) {
        delete photoAccumulators[oldGroupId];
      }
      // Начинаем новый сбор
      ctx.session.accumulatorMediaGroupId = mediaGroupId;
      photoAccumulators[mediaGroupId] = {
        photos: [currentPhotoData],
        userId,
        categoryId: ctx.session.categoryId,
        adText: ctx.session.adText,
        ctx,
        timeout: null,
      };
      await ctx.reply('📸 Начат новый альбом. Нажмите кнопку, когда закончите.', {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('✅ Завершить загрузку', 'finish_upload')
        ]).reply_markup
      });
    }
  } else {
    await ctx.reply('Сначала начните добавление через /add');
  }
});

// ========== Обработка нажатий ==========

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) {
    await ctx.answerCbQuery('Это не кнопка с данными');
    return;
  }
  const data = ctx.callbackQuery.data;

  // ===== Обработка кнопки завершения загрузки =====
  if (data === 'finish_upload') {
    const mediaGroupId = ctx.session.accumulatorMediaGroupId;
    if (!mediaGroupId) {
      await ctx.answerCbQuery('Нет активной загрузки');
      return;
    }

    const accumulator = photoAccumulators[mediaGroupId];
    if (!accumulator) {
      await ctx.answerCbQuery('Аккумулятор не найден');
      ctx.session.accumulatorMediaGroupId = undefined;
      return;
    }

    // Проверяем, что это тот же пользователь
    if (accumulator.userId !== ctx.from?.id) {
      await ctx.answerCbQuery('Это не ваша загрузка');
      return;
    }

    const fileIds = accumulator.photos.map(p => p.fileId);
    const { adText, categoryId, ctx: originalCtx } = accumulator;

    // Отправляем на модерацию
    await sendToModerationMultiplePhotos(originalCtx, adText, categoryId, fileIds);

    // Очищаем данные
    delete photoAccumulators[mediaGroupId];
    ctx.session.accumulatorMediaGroupId = undefined;
    ctx.session.step = 'idle';
    ctx.session.adText = undefined;
    ctx.session.categoryId = undefined;

    // Редактируем сообщение с кнопкой, чтобы кнопка исчезла
    await ctx.editMessageText('✅ Загрузка завершена. Объявление отправлено на модерацию.');
    await ctx.answerCbQuery();
    return;
  }

  // ===== Обработка выбора категории =====
  if (data.startsWith('cat_')) {
    const categoryId = parseInt(data.split('_')[1], 10);
    if (isNaN(categoryId)) {
      await ctx.answerCbQuery('Ошибка: некорректная категория');
      return;
    }
    ctx.session.categoryId = categoryId;
    ctx.session.step = 'awaiting_text';
    await ctx.editMessageText('✅ Категория выбрана. Теперь отправьте текст объявления:');
    await ctx.answerCbQuery();
    return;
  }

  // ===== Обработка модерации (approve/reject) =====
  const [action, adIdStr] = data.split('_');
  const adId = parseInt(adIdStr, 10);
  if (isNaN(adId)) {
    await ctx.answerCbQuery('Ошибка данных');
    return;
  }

  const callbackMessage = ctx.callbackQuery.message; // переименовано, чтобы не конфликтовать с импортом
  if (!callbackMessage) {
    await ctx.answerCbQuery('Сообщение не найдено');
    return;
  }

  try {
    const adRepository = getRepository(Ad);
    const ad = await adRepository.findOne({ where: { id: adId } });
    if (!ad) {
      await ctx.answerCbQuery('Объявление не найдено');
      return;
    }

    if (action === 'approve') {
      const channelId = process.env.CHANNEL_ID;
      if (!channelId) throw new Error('CHANNEL_ID не задан');

      if (ad.photoFileIds && ad.photoFileIds.length > 0) {
        const mediaGroup = ad.photoFileIds.map((fileId, index) => ({
          type: 'photo' as const,
          media: fileId,
          ...(index === 0 ? { caption: ad.text } : {})
        }));
        await bot.telegram.sendMediaGroup(channelId, mediaGroup);
      } else {
        // Если нет фото, отправляем просто текст
        await bot.telegram.sendMessage(channelId, ad.text);
      }

      ad.status = 'approved';
      await adRepository.save(ad);

      try {
        await bot.telegram.sendMessage(ad.userId, '✅ Ваше объявление одобрено и опубликовано!');
      } catch (userErr) {
        console.error('Не удалось уведомить пользователя:', userErr);
      }

      if ('caption' in callbackMessage) {
        await ctx.editMessageCaption('✅ Одобрено');
      } else {
        await ctx.editMessageText('✅ Одобрено');
      }
    } else if (action === 'reject') {
      ad.status = 'rejected';
      await adRepository.save(ad);

      try {
        if ('caption' in callbackMessage) {
          await ctx.editMessageCaption('❌ Отклонено');
        } else {
          await ctx.editMessageText('❌ Отклонено');
        }
      } catch (editErr) {
        console.error('Не удалось отредактировать сообщение модерации:', editErr);
      }

      try {
        await bot.telegram.sendMessage(ad.userId, '❌ Ваше объявление отклонено модератором.');
      } catch (userErr) {
        console.error('Не удалось уведомить пользователя:', userErr);
      }
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('Ошибка обработки модерации:', err);
    await ctx.answerCbQuery('Произошла ошибка');
  }
});

// ========== Данные из WebApp ==========

bot.on('message', async (ctx) => {
  if (ctx.message && 'web_app_data' in ctx.message) {
    const webAppData = (ctx.message as any).web_app_data;
    const data = JSON.parse(webAppData.data);

    if (data.action === 'viewAd') {
      const adId = data.adId;
      const adRepository = getRepository(Ad);
      const ad = await adRepository.findOne({ where: { id: adId }, relations: ['category'] });
      if (!ad) {
        await ctx.reply('❌ Объявление не найдено');
        return;
      }
      let msg = `📌 **Объявление #${ad.id}**\n\n${ad.text}`;
      if (ad.category) msg += `\n🏷️ Категория: ${ad.category.name}`;
      msg += `\n📅 ${new Date(ad.createdAt).toLocaleString('ru-RU')}`;
      msg += `\n📊 Статус: ${
        ad.status === 'approved' ? '✅ Опубликовано' : 
        ad.status === 'moderation' ? '⏳ На модерации' : 
        ad.status === 'rejected' ? '❌ Отклонено' : '❓ Неизвестно'
      }`;
      if (ad.photoFileIds && ad.photoFileIds.length > 0) {
        await ctx.replyWithPhoto(ad.photoFileIds[0], { caption: msg, parse_mode: 'Markdown' });
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
    } else if (data.action === 'createAd') {
      const { categoryId, text } = data;
      if (!categoryId || !text) {
        await ctx.reply('❌ Ошибка: не все данные получены');
        return;
      }
      ctx.session.categoryId = categoryId;
      ctx.session.adText = text;
      ctx.session.step = 'awaiting_photo';
      await ctx.reply('✅ Текст объявления получен. Теперь отправьте фото (или напишите "пропустить")');
    }
  }
});

// ========== Подключение к БД и запуск ==========

createConnection({
  type: 'sqlite',
  database: 'database.sqlite',
  entities: [Ad, Category],
  synchronize: true,
  logging: false,
  extra: {
    pragma: {
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
    }
  }
})
  .then(async connection => {
    console.log('База данных подключена');

    const categoryRepository = getRepository(Category);
    const count = await categoryRepository.count();
    if (count === 0) {
      const defaultCategories = ['Недвижимость', 'Транспорт', 'Работа', 'Услуги', 'Электроника', 'Прочее'];
      for (const name of defaultCategories) {
        const cat = new Category();
        cat.name = name;
        await categoryRepository.save(cat);
      }
      console.log('✅ Категории по умолчанию созданы');
    } else {
      console.log(`📊 В базе уже есть ${count} категорий`);
    }

    console.log('✅ Бот успешно запущен и слушает сообщения');
    await bot.launch();
  })
  .catch(error => console.log('Ошибка БД:', error));

// ========== Завершение ==========
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));