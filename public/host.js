const socket = io();
let roomCode = '';
let gameMode = 'trivia';
let timerInterval = null;
let questions = [];
let liveChart = null;
let resultsChart = null;
let currentResultsStyle = 'bars';
let currentShowPercentage = false;
let lastResultsData = null;

const CHART_COLORS = ['#7c5cfc', '#fc5c7d', '#f39c12', '#2ecc71', '#3498db', '#9b59b6'];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ── MODE TOGGLE ───────────────────────────────────────────────

function setMode(mode) {
  gameMode = mode;
  document.getElementById('mode-trivia-btn').classList.toggle('active', mode === 'trivia');
  document.getElementById('mode-survey-btn').classList.toggle('active', mode === 'survey');
  document.getElementById('mode-desc').textContent = mode === 'trivia'
    ? 'Scored multiple-choice questions with a live leaderboard — best for trivia games.'
    : 'Unscored questions for gathering opinions — multiple choice, word cloud, or open text.';
  renderQuestions();
}

// ── QUESTION BUILDER ─────────────────────────────────────────

function addQuestion() {
  const data = {
    type: 'multiple_choice',
    text: '',
    options: ['', '', '', ''],
    correct: 0,
    timeLimit: 20,
    displayStyle: 'bars',
    allowMultiple: false,
    showPercentage: false,
  };
  questions.push(data);
  renderQuestions();
}

function renderQuestions() {
  const container = document.getElementById('questions-container');
  document.getElementById('q-count-label').textContent = questions.length;

  container.innerHTML = questions.map((q, i) => {
    const typeOptions = gameMode === 'trivia'
      ? `<option value="multiple_choice" ${q.type==='multiple_choice'?'selected':''}>Multiple choice</option>`
      : `
        <option value="multiple_choice" ${q.type==='multiple_choice'?'selected':''}>Multiple choice</option>
        <option value="word_cloud" ${q.type==='word_cloud'?'selected':''}>Word cloud</option>
        <option value="open_ended" ${q.type==='open_ended'?'selected':''}>Open ended</option>
      `;

    const badge = q.type === 'multiple_choice'
      ? '<span class="type-badge badge-mc">Multiple choice</span>'
      : q.type === 'word_cloud'
        ? '<span class="type-badge badge-wc">Word cloud</span>'
        : '<span class="type-badge badge-oe">Open ended</span>';

    let body = `
      <input type="text" placeholder="Question text…" value="${escHtml(q.text)}"
        oninput="questions[${i}].text = this.value" style="width:100%; margin:0.5rem 0;" />
    `;

    if (q.type === 'multiple_choice') {
      body += `
        <div class="options-grid">
          ${q.options.map((opt, j) => `
            <div class="option-wrap">
              ${gameMode === 'trivia' ? `<input type="radio" name="correct-${i}" value="${j}" ${q.correct===j?'checked':''} onchange="questions[${i}].correct=${j}" />` : ''}
              <input type="text" placeholder="Option ${j+1}" value="${escHtml(opt)}"
                oninput="questions[${i}].options[${j}] = this.value" />
            </div>
          `).join('')}
        </div>
      `;
      if (gameMode === 'survey') {
        body += `
          <div class="row-meta">
            <label>Display style</label>
            <div class="style-pills">
              ${['bars','donut','pie','dots'].map(s => `
                <button type="button" class="style-pill ${q.displayStyle===s?'active':''}" onclick="setQuestionStyle(${i},'${s}')">${s}</button>
              `).join('')}
            </div>
          </div>
          <div class="row-meta">
            <label class="toggle-row">
              <span class="toggle-switch ${q.allowMultiple?'on':''}" onclick="toggleQuestionFlag(${i},'allowMultiple')"></span>
              Allow multiple selections
            </label>
          </div>
          <div class="row-meta">
            <label class="toggle-row">
              <span class="toggle-switch ${q.showPercentage?'on':''}" onclick="toggleQuestionFlag(${i},'showPercentage')"></span>
              Show results as percentage
            </label>
          </div>
        `;
      }
    } else if (q.type === 'word_cloud') {
      body += `<p style="font-size:0.8rem; color:var(--muted); margin-top:0.25rem;">Players type a single word or short phrase. Bigger = more common answer.</p>`;
    } else if (q.type === 'open_ended') {
      body += `<p style="font-size:0.8rem; color:var(--muted); margin-top:0.25rem;">Players type a free-text response. All responses appear live in a feed.</p>`;
    }

    body += `
      <div class="row-meta">
        <label>Time limit</label>
        <select onchange="questions[${i}].timeLimit=+this.value">
          <option value="10" ${q.timeLimit===10?'selected':''}>10s</option>
          <option value="15" ${q.timeLimit===15?'selected':''}>15s</option>
          <option value="20" ${q.timeLimit===20?'selected':''}>20s</option>
          <option value="30" ${q.timeLimit===30?'selected':''}>30s</option>
          <option value="45" ${q.timeLimit===45?'selected':''}>45s</option>
          <option value="60" ${q.timeLimit===60?'selected':''}>60s</option>
        </select>
        ${q.type === 'multiple_choice' && gameMode === 'trivia' ? '<label>✓ = correct answer</label>' : ''}
      </div>
    `;

    return `
      <div class="question-row" id="qrow-${i}">
        <div class="qrow-top">
          <div style="flex:1;">
            ${badge}
            <div class="q-label">Question ${i+1}</div>
          </div>
          <select class="type-select" onchange="setQuestionType(${i}, this.value)">${typeOptions}</select>
          <button class="remove-btn" onclick="removeQuestion(${i})">✕</button>
        </div>
        ${body}
      </div>
    `;
  }).join('');
}

