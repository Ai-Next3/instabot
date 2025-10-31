const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const { setupDatabase, createOrGetConfirmation, markInfoAsSent, getConfirmation } = require('./database.js');
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

        // Сохраняем подтверждение в БД
        await createOrGetConfirmation(fromId, trigger.id);
        console.log(`✅ Подтверждение создано для пользователя ${fromId}, триггер ID: ${trigger.id}`);

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
    
    // Пропускаем наши собственные сообщения (echo)
    if (messageData.is_echo) {
      console.log('Это наше отправленное сообщение, пропускаем.');
      return;
    }

    const messageText = messageData.text?.toLowerCase();
    const fromId = messageData.from?.id;
    const quickReply = messageData.quick_reply;

    console.log('📨 Входящее сообщение от пользователя:', JSON.stringify(messageData, null, 2));

    // Проверяем, нажал ли пользователь на кнопку подтверждения confirm_
    if ((quickReply?.payload?.startsWith('confirm_') || messageText === 'да') && fromId) {
      try {
        let triggerId;

        // Если есть quickReply с payload
        if (quickReply?.payload?.startsWith('confirm_')) {
          triggerId = parseInt(quickReply.payload.split('_')[1]);
          console.log(`👇 Нажата кнопка с payload: confirm_${triggerId}`);
        } else if (messageText === 'да') {
          // Если просто написал "Да" - ищем последний триггер для этого пользователя
          console.log('🔍 Пользователь написал "Да", ищем последний триггер...');
          const lastConfirmation = await db.get(
            'SELECT trigger_id FROM user_confirmations WHERE user_id = ? AND info_sent = 0 ORDER BY created_at DESC LIMIT 1',
            fromId
          );
          
          if (lastConfirmation) {
            triggerId = lastConfirmation.trigger_id;
            console.log(`✅ Найден триггер ID: ${triggerId}`);
          } else {
            console.log('❌ Не найден ни один подтвержденный триггер');
            return;
          }
        }

        const selectedTrigger = await db.get('SELECT * FROM triggers WHERE id = ?', triggerId);

        if (selectedTrigger) {
          // Отправляем основную информацию триггера (обычным сообщением, не reply)
          await axios.post(`https://graph.instagram.com/v21.0/me/messages`,
            {
              recipient: { id: fromId },
              message: {
                text: selectedTrigger.direct_message
              }
            },
            { headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` } }
          );
          
          // Помечаем информацию как отправленную
          await markInfoAsSent(fromId, triggerId);
          
          console.log(`✅ Информация триггера отправлена пользователю ${fromId} (ID: ${triggerId})`);
        } else {
          console.log(`❌ Триггер с ID ${triggerId} не найден в БД`);
        }
      } catch (error) {
        console.error('❌ Ошибка при отправке информации триггера:', error.response ? error.response.data : error.message);
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
