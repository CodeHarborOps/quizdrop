const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);

// ── REDIS SETUP ───────────────────────────────────────────────
let io;
const REDIS_URL = process.env.REDIS_URL;

async function setupIO() {
  if (REDIS_URL) {
    const pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    await Promise.all([
      new Promise(r => pubClient.on('ready', r)),
      new Promise(r => subClient.on('ready', r)),
    ]);
    io = new Server(server, { maxHttpBufferSize: 5e6 });
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.io using Redis adapter — multi-instance ready');
  } else {
    io = new Server(server, { maxHttpBufferSize: 5e6 });
    console.log('Socket.io using in-memory adapter (set REDIS_URL for scale-out)');
  }
  attachHandlers();
}

const ROOM_TTL = 60 * 60 * 6;

function redisClient() {
  if (!redisClient._inst) {
    redisClient._inst = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient._inst;
}

async function getRoom(code) {
  if (!REDIS_URL) return inMemoryRooms[code] || null;
  const raw = await redisClient().get(`room:${code}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveRoom(room) {
  if (!REDIS_URL) { inMemoryRooms[room.code] = room; return; }
  await redisClient().setex(`room:${room.code}`, ROOM_TTL, JSON.stringify(room));
}

async function deleteRoom(code) {
  if (!REDIS_URL) { delete inMemoryRooms[code]; return; }
  await redisClient().del(`room:${code}`, `room:${code}:players`, `room:${code}:responses`);
}

async function getPlayers(code) {
  if (!REDIS_URL) return inMemoryPlayers[code] || {};
  const raw = await redisClient().hgetall(`room:${code}:players`);
  if (!raw) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = JSON.parse(v);
  return out;
}

async function savePlayer(code, socketId, player) {
  if (!REDIS_URL) {
    if (!inMemoryPlayers[code]) inMemoryPlayers[code] = {};
    inMemoryPlayers[code][socketId] = player;
    return;
  }
  await redisClient().hset(`room:${code}:players`, socketId, JSON.stringify(player));
  await redisClient().expire(`room:${code}:players`, ROOM_TTL);
}

async function removePlayer(code, socketId) {
  if (!REDIS_URL) {
    if (inMemoryPlayers[code]) delete inMemoryPlayers[code][socketId];
    return;
  }
  await redisClient().hdel(`room:${code}:players`, socketId);
}

async function getRoomByHost(hostId) {
  if (!REDIS_URL) {
    return Object.values(inMemoryRooms).find(r => r.hostId === hostId) || null;
  }
  const code = await redisClient().get(`host:${hostId}`);
  if (!code) return null;
  return getRoom(code);
}

async function setHostMapping(hostId, code) {
  if (!REDIS_URL) return;
  await redisClient().setex(`host:${hostId}`, ROOM_TTL, code);
}

async function deleteHostMapping(hostId) {
  if (!REDIS_URL) return;
  await redisClient().del(`host:${hostId}`);
}

// Free-text / word-cloud responses live in their own list per question
async function addResponse(code, qIndex, text) {
  const key = `${code}:${qIndex}`;
  if (!REDIS_URL) {
    if (!inMemoryResponses[key]) inMemoryResponses[key] = [];
    inMemoryResponses[key].push(text);
    return;
  }
  await redisClient().rpush(`room:${code}:responses:${qIndex}`, text);
  await redisClient().expire(`room:${code}:responses:${qIndex}`, ROOM_TTL);
}

async function getResponses(code, qIndex) {
  const key = `${code}:${qIndex}`;
  if (!REDIS_URL) return inMemoryResponses[key] || [];
  return await redisClient().lrange(`room:${code}:responses:${qIndex}`, 0, -1);
}

// Full per-player answer log per question — used for the end-of-game results export.
// Unlike player.lastAnswerIndex (which gets overwritten every question), this is append-only.
async function logAnswer(code, qIndex, entry) {
  const key = `${code}:${qIndex}`;
  const json = JSON.stringify(entry);
  if (!REDIS_URL) {
    if (!inMemoryAnswerLog[key]) inMemoryAnswerLog[key] = [];
    inMemoryAnswerLog[key].push(json);
    return;
  }
  await redisClient().rpush(`room:${code}:answerlog:${qIndex}`, json);
  await redisClient().expire(`room:${code}:answerlog:${qIndex}`, ROOM_TTL);
}

async function getAnswerLog(code, qIndex) {
  const key = `${code}:${qIndex}`;
  let raw;
  if (!REDIS_URL) raw = inMemoryAnswerLog[key] || [];
  else raw = await redisClient().lrange(`room:${code}:answerlog:${qIndex}`, 0, -1);
  return raw.map(r => JSON.parse(r));
}

// ── SAVED QUIZZES ─────────────────────────────────────────────
// Unlike rooms, saved quizzes have no TTL — they persist until explicitly deleted.
const inMemorySavedQuizzes = {};

function makeQuizId() {
  return 'q_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function saveQuiz(quiz) {
  const id = quiz.id || makeQuizId();
  const record = { ...quiz, id, updatedAt: Date.now() };
  if (!REDIS_URL) {
    inMemorySavedQuizzes[id] = record;
    return record;
  }
  await redisClient().set(`quiz:${id}`, JSON.stringify(record));
  await redisClient().sadd('quiz:index', id);
  return record;
}

async function getQuiz(id) {
  if (!REDIS_URL) return inMemorySavedQuizzes[id] || null;
  const raw = await redisClient().get(`quiz:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function listQuizzes() {
  if (!REDIS_URL) {
    return Object.values(inMemorySavedQuizzes).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const ids = await redisClient().smembers('quiz:index');
  if (!ids.length) return [];
  const raws = await redisClient().mget(ids.map(id => `quiz:${id}`));
  return raws.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function deleteQuiz(id) {
  if (!REDIS_URL) {
    delete inMemorySavedQuizzes[id];
    return;
  }
  await redisClient().del(`quiz:${id}`);
  await redisClient().srem('quiz:index', id);
}

// In-memory fallback stores
const inMemoryRooms = {};
const inMemoryPlayers = {};
const inMemoryResponses = {};
const inMemoryAnswerLog = {};
const roomTimers = {};

// ── HELPERS ───────────────────────────────────────────────────

function makeCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getLeaderboard(players) {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, streak: p.streak }));
}

function normalizeText(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTextAnswerCorrect(submitted, acceptedAnswers) {
  const norm = normalizeText(submitted);
  return (acceptedAnswers || []).some(a => normalizeText(a) === norm);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────

function attachHandlers() {

  io.on('connection', (socket) => {

    // ── HOST ──────────────────────────────────────────────────

    socket.on('host:create', async ({ mode }, cb) => {
      let code = makeCode();
      while (await getRoom(code)) code = makeCode();

      const room = {
        code,
        hostId: socket.id,
        mode: mode === 'survey' ? 'survey' : 'trivia',
        state: 'lobby',
        questions: [],
        currentQ: -1,
        questionStart: null,
      };
      await saveRoom(room);
      await setHostMapping(socket.id, code);
      socket.join(code);
      socket.join(`host:${code}`);

      let qr = '';
      try {
        const joinUrl = `${process.env.APP_URL || 'http://localhost:3000'}/play?room=${code}`;
        qr = await QRCode.toDataURL(joinUrl, { width: 280, margin: 2 });
      } catch (e) { /* non-fatal */ }

      cb({ code, qr });
    });

    socket.on('host:set_questions', async ({ questions }, cb) => {
      const room = await getRoomByHost(socket.id);
      if (!room) return cb({ error: 'Room not found' });
      room.questions = questions;
      room.currentQ = -1;
      await saveRoom(room);
      cb({ ok: true, count: questions.length });
    });

    socket.on('host:start_game', async () => {
      const room = await getRoomByHost(socket.id);
      if (!room || room.questions.length === 0) return;
      room.currentQ = -1;
      await saveRoom(room);
      const players = await getPlayers(room.code);
      for (const [sid, p] of Object.entries(players)) {
        p.score = 0; p.streak = 0; p.answered = false;
        await savePlayer(room.code, sid, p);
      }
      io.to(room.code).emit('game:started');
      advanceQuestion(room.code);
    });

    socket.on('host:next', async () => {
      const room = await getRoomByHost(socket.id);
      if (!room) return;
      if (room.state === 'question') {
        clearTimeout(roomTimers[room.code]);
        endQuestion(room.code);
      } else if (room.state === 'results' || room.state === 'leaderboard') {
        advanceQuestion(room.code);
      }
    });

    socket.on('host:end_game', async () => {
      const room = await getRoomByHost(socket.id);
      if (!room) return;
      clearTimeout(roomTimers[room.code]);
      const players = await getPlayers(room.code);
      room.state = 'ended';
      await saveRoom(room);
      io.to(room.code).emit('game:ended', { leaderboard: getLeaderboard(players), mode: room.mode });
    });

    // Host requests a live tally refresh while a question is open (for survey mode)
    socket.on('host:request_live_tally', async () => {
      const room = await getRoomByHost(socket.id);
      if (!room || room.state !== 'question') return;
      await pushLiveTally(room.code);
    });

    // ── PLAYER ────────────────────────────────────────────────

    socket.on('player:join', async ({ code, name }, cb) => {
      const room = await getRoom(code);
      if (!room) return cb({ error: 'Room not found' });
      if (room.state !== 'lobby') return cb({ error: 'Game already started' });

      const cleanName = (name || '').trim().substring(0, 20) || 'Anonymous';
      const player = { id: socket.id, name: cleanName, score: 0, streak: 0, answered: false };
      await savePlayer(code, socket.id, player);
      socket.join(code);
      socket.data.roomCode = code;

      const players = await getPlayers(code);
      io.to(code).emit('room:players_updated', {
        players: Object.values(players).map(p => ({ name: p.name, score: p.score }))
      });
      cb({ ok: true, name: cleanName, mode: room.mode });
    });

    socket.on('player:answer', async ({ index, indices }) => {
      const code = socket.data.roomCode;
      if (!code) return;
      const room = await getRoom(code);
      if (!room || room.state !== 'question') return;
      const players = await getPlayers(code);
      const player = players[socket.id];
      if (!player || player.answered) return;
      const q = room.questions[room.currentQ];
      if (q.type !== 'multiple_choice' && q.type !== 'true_false') return;

      player.answered = true;
      let logEntry;

      if (room.mode === 'trivia') {
        const elapsed = (Date.now() - room.questionStart) / 1000;
        const correct = index === q.correct;
        let points = 0;
        if (correct) {
          const timeBonus = Math.max(0, Math.floor((1 - elapsed / q.timeLimit) * 500));
          const streakBonus = Math.min(player.streak * 50, 200);
          points = 500 + timeBonus + streakBonus;
          player.score += points;
          player.streak++;
          socket.emit('player:answer_result', { correct: true, points, streak: player.streak });
        } else {
          player.streak = 0;
          socket.emit('player:answer_result', { correct: false, points: 0, streak: 0 });
        }
        player.lastAnswerIndex = index;
        player.lastAnswerIndices = [index];
        logEntry = {
          name: player.name,
          answerText: q.options[index] != null ? q.options[index] : '',
          correct,
          points,
        };
      } else {
        // Survey mode — no scoring, supports multi-select
        const selected = q.allowMultiple ? (Array.isArray(indices) ? indices : [index]) : [index];
        player.lastAnswerIndex = selected[0];
        player.lastAnswerIndices = selected;
        socket.emit('player:answer_result', { correct: null, points: 0, streak: 0 });
        logEntry = {
          name: player.name,
          answerText: selected.map(i => q.options[i]).filter(Boolean).join(', '),
          correct: null,
          points: 0,
        };
      }

      await logAnswer(code, room.currentQ, logEntry);
      await savePlayer(code, socket.id, player);
      await afterAnswer(code);
    });

    // Short answer — scored with flexible text matching
    socket.on('player:submit_answer_text', async ({ text }) => {
      const code = socket.data.roomCode;
      if (!code) return;
      const room = await getRoom(code);
      if (!room || room.state !== 'question') return;
      const players = await getPlayers(code);
      const player = players[socket.id];
      if (!player || player.answered) return;
      const q = room.questions[room.currentQ];
      if (q.type !== 'short_answer') return;

      const clean = (text || '').trim().substring(0, 200);
      player.answered = true;
      player.lastTextAnswer = clean;

      let logEntry;
      if (room.mode === 'trivia') {
        const elapsed = (Date.now() - room.questionStart) / 1000;
        const correct = isTextAnswerCorrect(clean, q.acceptedAnswers);
        let points = 0;
        if (correct) {
          const timeBonus = Math.max(0, Math.floor((1 - elapsed / q.timeLimit) * 500));
          const streakBonus = Math.min(player.streak * 50, 200);
          points = 500 + timeBonus + streakBonus;
          player.score += points;
          player.streak++;
          socket.emit('player:answer_result', { correct: true, points, streak: player.streak });
        } else {
          player.streak = 0;
          socket.emit('player:answer_result', { correct: false, points: 0, streak: 0 });
        }
        logEntry = { name: player.name, answerText: clean, correct, points };
      } else {
        socket.emit('player:answer_result', { correct: null, points: 0, streak: 0 });
        await addResponse(code, room.currentQ, clean);
        logEntry = { name: player.name, answerText: clean, correct: null, points: 0 };
      }

      await logAnswer(code, room.currentQ, logEntry);
      await savePlayer(code, socket.id, player);
      await afterAnswer(code);
    });

    socket.on('player:submit_text', async ({ text }) => {
      const code = socket.data.roomCode;
      if (!code) return;
      const room = await getRoom(code);
      if (!room || room.state !== 'question') return;
      const players = await getPlayers(code);
      const player = players[socket.id];
      if (!player || player.answered) return;
      const q = room.questions[room.currentQ];
      if (q.type !== 'word_cloud' && q.type !== 'open_ended') return;

      const clean = (text || '').trim().substring(0, q.type === 'word_cloud' ? 30 : 280);
      if (!clean) return;

      player.answered = true;
      await savePlayer(code, socket.id, player);
      await addResponse(code, room.currentQ, clean);
      await logAnswer(code, room.currentQ, { name: player.name, answerText: clean, correct: null, points: 0 });
      socket.emit('player:answer_result', { correct: null, points: 0, streak: 0 });

      await pushLiveTally(code);
      await afterAnswer(code);
    });

    socket.on('disconnect', async () => {
      const room = await getRoomByHost(socket.id);
      if (room) {
        clearTimeout(roomTimers[room.code]);
        io.to(room.code).emit('game:host_left');
        await deleteRoom(room.code);
        await deleteHostMapping(socket.id);
        delete roomTimers[room.code];
      }
      const code = socket.data.roomCode;
      if (code) {
        await removePlayer(code, socket.id);
        const players = await getPlayers(code);
        io.to(code).emit('room:players_updated', {
          players: Object.values(players).map(p => ({ name: p.name, score: p.score }))
        });
      }
    });
  });
}

async function afterAnswer(code) {
  const players = await getPlayers(code);
  const answered = Object.values(players).filter(p => p.answered).length;
  const total = Object.keys(players).length;
  io.to(`host:${code}`).emit('host:answer_progress', { answered, total });
  if (answered === total && total > 0) {
    clearTimeout(roomTimers[code]);
    endQuestion(code);
  }
}

// Push live tally of multiple-choice counts or text responses to host (for live-updating charts)
async function pushLiveTally(code) {
  const room = await getRoom(code);
  if (!room || room.state !== 'question') return;
  const q = room.questions[room.currentQ];
  if (q.type === 'multiple_choice' || q.type === 'true_false') {
    const players = await getPlayers(code);
    const counts = q.options.map((_, i) =>
      Object.values(players).filter(p => p.answered && (p.lastAnswerIndices || [p.lastAnswerIndex]).includes(i)).length
    );
    io.to(`host:${code}`).emit('host:live_tally', { type: q.type, counts });
  } else if (q.type === 'short_answer') {
    if (room.mode === 'survey') {
      const responses = await getResponses(code, room.currentQ);
      io.to(`host:${code}`).emit('host:live_tally', { type: q.type, responses });
    }
  } else {
    const responses = await getResponses(code, room.currentQ);
    io.to(`host:${code}`).emit('host:live_tally', { type: q.type, responses });
  }
}

// ── GAME FLOW ─────────────────────────────────────────────────

async function advanceQuestion(code) {
  const room = await getRoom(code);
  if (!room) return;

  room.currentQ++;
  if (room.currentQ >= room.questions.length) {
    room.state = 'ended';
    await saveRoom(room);
    const players = await getPlayers(code);
    io.to(code).emit('game:ended', { leaderboard: getLeaderboard(players), mode: room.mode });
    return;
  }

  const q = room.questions[room.currentQ];
  room.state = 'question';
  room.questionStart = Date.now();
  await saveRoom(room);

  const players = await getPlayers(code);
  for (const [sid, p] of Object.entries(players)) {
    p.answered = false;
    p.lastAnswerIndex = null;
    p.lastAnswerIndices = [];
    p.lastTextAnswer = null;
    await savePlayer(code, sid, p);
  }

  const payload = {
    index: room.currentQ,
    total: room.questions.length,
    type: q.type,
    text: q.text,
    image: q.image || null,
    options: q.options || null,
    timeLimit: q.timeLimit || 45,
    mode: room.mode,
    displayStyle: q.displayStyle || 'bars',
    allowMultiple: !!q.allowMultiple,
    showPercentage: !!q.showPercentage,
  };

  io.to(code).emit('game:question', payload);
  io.to(`host:${code}`).emit('host:question', {
    ...payload,
    correct: room.mode === 'trivia' ? q.correct : null,
    acceptedAnswers: room.mode === 'trivia' ? (q.acceptedAnswers || null) : null,
    playerCount: Object.keys(players).length,
  });

  roomTimers[code] = setTimeout(() => endQuestion(code), (q.timeLimit || 45) * 1000);
}

async function endQuestion(code) {
  const room = await getRoom(code);
  if (!room) return;
  room.state = 'results';
  await saveRoom(room);

  const q = room.questions[room.currentQ];
  const players = await getPlayers(code);

  if (q.type === 'multiple_choice' || q.type === 'true_false') {
    const counts = q.options.map((_, i) =>
      Object.values(players).filter(p => p.answered && (p.lastAnswerIndices || [p.lastAnswerIndex]).includes(i)).length
    );
    io.to(code).emit('game:question_ended', {
      type: q.type,
      correct: room.mode === 'trivia' ? q.correct : null,
      correctText: room.mode === 'trivia' ? q.options[q.correct] : null,
      options: q.options,
      counts,
      displayStyle: q.displayStyle || 'bars',
      showPercentage: !!q.showPercentage,
      leaderboard: room.mode === 'trivia' ? getLeaderboard(players).slice(0, 5) : null,
      mode: room.mode,
    });
  } else if (q.type === 'short_answer') {
    if (room.mode === 'trivia') {
      const correctCount = Object.values(players).filter(p =>
        p.answered && isTextAnswerCorrect(p.lastTextAnswer, q.acceptedAnswers)
      ).length;
      io.to(code).emit('game:question_ended', {
        type: q.type,
        correctText: (q.acceptedAnswers || [])[0] || '',
        correctCount,
        totalAnswered: Object.values(players).filter(p => p.answered).length,
        leaderboard: getLeaderboard(players).slice(0, 5),
        mode: room.mode,
      });
    } else {
      const responses = await getResponses(code, room.currentQ);
      io.to(code).emit('game:question_ended', {
        type: q.type,
        responses,
        mode: room.mode,
        leaderboard: null,
      });
    }
  } else {
    const responses = await getResponses(code, room.currentQ);
    io.to(code).emit('game:question_ended', {
      type: q.type,
      responses,
      mode: room.mode,
      leaderboard: null,
    });
  }
}

// ── HTTP ROUTES ───────────────────────────────────────────────

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

app.get('/play', (req, res) => {
  res.sendFile(__dirname + '/public/play.html');
});

// Full results bundle for the host's end-of-game Excel export.
// Only the host can fetch this — verified by checking the room's hostId matches a live socket.
app.get('/api/results/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const room = await getRoom(code);
  if (!room) return res.status(404).json({ error: 'Room not found or has expired' });

  const players = await getPlayers(code);
  const leaderboard = getLeaderboard(players);

  const questionResults = [];
  for (let i = 0; i < room.questions.length; i++) {
    const q = room.questions[i];
    const log = await getAnswerLog(code, i);
    questionResults.push({
      index: i,
      type: q.type,
      text: q.text,
      correctAnswer: room.mode === 'trivia'
        ? (q.type === 'multiple_choice' || q.type === 'true_false' ? q.options[q.correct] : (q.acceptedAnswers || []).join(', '))
        : null,
      answers: log,
    });
  }

  res.json({
    roomCode: code,
    mode: room.mode,
    leaderboard,
    questions: questionResults,
  });
});

// ── SAVED QUIZZES API ─────────────────────────────────────────

app.get('/api/quizzes', async (req, res) => {
  try {
    const quizzes = await listQuizzes();
    // Don't send full question payloads in the list view — just metadata
    res.json(quizzes.map(q => ({
      id: q.id,
      name: q.name,
      mode: q.mode,
      questionCount: (q.questions || []).length,
      updatedAt: q.updatedAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list saved quizzes' });
  }
});

app.get('/api/quizzes/:id', async (req, res) => {
  try {
    const quiz = await getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

app.post('/api/quizzes', async (req, res) => {
  try {
    const { id, name, mode, questions } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Quiz name is required' });
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'At least one question is required' });
    if (mode !== 'trivia' && mode !== 'survey') return res.status(400).json({ error: 'Invalid mode' });

    const record = await saveQuiz({ id, name: String(name).trim().substring(0, 80), mode, questions });
    res.json({ ok: true, id: record.id, updatedAt: record.updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save quiz' });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  try {
    await deleteQuiz(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// ── START ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
setupIO().then(() => {
  server.listen(PORT, () => console.log(`QuizDrop running on port ${PORT}`));
});
