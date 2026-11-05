const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FACEIT_API_KEY = process.env.FACEIT_API_KEY;
const BASE = 'https://open.faceit.com/data/v4';

app.use(express.static(path.join(__dirname)));

async function faceitGet(endpoint) {
  const response = await fetch(`${BASE}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${FACEIT_API_KEY}`,
      'Accept': 'application/json'
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `FACEIT API error: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(FACEIT_API_KEY) });
});

app.get('/api/player/:nickname', async (req, res) => {
  if (!FACEIT_API_KEY) {
    return res.status(500).json({ error: 'На сервере пока не добавлен FACEIT_API_KEY.' });
  }

  const nickname = String(req.params.nickname || '').trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(nickname)) {
    return res.status(400).json({ error: 'Некорректный ник FACEIT.' });
  }

  try {
    const player = await faceitGet(`/players?nickname=${encodeURIComponent(nickname)}`);
    const playerId = player.player_id;
    if (!playerId) return res.status(404).json({ error: 'Игрок не найден.' });

    let stats = null;
    const gameIds = ['cs2', 'csgo'];
    for (const gameId of gameIds) {
      try {
        stats = await faceitGet(`/players/${encodeURIComponent(playerId)}/stats/${gameId}`);
        if (stats) break;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }

    res.json({ player, stats: stats?.lifetime || null });
  } catch (error) {
    const status = error.status === 404 ? 404 : (error.status === 401 || error.status === 403 ? 502 : 502);
    const message = error.status === 401 || error.status === 403
      ? 'FACEIT отклонил API-ключ. Проверь его тип и доступ.'
      : error.status === 404
        ? 'Игрок или статистика не найдены.'
        : 'Не удалось получить данные FACEIT. Попробуй позже.';
    console.error('FACEIT request failed:', error.message);
    res.status(status).json({ error: message });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DemoScope server listening on port ${PORT}`);
});