function setQuestionType(i, type) {
  const q = questions[i];
  q.type = type;
  if (type === 'multiple_choice' && (!q.options || q.options.length < 2)) {
    q.options = ['', '', '', ''];
    q.correct = 0;
    q.displayStyle = q.displayStyle || 'bars';
  }
  renderQuestions();
}

function setQuestionStyle(i, style) {
  questions[i].displayStyle = style;
  renderQuestions();
}

function toggleQuestionFlag(i, flag) {
  questions[i][flag] = !questions[i][flag];
  renderQuestions();
}

function removeQuestion(i) {
  questions.splice(i, 1);
  renderQuestions();
}

function clearAll() {
  if (questions.length === 0 || confirm('Clear all questions?')) {
    questions = [];
    renderQuestions();
  }
}

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── ROOM CREATION ─────────────────────────────────────────────

function createRoom() {
  const valid = questions.filter(q => {
    if (!q.text.trim()) return false;
    if (q.type === 'multiple_choice') return q.options.filter(o => o.trim()).length >= 2;
    return true;
  });
  if (valid.length === 0) { showToast('Add at least one question first'); return; }

  socket.emit('host:create', { mode: gameMode }, ({ code, qr }) => {
    roomCode = code;
    socket.emit('host:set_questions', { questions: valid }, () => {});
    const joinUrl = `${location.origin}/play?room=${code}`;
    document.getElementById('display-code').textContent = code;
    document.getElementById('display-url').textContent = `${location.host}/play`;
    document.getElementById('qr-url').textContent = joinUrl;
    if (qr) { document.getElementById('qr-img').src = qr; }
    showScreen('lobby');
  });
}

function startGame() {
  if (!roomCode) return;
  socket.emit('host:start_game');
}

function hostNext() {
  socket.emit('host:next');
}

function endGame() {
  if (confirm('End the game now?')) socket.emit('host:end_game');
}

// ── SOCKET: HOST EVENTS ───────────────────────────────────────

socket.on('room:players_updated', ({ players }) => {
  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-list').innerHTML = players.map(p =>
    `<div class="player-chip">${escHtml(p.name)}</div>`
  ).join('');
});

socket.on('host:question', (payload) => {
  showScreen('question');
  const { index, total, text, options, correct, timeLimit, playerCount, type, displayStyle, mode } = payload;

  document.getElementById('q-progress').textContent = `Question ${index+1} of ${total}`;
  document.getElementById('q-text').textContent = text;
  document.getElementById('ans-count').textContent = '0';
  document.getElementById('ans-total').textContent = playerCount;
  document.getElementById('next-btn').textContent = 'Skip →';

  // Hide all display areas first
  document.getElementById('options-display').style.display = 'none';
  document.getElementById('live-chart-wrap').style.display = 'none';
  document.getElementById('wordcloud-wrap').style.display = 'none';
  document.getElementById('feed-wrap').style.display = 'none';

  if (type === 'multiple_choice') {
    if (mode === 'trivia') {
      document.getElementById('options-display').style.display = 'grid';
      document.getElementById('options-display').innerHTML = options.map(o => `<div class="opt-card">${escHtml(o)}</div>`).join('');
    } else {
      document.getElementById('live-chart-wrap').style.display = 'block';
      renderLiveChart(options, options.map(() => 0), displayStyle || 'bars');
    }
  } else if (type === 'word_cloud') {
    document.getElementById('wordcloud-wrap').style.display = 'flex';
    document.getElementById('wordcloud-wrap').innerHTML = '<span style="color:var(--muted); font-size:0.9rem;">Waiting for responses…</span>';
  } else if (type === 'open_ended') {
    document.getElementById('feed-wrap').style.display = 'block';
    document.getElementById('feed-wrap').innerHTML = '<span style="color:var(--muted); font-size:0.9rem;">Waiting for responses…</span>';
  }

  startTimer(timeLimit);
});

