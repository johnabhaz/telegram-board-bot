import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createConnection, getRepository } from 'typeorm';
import { Ad } from './entities/Ad';
import { Category } from './entities/Category';
import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN!);

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Только изображения разрешены') as any, false);
    }
  }
});

app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

app.use(cors({
  origin: ['https://johnabhaz.github.io', 'http://127.0.0.1:8080', 'http://localhost:8080']
}));
app.use(express.json());

app.get('/test', (req, res) => {
  try {
    res.json({ status: 'ok', message: 'API работает' });
  } catch (err) {
    console.error('❌ Ошибка в /test:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

createConnection({
  type: 'sqlite',
  database: 'database.sqlite',
  entities: [Ad, Category],
  synchronize: false,
  logging: false,
  extra: {
    pragma: {
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
    }
  }
}).then(() => {
  console.log('📦 API: база данных подключена');

  app.get('/api/categories', async (req, res) => {
    try {
      const categoryRepo = getRepository(Category);
      const categories = await categoryRepo.find();
      res.json(categories);
    } catch (err) {
      console.error('❌ Ошибка в /api/categories:', err);
      res.status(500).json({ error: 'Ошибка при получении категорий' });
    }
  });

  app.get('/api/ads', async (req, res) => {
    try {
      const { page = 1, limit = 10, categoryId, search } = req.query;
      const adRepo = getRepository(Ad);
      const query = adRepo.createQueryBuilder('ad')
        .leftJoinAndSelect('ad.category', 'category')
        .where('ad.status = :status', { status: 'approved' })
        .orderBy('ad.createdAt', 'DESC');

      if (categoryId) {
        query.andWhere('ad.categoryId = :categoryId', { categoryId: Number(categoryId) });
      }
      if (search) {
        query.andWhere('ad.text LIKE :search', { search: `%${search}%` });
      }

      const total = await query.getCount();
      const ads = await query
        .skip((Number(page) - 1) * Number(limit))
        .take(Number(limit))
        .getMany();

      res.json({
        ads: ads.map(ad => ({
          id: ad.id,
          text: ad.text,
          photoFileIds: ad.photoFileIds,
          category: ad.category ? ad.category.name : null,
          createdAt: ad.createdAt,
        })),
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit))
      });
    } catch (err) {
      console.error('❌ Ошибка в /api/ads:', err);
      res.status(500).json({ error: 'Ошибка при получении объявлений' });
    }
  });

  app.post('/api/createAd', upload.single('photo'), async (req, res) => {
    try {
      const { text, categoryId, userId } = req.body;
      const photoFile = req.file;

      if (!text || !categoryId || !userId) {
        return res.status(400).json({ error: 'Не хватает данных' });
      }

      const categoryRepo = getRepository(Category);
      const category = await categoryRepo.findOne({ where: { id: Number(categoryId) } });
      const categoryName = category ? category.name : 'без категории';

      const adRepo = getRepository(Ad);
      const ad = new Ad();
      ad.userId = Number(userId);
      ad.text = text;
      ad.status = 'moderation';
      ad.categoryId = Number(categoryId);
      ad.photoFileIds = photoFile ? [] : []; // временно пусто, заполним после отправки
      await adRepo.save(ad);

      let photoFileIds: string[] = [];
      const modGroupId = process.env.MODERATION_GROUP_ID;
      const channelId = process.env.CHANNEL_ID;

      if (photoFile) {
        if (modGroupId) {
          const caption = `📬 Новое объявление от пользователя (ID: ${userId})\n🏷️ Категория: ${categoryName}\n\n${text}`;
          const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('✅ Одобрить', `approve_${ad.id}`),
            Markup.button.callback('❌ Отклонить', `reject_${ad.id}`)
          ]);
          const sent = await bot.telegram.sendPhoto(modGroupId, { source: photoFile.buffer }, {
            caption,
            ...keyboard
          });
          photoFileIds = [sent.photo[sent.photo.length - 1].file_id];
          ad.moderationMessageId = sent.message_id;
        } else if (channelId) {
          const sent = await bot.telegram.sendPhoto(channelId, { source: photoFile.buffer }, { caption: text });
          photoFileIds = [sent.photo[sent.photo.length - 1].file_id];
          ad.status = 'approved';
        }
      } else {
        if (modGroupId) {
          const caption = `📬 Новое объявление от пользователя (ID: ${userId})\n🏷️ Категория: ${categoryName}\n\n${text}`;
          const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('✅ Одобрить', `approve_${ad.id}`),
            Markup.button.callback('❌ Отклонить', `reject_${ad.id}`)
          ]);
          const sent = await bot.telegram.sendMessage(modGroupId, caption, keyboard);
          ad.moderationMessageId = sent.message_id;
        } else if (channelId) {
          await bot.telegram.sendMessage(channelId, text);
          ad.status = 'approved';
        }
      }

      ad.photoFileIds = photoFileIds;
      await adRepo.save(ad);

      res.json({ success: true, message: 'Объявление отправлено на модерацию' });
    } catch (error) {
      console.error('❌ Ошибка создания объявления:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 API сервер запущен на порту ${PORT}`);
  });

  server.on('error', (err) => {
    console.error('❌ Ошибка сервера:', err);
  });

}).catch(error => {
  console.error('❌ Ошибка подключения к базе данных:', error);
  process.exit(1);
});