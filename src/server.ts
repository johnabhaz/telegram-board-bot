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

// Простой тестовый маршрут для проверки доступности API (с try-catch)
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

  // Маршрут для получения категорий (с try-catch)
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

  // Маршрут для получения объявлений (с try-catch)
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
          photoFileId: ad.photoFileId,
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

  // Запускаем сервер с явным указанием интерфейса 0.0.0.0
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 API сервер запущен на порту ${PORT}`);
  });

  // Обработка ошибок сервера
  server.on('error', (err) => {
    console.error('❌ Ошибка сервера:', err);
  });

}).catch(error => {
  console.error('❌ Ошибка подключения к базе данных:');
  console.error(error);
  process.exit(1); // Принудительно завершаем процесс, чтобы Railway показал ошибку
});