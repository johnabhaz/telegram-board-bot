const { fork } = require('child_process');
const path = require('path');

// Запускаем бота
const botProcess = fork(path.join(__dirname, 'dist', 'bot.js'));
console.log('🤖 Бот запущен (PID: ' + botProcess.pid + ')');

// Запускаем API-сервер
const apiProcess = fork(path.join(__dirname, 'dist', 'server.js'));
console.log('🌐 API сервер запущен (PID: ' + apiProcess.pid + ')');

// Обработка завершения процессов
botProcess.on('exit', (code) => {
  console.log(`❌ Бот завершил работу с кодом ${code}`);
  // Можно перезапустить или завершить всё приложение
  process.exit(code);
});

apiProcess.on('exit', (code) => {
  console.log(`❌ API сервер завершил работу с кодом ${code}`);
  process.exit(code);
});

// Если основной процесс получает сигнал завершения, убиваем дочерние
process.on('SIGINT', () => {
  console.log('Получен SIGINT, завершаем дочерние процессы...');
  botProcess.kill('SIGINT');
  apiProcess.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Получен SIGTERM, завершаем дочерние процессы...');
  botProcess.kill('SIGTERM');
  apiProcess.kill('SIGTERM');
  process.exit(0);
});