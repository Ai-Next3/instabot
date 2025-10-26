const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const { setupDatabase } = require('./database.js'); 
const setupTelegramBot = require('./bot_admin.js');

dotenv.config();
const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  INSTAGRAM_ACCESS_TOKEN,
  PORT = 3000,
  WEBHOOK_PATH,
} = process.env;

let db;
let telegramAdmin; // Здесь будет наш бот и его обработчик

// Роут для Instagram Webhook (Верификация)
app.get(WEBHOOK_PATH, (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Роут для Instagram Webhook (События)
app.post(WEBHOOK_PATH, async (req, res) => {
  console.log('Получены данные от Instagram:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // Сразу отвечаем Instagram, что все ОК

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];

  if (change?.field === 'comments') {
    const commentText = change.value.text.toLowerCase();
    const commentId = change.value.id;
    const fromId = change.value.from.id;

    const trigger = await db.get('SELECT * FROM triggers WHERE trigger_phrase = ?', commentText);

    if (trigger) {
      try {
        // Ответ на коммент
        await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, 
          { message: trigger.comment_reply },
          { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
        );
        console.log(`Успешно ответили на комментарий с триггером "${commentText}"`);
        
        // Сообщение в личку
        const userProfile = await axios.get(`https://graph.instagram.com/v21.0/${fromId}?fields=id`, { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } });
        await axios.post(`https://graph.instagram.com/v21.0/me/messages`, 
          { recipient: { id: userProfile.data.id }, message: { text: trigger.direct_message }, messaging_type: 'RESPONSE' }, 
          { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
        );
        console.log(`Успешно отправили личное сообщение для триггера "${commentText}"`);
      } catch (error) {
        console.error('Ошибка при отправке ответа:', error.response ? error.response.data : error.message);
      }
    }
  }
});

// НОВЫЙ РОУТ: Вебхук для Telegram
app.post('/tlg/webhook', (req, res) => {
  if (telegramAdmin && telegramAdmin.handleUpdate) {
    telegramAdmin.handleUpdate(req.body); // Передаем обновление нашему боту
  }
  res.sendStatus(200); // Отвечаем Telegram, что все получили
});

// Запускаем все вместе
async function startApp() {
  db = await setupDatabase();
  console.log('База данных успешно подключена.');
  
  telegramAdmin = setupTelegramBot(db); // Инициализируем Telegram-бота
  
  app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}. Слушает Instagram и Telegram.`);
  });
}

startApp();
