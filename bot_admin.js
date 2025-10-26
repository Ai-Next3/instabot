const TelegramBot = require('node-telegram-bot-api');
const db = require('./database.js');

const conversations = {};

const mainKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📋 Посмотреть триггеры', callback_data: 'list_triggers_0' }],
            [{ text: '➕ Добавить триггер', callback_data: 'add_trigger' }],
        ],
    },
};

function getTriggerManagementKeyboard(triggerId) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✏️ Фраза', callback_data: `edit_phrase_${triggerId}` }, { text: '✏️ Ответ', callback_data: `edit_reply_${triggerId}` }, { text: '✏️ ЛС', callback_data: `edit_dm_${triggerId}` }],
                [{ text: '🗑️ Удалить', callback_data: `delete_confirm_${triggerId}` }],
                [{ text: '⬅️ Назад к списку', callback_data: 'list_triggers_0' }],
            ],
        },
    };
}

function getDeleteConfirmationKeyboard(triggerId) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Да, удалить', callback_data: `delete_do_${triggerId}` }],
                [{ text: '❌ Нет, отмена', callback_data: `view_${triggerId}` }],
            ],
        },
    };
}

function getCancelKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Отмена', callback_data: 'cancel_dialog' }],
            ],
        },
    };
}

function formatTriggerText(trigger) {
    return `Триггер: ${trigger.trigger_phrase}\n\nОтвет на коммент:\n${trigger.comment_reply}\n\nСообщение в ЛС:\n${trigger.direct_message}`;
}

function setupTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
        console.warn("Токен для Telegram-бота не найден. Админ-бот не будет запущен.");
        return null;
    }

    const adminIds = (process.env.TELEGRAM_ADMIN_IDS || "").split(',').map(id => parseInt(id.trim(), 10));
    if (adminIds.length === 0 || isNaN(adminIds[0])) {
        console.warn("ID администраторов не найдены в .env. Админ-бот никому не будет отвечать.");
    }
    
    const bot = new TelegramBot(token);
    bot.setWebHook(`${process.env.PUBLIC_URL}/tlg/webhook`)
       .then(() => console.log(`Вебхук для Telegram-бота установлен.`))
       .catch(err => console.error("Ошибка установки вебхука:", err.message));

    bot.onText(/\/start/, (msg) => {
        if (!adminIds.includes(msg.from.id)) return;
        conversations[msg.chat.id] = undefined;
        bot.sendMessage(msg.chat.id, 'Добро пожаловать в админ-панель!', mainKeyboard);
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        if (!adminIds.includes(msg.from.id) || !conversations[chatId]) return;
        
        const conv = conversations[chatId];
        const text = msg.text;

        try {
            switch (conv.stage) {
                case 'awaiting_trigger_phrase':
                    conv.data.phrase = text;
                    conv.stage = 'awaiting_comment_reply';
                    bot.sendMessage(chatId, 'Отлично. Теперь введите ответ на комментарий.', getCancelKeyboard());
                    break;
                case 'awaiting_comment_reply':
                    conv.data.reply = text;
                    conv.stage = 'awaiting_dm';
                    bot.sendMessage(chatId, 'Принято. Теперь введите сообщение для отправки в ЛС.', getCancelKeyboard());
                    break;
                case 'awaiting_dm':
                    conv.data.dm = text;
                    await db.addTrigger(conv.data);
                    delete conversations[chatId];
                    bot.sendMessage(chatId, `✅ Триггер "${conv.data.phrase}" успешно добавлен!`);
                    bot.sendMessage(chatId, 'Главное меню', mainKeyboard);
                    break;
                case 'editing_phrase':
                case 'editing_reply':
                case 'editing_dm':
                    const fieldMap = {
                        editing_phrase: 'trigger_phrase',
                        editing_reply: 'comment_reply',
                        editing_dm: 'direct_message',
                    };
                    await db.updateTrigger(conv.data.id, fieldMap[conv.stage], text);
                    delete conversations[chatId];
                    const trigger = await db.getTriggerById(conv.data.id);
                    bot.sendMessage(chatId, `✅ Поле успешно обновлено!\n\n${formatTriggerText(trigger)}`, getTriggerManagementKeyboard(conv.data.id));
                    break;
            }
        } catch (error) {
            console.error('Message handler error:', error.message);
            if (error.code === 'SQLITE_CONSTRAINT') {
                bot.sendMessage(chatId, `❌ Ошибка: триггер с такой фразой уже существует.`);
            } else {
                bot.sendMessage(chatId, '❌ Произошла ошибка.');
            }
            delete conversations[chatId];
            bot.sendMessage(chatId, 'Главное меню', mainKeyboard);
        }
    });

    bot.on('callback_query', async (query) => {
        bot.answerCallbackQuery(query.id);
        
        if (!adminIds.includes(query.from.id)) return;

        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const data = query.data;

        try {
            if (data === 'cancel_dialog') {
                conversations[chatId] = undefined;
                bot.editMessageText('Действие отменено. Главное меню', { chat_id: chatId, message_id: messageId, reply_markup: mainKeyboard.reply_markup });
            }
            else if (data === 'main_menu') {
                conversations[chatId] = undefined;
                bot.editMessageText('Добро пожаловать в админ-панель!', { chat_id: chatId, message_id: messageId, reply_markup: mainKeyboard.reply_markup });
            }
            else if (data.startsWith('list_triggers_')) {
                const page = parseInt(data.split('_')[2], 10);
                const triggers = await db.getAllTriggers();
                const itemsPerPage = 5;
                const totalPages = Math.ceil(triggers.length / itemsPerPage);
                const pageTriggers = triggers.slice(page * itemsPerPage, (page + 1) * itemsPerPage);

                let text = '📋 Ваши триггеры:\n\n';
                const keyboard = [];
                if (pageTriggers.length === 0) {
                    text = 'У вас пока нет ни одного триггера.';
                } else {
                    pageTriggers.forEach(t => {
                        keyboard.push([{ text: `"${t.trigger_phrase}"`, callback_data: `view_${t.id}` }]);
                    });
                }
                
                const nav = [];
                if (page > 0) nav.push({ text: '⬅️ Пред.', callback_data: `list_triggers_${page - 1}` });
                if (page < totalPages - 1) nav.push({ text: 'След. ➡️', callback_data: `list_triggers_${page + 1}` });
                if (nav.length > 0) keyboard.push(nav);

                keyboard.push([{ text: '➕ Добавить', callback_data: 'add_trigger' }]);
                keyboard.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

                bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
            }
            else if (data === 'add_trigger') {
                conversations[chatId] = { stage: 'awaiting_trigger_phrase', data: {} };
                bot.editMessageText('Введите фразу-триггер.', { chat_id: chatId, message_id: messageId, reply_markup: getCancelKeyboard().reply_markup });
            }
            else if (data.startsWith('view_')) {
                const id = data.split('_')[1];
                const trigger = await db.getTriggerById(id);
                if (trigger) {
                    bot.editMessageText(formatTriggerText(trigger), { chat_id: chatId, message_id: messageId, reply_markup: getTriggerManagementKeyboard(id).reply_markup });
                }
            }
            else if (data.startsWith('edit_')) {
                const [, field, id] = data.split('_');
                const fieldMap = { phrase: 'фраза-триггер', reply: 'ответ на комментарий', dm: 'сообщение в ЛС' };
                conversations[chatId] = { stage: `editing_${field}`, data: { id } };
                bot.editMessageText(`Введите новое значение для поля: ${fieldMap[field]}`, { chat_id: chatId, message_id: messageId, reply_markup: getCancelKeyboard().reply_markup });
            }
            else if (data.startsWith('delete_confirm_')) {
                const id = data.split('_')[2];
                bot.editMessageText('Вы уверены, что хотите удалить этот триггер?', { chat_id: chatId, message_id: messageId, reply_markup: getDeleteConfirmationKeyboard(id).reply_markup });
            }
            else if (data.startsWith('delete_do_')) {
                const id = data.split('_')[2];
                await db.deleteTrigger(id);
                const triggers = await db.getAllTriggers();
                const itemsPerPage = 5;
                const keyboard = [];
                if (triggers.length === 0) {
                    bot.editMessageText('Триггер удален. У вас больше нет триггеров.', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: '➕ Добавить', callback_data: 'add_trigger' }], [{ text: '🏠 В меню', callback_data: 'main_menu' }]] } });
                } else {
                    triggers.slice(0, itemsPerPage).forEach(t => {
                        keyboard.push([{ text: `"${t.trigger_phrase}"`, callback_data: `view_${t.id}` }]);
                    });
                    if (triggers.length > itemsPerPage) keyboard.push([{ text: 'След. ➡️', callback_data: `list_triggers_1` }]);
                    keyboard.push([{ text: '➕ Добавить', callback_data: 'add_trigger' }]);
                    keyboard.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);
                    bot.editMessageText('📋 Ваши триггеры:\n\n', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
                }
            }
        } catch (error) {
            if (!error.message.includes('message is not modified')) {
                console.error('Callback Query Error:', error.message);
            }
        }
    });

    const handleUpdate = (update) => {
        bot.processUpdate(update);
    };

    return { bot, handleUpdate };
}

module.exports = setupTelegramBot;
