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

  // Обработка комментариев
  if (change?.field === 'comments') {
    const commentText = change.value.text.toLowerCase();
    const commentId = change.value.id;
    const fromId = change.value.from.id;

    const trigger = await db.get('SELECT * FROM triggers WHERE trigger_phrase = ?', commentText);

    if (trigger) {
      try {
        // Ответ на коммент с кнопкой
        await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, 
          { message: trigger.comment_reply },
          { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
        );
        console.log(`Успешно ответили на комментарий с триггером "${commentText}"`);
        
        // Первое сообщение в личку - запрашиваем согласие с кнопкой "Да"
        const userProfile = await axios.get(`https://graph.instagram.com/v21.0/${fromId}?fields=id`, { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } });
        await axios.post(`https://graph.instagram.com/v21.0/me/messages`, 
          { 
            recipient: { id: userProfile.data.id }, 
            message: {
              text: `Йоу, увидел твой коммент 👀\n\nЧтобы получить информацию нажми кнопку "Да" ниже или напиши "Да" в ответ на это сообщение.`,
              quick_replies: [
                {
                  content_type: 'text',
                  title: 'Да',
                  payload: `confirm_${trigger.id}`
                }
              ]
            },
            messaging_type: 'RESPONSE'
          }, 
          { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
        );
        console.log(`Успешно отправили запрос подтверждения для триггера "${commentText}" (ID: ${trigger.id})`);
      } catch (error) {
        console.error('Ошибка при отправке ответа:', error.response ? error.response.data : error.message);
      }
    }
  }

  // Обработка входящих сообщений от пользователей
  if (change?.field === 'messages') {
    const messageData = change.value;
    const messageText = messageData.text?.toLowerCase();
    const fromId = messageData.from?.id;
    const quickReply = messageData.quick_reply;

    // Проверяем, нажал ли пользователь на кнопку подтверждения confirm_
    if (quickReply?.payload?.startsWith('confirm_') && fromId) {
      try {
        // Извлекаем ID триггера из payload
        const triggerId = parseInt(quickReply.payload.split('_')[1]);
        const selectedTrigger = await db.get('SELECT * FROM triggers WHERE id = ?', triggerId);
        
        if (selectedTrigger) {
          // Отправляем основную информацию триггера
          await axios.post(`https://graph.instagram.com/v21.0/me/messages`, 
            { 
              recipient: { id: fromId }, 
              message: {
                text: selectedTrigger.direct_message
              }
            }, 
            { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
          );
          console.log(`Успешно отправили информацию триггера пользователю ${fromId} (ID: ${triggerId})`);
        }
      } catch (error) {
        console.error('Ошибка при отправке информации триггера:', error.response ? error.response.data : error.message);
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