socket.on('host:answer_progress', ({ answered, total }) => {
  document.getElementById('ans-count').textContent = answered;
  document.getElementById('ans-total').textContent = total;
});

socket.on('host:live_tally', ({ type, counts, responses }) => {
  if (type === 'multiple_choice' && liveChart) {
    liveChart.data.datasets[0].data = counts;
    liveChart.update();
  } else if (type === 'word_cloud') {
    renderWordCloud('wordcloud-wrap', responses);
  } else if (type === 'open_ended') {
    renderFeed('feed-wrap', responses);
  }
});

socket.on('game:question_ended', (data) => {
  clearInterval(timerInterval);
  setTimeout(() => showResults(data), data.type === 'multiple_choice' ? 1200 : 200);
});

socket.on('game:ended', ({ leaderboard, mode }) => {
  clearInterval(timerInterval);
  document.getElementById('final-subtitle').textContent = mode === 'trivia' ? 'Game over — final standings' : 'Poll complete — thanks for participating';
  if (mode === 'trivia' && leaderboard && leaderboard.length) {
    document.getElementById('final-lb-card').style.display = 'block';
    renderLeaderboard('final-lb', leaderboard);
  } else {
    document.getElementById('final-lb-card').style.display = 'none';
  }
  showScreen('final');
});

function showResults(data) {
  document.getElementById('results-correct-card').style.display = 'none';
  document.getElementById('results-chart-card').style.display = 'none';
  document.getElementById('results-wordcloud-card').style.display = 'none';
  document.getElementById('results-feed-card').style.display = 'none';
  document.getElementById('results-lb-card').style.display = 'none';

  if (data.type === 'multiple_choice') {
    if (data.mode === 'trivia' && data.correctText) {
      document.getElementById('results-correct-card').style.display = 'block';
      document.getElementById('correct-answer-text').textContent = data.correctText;
    }
    document.getElementById('results-chart-card').style.display = 'block';
    currentResultsStyle = data.displayStyle || 'bars';
    currentShowPercentage = !!data.showPercentage;
    lastResultsData = data;
    renderStylePills();
    renderResultsChart(data.options, data.counts, currentResultsStyle, currentShowPercentage);

    if (data.leaderboard && data.leaderboard.length) {
      document.getElementById('results-lb-card').style.display = 'block';
      renderLeaderboard('results-lb', data.leaderboard);
    }
  } else if (data.type === 'word_cloud') {
    document.getElementById('results-wordcloud-card').style.display = 'block';
    renderWordCloud('results-wordcloud', data.responses);
  } else if (data.type === 'open_ended') {
    document.getElementById('results-feed-card').style.display = 'block';
    renderFeed('results-feed', data.responses);
  }

  showScreen('results');
}

function renderStylePills() {
  const wrap = document.getElementById('results-style-pills');
  wrap.innerHTML = ['bars','donut','pie','dots'].map(s => `
    <button type="button" class="style-pill ${currentResultsStyle===s?'active':''}" onclick="switchResultsStyle('${s}')">${s}</button>
  `).join('') + `
    <button type="button" class="style-pill ${currentShowPercentage?'active':''}" onclick="toggleResultsPercentage()" style="margin-left:0.5rem;">%</button>
  `;
}

function switchResultsStyle(style) {
  currentResultsStyle = style;
  renderStylePills();
  if (lastResultsData) renderResultsChart(lastResultsData.options, lastResultsData.counts, style, currentShowPercentage);
}

function toggleResultsPercentage() {
  currentShowPercentage = !currentShowPercentage;
  renderStylePills();
  if (lastResultsData) renderResultsChart(lastResultsData.options, lastResultsData.counts, currentResultsStyle, currentShowPercentage);
}

// ── CHART RENDERING ──────────────────────────────────────────

