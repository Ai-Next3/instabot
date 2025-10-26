const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;

async function setupDatabase() {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_phrase TEXT NOT NULL UNIQUE,
      comment_reply TEXT NOT NULL,
      direct_message TEXT NOT NULL
    )
  `);

  const count = await db.get('SELECT COUNT(id) as count FROM triggers');
  if (count.count === 0) {
    await addTrigger({
      phrase: 'тест',
      reply: 'Это тестовый ответ на коммент.',
      dm: 'Это тестовое сообщение в личку.'
    });
    console.log('Стартовый триггер "тест" добавлен в базу данных.');
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


module.exports = { 
    setupDatabase,
    addTrigger,
    getAllTriggers,
    getTriggerById,
    deleteTrigger,
    updateTrigger
};
