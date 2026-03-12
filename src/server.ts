import express from 'express';
import cors from 'cors';
import { createConnection, getRepository } from 'typeorm';
import { Ad } from './entities/Ad';
import { Category } from './entities/Category';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для логирования всех входящих запросов
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

app.use(cors({
  origin: 'https://johnabhaz.github.io' // разрешаем запросы с вашего WebApp
}));
app.use(express.json());

// Простой тестовый маршрут для проверки доступности API
app.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'API работает' });
});

createConnection({
  type: 'sqlite',
  database: 'database.sqlite',
  entities: [Ad, Category],
  synchronize: false, // таблицы создаются ботом, отключаем синхронизацию
  logging: false,
  extra: {
    pragma: {
      journal_mode: 'WAL',     // WAL для конкурентного доступа
      synchronous: 'NORMAL',    // баланс скорости и надёжности
    }
  }
}).then(() => {
  console.log('📦 API: база данных подключена');

  app.get('/api/categories', async (req, res) => {
    const categoryRepo = getRepository(Category);
    const categories = await categoryRepo.find();
    res.json(categories);
  });

  app.get('/api/ads', async (req, res) => {
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
        photoFileId: ad.photoFileId,
        category: ad.category ? ad.category.name : null,
        createdAt: ad.createdAt,
      })),
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit))
    });
  });

  app.listen(PORT, () => {
    console.log(`🌐 API сервер запущен на порту ${PORT}`);
  });
}).catch(error => console.log('Ошибка API:', error));