function chartConfigFor(style, labels, data, showPercentage) {
  const colors = labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
  const total = data.reduce((a,b) => a+b, 0) || 1;
  const displayData = showPercentage ? data.map(v => Math.round((v / total) * 100)) : data;
  const fmt = (v) => showPercentage ? v + '%' : v;

  if (style === 'bars') {
    return { type: 'bar', data: { labels, datasets: [{ data: displayData, backgroundColor: colors, borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.y) } } },
        scales: { y: { beginAtZero: true, max: showPercentage ? 100 : undefined, ticks: { precision: 0, color: '#8a8a99', callback: (v) => showPercentage ? v+'%' : v }, grid: { color: 'rgba(255,255,255,0.05)' } },
                  x: { ticks: { color: '#8a8a99' }, grid: { display: false } } } } };
  }
  if (style === 'donut' || style === 'pie') {
    return { type: style === 'donut' ? 'doughnut' : 'pie', data: { labels, datasets: [{ data: displayData, backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#f0f0f5' } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } } } } };
  }
  // dots
  return { type: 'bubble', data: { datasets: labels.map((l, i) => ({
      label: `${l}: ${fmt(displayData[i])}`, data: [{ x: i, y: 0, r: Math.max(6, Math.sqrt(data[i]) * 12) }], backgroundColor: colors[i]
    })) },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#f0f0f5' } } },
      scales: { x: { display: false, min: -1, max: labels.length }, y: { display: false, min: -1, max: 1 } } } };
}

function renderLiveChart(labels, data, style) {
  const ctx = document.getElementById('live-chart');
  if (liveChart) liveChart.destroy();
  liveChart = new Chart(ctx, chartConfigFor(style, labels, data, false));
}

function renderResultsChart(labels, data, style, showPercentage) {
  const ctx = document.getElementById('results-chart');
  if (resultsChart) resultsChart.destroy();
  resultsChart = new Chart(ctx, chartConfigFor(style, labels, data, showPercentage));
}

// ── WORD CLOUD ───────────────────────────────────────────────

function renderWordCloud(containerId, responses) {
  const el = document.getElementById(containerId);
  if (!responses || responses.length === 0) {
    el.innerHTML = '<span style="color:var(--muted); font-size:0.9rem;">Waiting for responses…</span>';
    return;
  }
  const counts = {};
  responses.forEach(r => {
    const key = r.trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]);
  const max = entries[0][1];
  el.innerHTML = entries.map(([word, count]) => {
    const size = 0.9 + (count / max) * 2.2;
    const colorIdx = Math.floor(Math.random() * CHART_COLORS.length);
    return `<span class="wc-word" style="font-size:${size}rem; color:${CHART_COLORS[colorIdx]};">${escHtml(word)}</span>`;
  }).join('');
}

// ── OPEN ENDED FEED ──────────────────────────────────────────

function renderFeed(containerId, responses) {
  const el = document.getElementById(containerId);
  if (!responses || responses.length === 0) {
    el.innerHTML = '<span style="color:var(--muted); font-size:0.9rem;">Waiting for responses…</span>';
    return;
  }
  el.innerHTML = responses.slice().reverse().map(r => `<div class="feed-item">${escHtml(r)}</div>`).join('');
}

// ── LEADERBOARD ──────────────────────────────────────────────

function renderLeaderboard(containerId, lb) {
  const medals = ['gold','silver','bronze'];
  document.getElementById(containerId).innerHTML = lb.map((p,i) => `
    <li class="lb-row">
      <span class="lb-rank ${medals[i]||''}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':p.rank}</span>
      <span class="lb-name">${escHtml(p.name)}${p.streak>1?' 🔥×'+p.streak:''}</span>
      <span class="lb-score">${p.score.toLocaleString()}</span>
    </li>
  `).join('');
}

// ── TIMER ────────────────────────────────────────────────────

function startTimer(seconds) {
  clearInterval(timerInterval);
  let remaining = seconds;
  const bar = document.getElementById('timer-bar');
  const disp = document.getElementById('timer-display');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  disp.textContent = seconds + 's';
  setTimeout(() => {
    bar.style.transition = `width ${seconds}s linear`;
    bar.style.width = '0%';
  }, 50);
  timerInterval = setInterval(() => {
    remaining--;
    disp.textContent = remaining + 's';
    disp.style.color = remaining <= 5 ? '#e74c3c' : 'var(--accent)';
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// Poll host for live tally every 2s while a question is active (covers word cloud / open ended)
setInterval(() => {
  if (document.getElementById('screen-question').classList.contains('active')) {
    socket.emit('host:request_live_tally');
  }
}, 2000);

// Init
addQuestion();
