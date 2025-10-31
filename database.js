const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');

let db;

async function setupDatabase() {
  const dbPath = './data/database.sqlite';
  
  // Создаём директорию если её нет
  if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
  }
  
  const dbExists = fs.existsSync(dbPath);

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Создаём таблицу если её нет
  await db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_phrase TEXT NOT NULL UNIQUE,
      comment_reply TEXT NOT NULL,
      direct_message TEXT NOT NULL
    )
  `);

  // Таблица для отслеживания подтверждений пользователей
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      trigger_id INTEGER NOT NULL,
      info_sent BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, trigger_id)
    )
  `);

  // Добавляем стартовый триггер ТОЛЬКО если БД была новая
  if (!dbExists) {
    const count = await db.get('SELECT COUNT(id) as count FROM triggers');
    if (count.count === 0) {
      await addTrigger({
        phrase: 'тест',
        reply: 'Это тестовый ответ на коммент.',
        dm: 'Это тестовое сообщение в личку.'
      });
      console.log('Стартовый триггер "тест" добавлен в базу данных.');
    }
  } else {
    console.log('БД уже существует. Данные сохранены.');
  }
  
  return db;
}

async function addTrigger({ phrase, reply, dm }) {
  const result = await db.run(
    'INSERT INTO triggers (trigger_phrase, comment_reply, direct_message) VALUES (?, ?, ?)',
    phrase.toLowerCase(), reply, dm
  );
  return result;
}

async function getAllTriggers() {
  return db.all('SELECT * FROM triggers ORDER BY trigger_phrase');
}

async function getTriggerById(id) {
    return db.get('SELECT * FROM triggers WHERE id = ?', id);
}

async function deleteTrigger(id) {
  return db.run('DELETE FROM triggers WHERE id = ?', id);
}

async function updateTrigger(id, field, value) {
    const allowedFields = ['trigger_phrase', 'comment_reply', 'direct_message'];
    if (!allowedFields.includes(field)) {
        throw new Error('Недопустимое поле для обновления');
    }
    // Для trigger_phrase приводим к нижнему регистру
    const finalValue = field === 'trigger_phrase' ? value.toLowerCase() : value;
    return db.run(`UPDATE triggers SET ${field} = ? WHERE id = ?`, finalValue, id);
}

async function createOrGetConfirmation(userId, triggerId) {
  try {
    const existing = await db.get(
      'SELECT * FROM user_confirmations WHERE user_id = ? AND trigger_id = ?',
      userId, triggerId
    );
    
    if (!existing) {
      await db.run(
        'INSERT INTO user_confirmations (user_id, trigger_id, info_sent) VALUES (?, ?, 0)',
        userId, triggerId
      );
    }
    
    return existing || { user_id: userId, trigger_id: triggerId, info_sent: 0 };
  } catch (error) {
    console.error('Ошибка при создании подтверждения:', error.message);
  }
}

async function markInfoAsSent(userId, triggerId) {
  return db.run(
    'UPDATE user_confirmations SET info_sent = 1 WHERE user_id = ? AND trigger_id = ?',
    userId, triggerId
  );
}

async function getConfirmation(userId, triggerId) {
  return db.get(
    'SELECT * FROM user_confirmations WHERE user_id = ? AND trigger_id = ?',
    userId, triggerId
  );
}


module.exports = { 
    setupDatabase,
    addTrigger,
    getAllTriggers,
    getTriggerById,
    deleteTrigger,
    updateTrigger,
    createOrGetConfirmation,
    markInfoAsSent,
    getConfirmation
};
