const socket = io();
let roomCode = '';
let gameMode = 'trivia';
let timerInterval = null;
let questions = [];
let entryMode = 'manual';
let excelQuestions = [];
let liveChart = null;
let resultsChart = null;
let currentResultsStyle = 'bars';
let currentShowPercentage = false;
let lastResultsData = null;

const CHART_COLORS = ['#2563EB', '#E0563A', '#F2A93C', '#1D9E75', '#8E44AD', '#16A085', '#D35400', '#2C3E50'];
const DEFAULT_TIME = 45;

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
    ? 'Scored questions with a live leaderboard — multiple choice, true/false, short answer.'
    : 'Unscored questions for gathering opinions — multiple choice, word cloud, or open text.';

  const templateLink = document.getElementById('template-download-link');
  if (templateLink) {
    if (mode === 'trivia') {
      templateLink.href = '/quizdrop-template-trivia.xlsx';
      templateLink.textContent = '⬇ Download the Trivia template';
    } else {
      templateLink.href = '/quizdrop-template-survey.xlsx';
      templateLink.textContent = '⬇ Download the Poll/Survey template';
    }
  }

  // Clear any previously uploaded/parsed Excel data — it belonged to the old mode
  excelQuestions = [];
  const previewCard = document.getElementById('excel-preview-card');
  const statusEl = document.getElementById('excel-status');
  const startBtn = document.getElementById('excel-start-btn');
  if (previewCard) previewCard.style.display = 'none';
  if (statusEl) statusEl.textContent = '';
  if (startBtn) startBtn.style.display = 'none';

  renderQuestions();
}

// ── ENTRY MODE TOGGLE ───────────────────────────────────────────

function setEntryMode(mode) {
  entryMode = mode;
  document.getElementById('entry-manual-btn').classList.toggle('active', mode === 'manual');
  document.getElementById('entry-excel-btn').classList.toggle('active', mode === 'excel');
  document.getElementById('entry-manual-panel').style.display = mode === 'manual' ? 'block' : 'none';
  document.getElementById('entry-excel-panel').style.display = mode === 'excel' ? 'block' : 'none';
}

// ── EXCEL UPLOAD ────────────────────────────────────────────────

const TRIVIA_TYPES = ['multiple_choice', 'true_false', 'short_answer'];
const SURVEY_TYPES = ['multiple_choice', 'word_cloud', 'open_ended'];

function handleExcelUpload(input) {
  const file = input.files[0];
  if (!file) return;
  parseExcelFile(file);
}

const dropZone = document.getElementById('excel-drop-zone');
if (dropZone) {
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) parseExcelFile(file);
  });
}

function parseExcelFile(file) {
  const statusEl = document.getElementById('excel-status');
  statusEl.textContent = 'Reading file…';
  statusEl.style.color = 'var(--muted)';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames.includes('Questions') ? 'Questions' : workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      processExcelRows(rows);
    } catch (err) {
      statusEl.textContent = 'Could not read this file. Make sure it\'s a valid .xlsx or .csv.';
      statusEl.style.color = 'var(--red)';
    }
  };
  reader.readAsArrayBuffer(file);
}

function processExcelRows(rows) {
  const statusEl = document.getElementById('excel-status');
  if (!rows.length) {
    statusEl.textContent = 'No rows found in that file.';
    statusEl.style.color = 'var(--red)';
    return;
  }

  const parsed = [];
  let errorCount = 0;

  const allTypes = [...TRIVIA_TYPES, ...SURVEY_TYPES];
  const modeTypes = gameMode === 'trivia' ? TRIVIA_TYPES : SURVEY_TYPES;

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const type = String(row.type || '').trim().toLowerCase();
    const text = String(row.text || '').trim();

    // Skip section-label rows from the template (e.g. "↓ TRIVIA MODE examples...")
    if (!text && type && !allTypes.includes(type)) return;
    // Skip fully blank spacer rows
    if (!type && !text) return;

    const errors = [];

    if (!allTypes.includes(type)) {
      errors.push(`Row ${rowNum}: unknown type "${row.type}"`);
    } else if (!modeTypes.includes(type)) {
      errors.push(`Row ${rowNum}: "${type}" doesn't work in ${gameMode === 'trivia' ? 'Trivia' : 'Poll/Survey'} mode — switch modes or use the matching template`);
    }
    if (!text) {
      errors.push(`Row ${rowNum}: missing question text`);
    }

    const options = [];
    for (let n = 1; n <= 8; n++) {
      const val = String(row['option' + n] || '').trim();
      if (val) options.push(val);
    }

    const q = {
      type: allTypes.includes(type) ? type : 'multiple_choice',
      text,
      image: row.image_url ? String(row.image_url).trim() : null,
      options: options.length ? options : ['', '', '', ''],
      correct: 0,
      acceptedAnswers: [''],
      timeLimit: Number(row.time_limit) || DEFAULT_TIME,
      displayStyle: ['bars','donut','pie','dots'].includes(String(row.display_style).toLowerCase()) ? String(row.display_style).toLowerCase() : 'bars',
      allowMultiple: String(row.allow_multiple).trim().toLowerCase() === 'yes',
      showPercentage: false,
      _rowErrors: errors,
    };

    if (type === 'multiple_choice' || type === 'true_false') {
      if (type === 'true_false') q.options = ['True', 'False'];
      if (q.options.filter(o => o.trim()).length < 2) {
        errors.push(`Row ${rowNum}: needs at least 2 options`);
      }
      const correctRaw = String(row.correct || '').trim();
      const correctIdx = parseInt(correctRaw, 10);
      if (correctRaw && !isNaN(correctIdx) && correctIdx >= 1 && correctIdx <= q.options.length) {
        q.correct = correctIdx - 1;
      } else if (type === 'true_false') {
        q.correct = correctRaw.toLowerCase() === 'false' ? 1 : 0;
      } else if (gameMode === 'trivia') {
        errors.push(`Row ${rowNum}: "correct" must be the option number (1-${q.options.length})`);
      }
    } else if (type === 'short_answer') {
      const correctRaw = String(row.correct || '').trim();
      q.acceptedAnswers = correctRaw ? correctRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (gameMode === 'trivia' && q.acceptedAnswers.length === 0) {
        errors.push(`Row ${rowNum}: needs at least one accepted answer in "correct"`);
      }
    }

    q._rowErrors = errors;
    if (errors.length) errorCount++;
    parsed.push(q);
  });

  excelQuestions = parsed;
  renderExcelPreview(parsed, errorCount);
}

function renderExcelPreview(parsed, errorCount) {
  const statusEl = document.getElementById('excel-status');
  const previewCard = document.getElementById('excel-preview-card');
  const previewList = document.getElementById('excel-preview-list');
  const startBtn = document.getElementById('excel-start-btn');

  document.getElementById('excel-q-count').textContent = parsed.length;
  previewCard.style.display = 'block';

  previewList.innerHTML = parsed.map((q, i) => `
    <div class="excel-preview-row">
      <div class="ep-type">${escHtml(q.type.replace('_',' '))}</div>
      <div>${escHtml(q.text) || '<em>(missing question text)</em>'}</div>
      ${q._rowErrors && q._rowErrors.length ? `<div class="ep-error">${q._rowErrors.map(escHtml).join('<br>')}</div>` : ''}
    </div>
  `).join('');

  if (errorCount > 0) {
    statusEl.textContent = `Found ${parsed.length} questions, ${errorCount} with issues — fix them in your spreadsheet and re-upload, or they'll be skipped.`;
    statusEl.style.color = 'var(--accent2)';
  } else {
    statusEl.textContent = `✓ ${parsed.length} questions ready to go.`;
    statusEl.style.color = 'var(--green)';
  }

  startBtn.style.display = parsed.some(q => !q._rowErrors || q._rowErrors.length === 0) ? 'inline-flex' : 'none';
}



function addQuestion() {
  const data = {
    type: 'multiple_choice',
    text: '',
    image: null,
    options: ['', '', '', ''],
    correct: 0,
    acceptedAnswers: [''],
    timeLimit: DEFAULT_TIME,
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
      ? `
        <option value="multiple_choice" ${q.type==='multiple_choice'?'selected':''}>Multiple choice</option>
        <option value="true_false" ${q.type==='true_false'?'selected':''}>True / False</option>
        <option value="short_answer" ${q.type==='short_answer'?'selected':''}>Short answer</option>
      `
      : `
        <option value="multiple_choice" ${q.type==='multiple_choice'?'selected':''}>Multiple choice</option>
        <option value="word_cloud" ${q.type==='word_cloud'?'selected':''}>Word cloud</option>
        <option value="open_ended" ${q.type==='open_ended'?'selected':''}>Open ended</option>
      `;

    const badgeMap = {
      multiple_choice: ['badge-mc', 'Multiple choice'],
      true_false: ['badge-tf', 'True / False'],
      short_answer: ['badge-sa', 'Short answer'],
      word_cloud: ['badge-wc', 'Word cloud'],
      open_ended: ['badge-oe', 'Open ended'],
    };
    const [badgeClass, badgeLabel] = badgeMap[q.type] || badgeMap.multiple_choice;
    const badge = `<span class="type-badge ${badgeClass}">${badgeLabel}</span>`;

    let body = `
      <input type="text" placeholder="Question text…" value="${escHtml(q.text)}"
        oninput="questions[${i}].text = this.value" style="width:100%; margin:0.5rem 0;" />
    `;

    // Image upload (all types)
    body += `
      <div class="image-upload-row">
        <input type="file" accept="image/*" id="img-input-${i}" style="display:none;" onchange="handleImageUpload(${i}, this)" />
        ${q.image
          ? `<div class="image-preview-wrap"><img src="${q.image}" class="image-preview" /><button type="button" class="btn btn-secondary btn-sm" onclick="removeImage(${i})">Remove photo</button></div>`
          : `<button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('img-input-${i}').click()">+ Add photo</button>`
        }
      </div>
    `;

    if (q.type === 'multiple_choice') {
      body += `
        <div class="options-list">
          ${q.options.map((opt, j) => `
            <div class="option-wrap">
              ${gameMode === 'trivia' ? `<input type="radio" name="correct-${i}" value="${j}" ${q.correct===j?'checked':''} onchange="questions[${i}].correct=${j}" />` : ''}
              <input type="text" placeholder="Option ${j+1}" value="${escHtml(opt)}"
                oninput="questions[${i}].options[${j}] = this.value" />
              ${q.options.length > 2 ? `<button type="button" class="remove-opt-btn" onclick="removeOption(${i},${j})">✕</button>` : ''}
            </div>
          `).join('')}
        </div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="addOption(${i})" style="margin-top:0.5rem;">+ Add option</button>
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
    } else if (q.type === 'true_false') {
      body += `
        <div class="row-meta">
          <label>Correct answer</label>
          <div class="style-pills">
            <button type="button" class="style-pill ${q.correct===0?'active':''}" onclick="setTrueFalse(${i},0)">True</button>
            <button type="button" class="style-pill ${q.correct===1?'active':''}" onclick="setTrueFalse(${i},1)">False</button>
          </div>
        </div>
      `;
    } else if (q.type === 'short_answer') {
      body += `
        <div class="q-label" style="margin-top:0.5rem;">Accepted answers (any of these count as correct)</div>
        <div class="accepted-answers-list">
          ${q.acceptedAnswers.map((a, j) => `
            <div class="option-wrap">
              <input type="text" placeholder="${j===0?'Correct answer':'Alternative spelling/phrasing'}" value="${escHtml(a)}"
                oninput="questions[${i}].acceptedAnswers[${j}] = this.value" />
              ${q.acceptedAnswers.length > 1 ? `<button type="button" class="remove-opt-btn" onclick="removeAcceptedAnswer(${i},${j})">✕</button>` : ''}
            </div>
          `).join('')}
        </div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="addAcceptedAnswer(${i})" style="margin-top:0.5rem;">+ Add alternative answer</button>
        <p style="font-size:0.78rem; color:var(--muted); margin-top:0.4rem;">Not case sensitive. Extra spaces are ignored.</p>
      `;
    } else if (q.type === 'word_cloud') {
      body += `<p style="font-size:0.8rem; color:var(--muted); margin-top:0.25rem;">Players type a single word or short phrase. Bigger = more common answer.</p>`;
    } else if (q.type === 'open_ended') {
      body += `<p style="font-size:0.8rem; color:var(--muted); margin-top:0.25rem;">Players type a free-text response. All responses appear live in a feed.</p>`;
    }

    body += `
      <div class="row-meta">
        <label>Time limit</label>
        <select onchange="questions[${i}].timeLimit=+this.value">
          ${[10,15,20,30,45,60,90,120].map(t => `<option value="${t}" ${q.timeLimit===t?'selected':''}>${t}s</option>`).join('')}
        </select>
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
  if (type === 'true_false') {
    q.options = ['True', 'False'];
    if (q.correct !== 0 && q.correct !== 1) q.correct = 0;
  }
  if ((type === 'short_answer') && (!q.acceptedAnswers || q.acceptedAnswers.length === 0)) {
    q.acceptedAnswers = [''];
  }
  renderQuestions();
}

function setTrueFalse(i, val) {
  questions[i].correct = val;
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

function addOption(i) {
  questions[i].options.push('');
  renderQuestions();
}

function removeOption(i, j) {
  const q = questions[i];
  q.options.splice(j, 1);
  if (q.correct === j) q.correct = 0;
  else if (q.correct > j) q.correct--;
  renderQuestions();
}

function addAcceptedAnswer(i) {
  questions[i].acceptedAnswers.push('');
  renderQuestions();
}

function removeAcceptedAnswer(i, j) {
  questions[i].acceptedAnswers.splice(j, 1);
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

function handleImageUpload(i, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    showToast('Image too large — please use one under 3MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    questions[i].image = e.target.result;
    renderQuestions();
  };
  reader.readAsDataURL(file);
}

function removeImage(i) {
  questions[i].image = null;
  renderQuestions();
}

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── ROOM CREATION ─────────────────────────────────────────────

function createRoom() {
  let valid;
  if (entryMode === 'excel') {
    valid = excelQuestions
      .filter(q => (!q._rowErrors || q._rowErrors.length === 0) && q.text.trim())
      .map(q => {
        const clean = { ...q };
        delete clean._rowErrors;
        if (clean.type === 'short_answer') {
          clean.acceptedAnswers = clean.acceptedAnswers.filter(a => a.trim());
        }
        return clean;
      });
  } else {
    valid = questions.filter(q => {
      if (!q.text.trim()) return false;
      if (q.type === 'multiple_choice') return q.options.filter(o => o.trim()).length >= 2;
      if (q.type === 'true_false') return true;
      if (q.type === 'short_answer') return q.acceptedAnswers.filter(a => a.trim()).length >= 1;
      return true;
    }).map(q => ({
      ...q,
      acceptedAnswers: q.acceptedAnswers ? q.acceptedAnswers.filter(a => a.trim()) : undefined,
    }));
  }

  if (valid.length === 0) { showToast('Add at least one valid question first'); return; }

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

// ── FULLSCREEN PRESENT MODE ────────────────────────────────────

function togglePresent() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => showToast('Fullscreen not supported in this browser'));
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll('.present-btn').forEach(b => {
    b.textContent = document.fullscreenElement ? '⤡ Exit present' : '⛶ Present';
  });
});

// ── SOCKET: HOST EVENTS ───────────────────────────────────────

socket.on('room:players_updated', ({ players }) => {
  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-list').innerHTML = players.map(p =>
    `<div class="player-chip">${escHtml(p.name)}</div>`
  ).join('');
});

socket.on('host:question', (payload) => {
  showScreen('question');
  const { index, total, text, image, options, correct, acceptedAnswers, timeLimit, playerCount, type, displayStyle, mode } = payload;

  document.getElementById('q-progress').textContent = `Question ${index+1} of ${total}`;
  document.getElementById('q-text').textContent = text;
  document.getElementById('ans-count').textContent = '0';
  document.getElementById('ans-total').textContent = playerCount;
  document.getElementById('next-btn').textContent = 'Skip →';

  const imgEl = document.getElementById('q-image');
  if (image) { imgEl.src = image; imgEl.style.display = 'block'; }
  else { imgEl.style.display = 'none'; }

  document.getElementById('options-display').style.display = 'none';
  document.getElementById('live-chart-wrap').style.display = 'none';
  document.getElementById('wordcloud-wrap').style.display = 'none';
  document.getElementById('feed-wrap').style.display = 'none';
  document.getElementById('text-answer-host-wrap').style.display = 'none';

  if (type === 'multiple_choice' || type === 'true_false') {
    if (mode === 'trivia') {
      document.getElementById('options-display').style.display = 'grid';
      document.getElementById('options-display').innerHTML = options.map(o => `<div class="opt-card">${escHtml(o)}</div>`).join('');
    } else {
      document.getElementById('live-chart-wrap').style.display = 'block';
      renderLiveChart(options, options.map(() => 0), displayStyle || 'bars');
    }
  } else if (type === 'short_answer') {
    document.getElementById('text-answer-host-wrap').style.display = 'block';
    document.getElementById('text-answer-host-wrap').innerHTML = mode === 'trivia'
      ? `<p style="color:var(--muted); font-size:0.95rem;">Players are typing their answers now…</p>`
      : `<div class="feed-wrap" id="feed-wrap-inline"><span style="color:var(--muted); font-size:0.9rem;">Waiting for responses…</span></div>`;
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
  if ((type === 'multiple_choice' || type === 'true_false') && liveChart) {
    liveChart.data.datasets[0].data = counts;
    liveChart.update();
  } else if (type === 'word_cloud') {
    renderWordCloud('wordcloud-wrap', responses);
  } else if (type === 'open_ended') {
    renderFeed('feed-wrap', responses);
  } else if (type === 'short_answer') {
    const inline = document.getElementById('feed-wrap-inline');
    if (inline) renderFeed('feed-wrap-inline', responses);
  }
});

socket.on('game:question_ended', (data) => {
  clearInterval(timerInterval);
  const delay = (data.type === 'multiple_choice' || data.type === 'true_false') ? 1200 : 200;
  setTimeout(() => showResults(data), delay);
});

socket.on('game:ended', ({ leaderboard, mode }) => {
  clearInterval(timerInterval);
  if (mode === 'trivia' && leaderboard && leaderboard.length) {
    showPodium(leaderboard);
  } else {
    document.getElementById('final-subtitle').textContent = 'Poll complete — thanks for participating';
    document.getElementById('final-lb-card').style.display = 'none';
    document.getElementById('podium-wrap').style.display = 'none';
    showScreen('final');
  }
});

function showResults(data) {
  document.getElementById('results-correct-card').style.display = 'none';
  document.getElementById('results-chart-card').style.display = 'none';
  document.getElementById('results-wordcloud-card').style.display = 'none';
  document.getElementById('results-feed-card').style.display = 'none';
  document.getElementById('results-text-card').style.display = 'none';
  document.getElementById('results-lb-card').style.display = 'none';

  if (data.type === 'multiple_choice' || data.type === 'true_false') {
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
  } else if (data.type === 'short_answer') {
    if (data.mode === 'trivia') {
      document.getElementById('results-text-card').style.display = 'block';
      document.getElementById('results-text-card').innerHTML = `
        <h2>Correct answer</h2>
        <p style="font-size:1.2rem; font-weight:700; color:var(--green); margin-top:0.5rem;">${escHtml(data.correctText)}</p>
        <p style="font-size:0.9rem; color:var(--muted); margin-top:0.5rem;">${data.correctCount} of ${data.totalAnswered} players got it right</p>
      `;
      if (data.leaderboard && data.leaderboard.length) {
        document.getElementById('results-lb-card').style.display = 'block';
        renderLeaderboard('results-lb', data.leaderboard);
      }
    } else {
      document.getElementById('results-feed-card').style.display = 'block';
      renderFeed('results-feed', data.responses);
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
        scales: { y: { beginAtZero: true, max: showPercentage ? 100 : undefined, ticks: { precision: 0, color: '#5A7A9E', callback: (v) => showPercentage ? v+'%' : v }, grid: { color: 'rgba(12,42,77,0.08)' } },
                  x: { ticks: { color: '#5A7A9E' }, grid: { display: false } } } } };
  }
  if (style === 'donut' || style === 'pie') {
    return { type: style === 'donut' ? 'doughnut' : 'pie', data: { labels, datasets: [{ data: displayData, backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#0C2A4D' } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } } } } };
  }
  return { type: 'bubble', data: { datasets: labels.map((l, i) => ({
      label: `${l}: ${fmt(displayData[i])}`, data: [{ x: i, y: 0, r: Math.max(6, Math.sqrt(data[i]) * 12) }], backgroundColor: colors[i]
    })) },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#0C2A4D' } } },
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

// ── KAHOOT-STYLE PODIUM ────────────────────────────────────────

function showPodium(leaderboard) {
  showScreen('final');
  document.getElementById('final-subtitle').textContent = 'Game over — final standings';
  document.getElementById('podium-wrap').style.display = 'block';
  document.getElementById('final-lb-card').style.display = 'none';

  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);
  const podiumEl = document.getElementById('podium-wrap');

  const podiumOrder = [
    { rank: 2, data: top3[1] },
    { rank: 1, data: top3[0] },
    { rank: 3, data: top3[2] },
  ].filter(p => p.data);

  podiumEl.innerHTML = `
    <div class="podium-stage">
      ${podiumOrder.map(p => `
        <div class="podium-col podium-rank-${p.rank}" id="podium-col-${p.rank}">
          <div class="podium-player" id="podium-player-${p.rank}" style="opacity:0;">
            <div class="podium-medal">${p.rank===1?'🥇':p.rank===2?'🥈':'🥉'}</div>
            <div class="podium-name">${escHtml(p.data.name)}</div>
            <div class="podium-score">${p.data.score.toLocaleString()}</div>
          </div>
          <div class="podium-block podium-block-${p.rank}"><span class="podium-rank-num">${p.rank}</span></div>
        </div>
      `).join('')}
    </div>
    ${rest.length ? `<div class="card" style="margin-top:2rem;"><h2>Full leaderboard</h2><ul class="lb-list" id="podium-rest-lb"></ul></div>` : ''}
  `;

  if (rest.length) renderLeaderboard('podium-rest-lb', rest);

  // Animate reveal: 3rd, then 2nd, then 1st
  const revealOrder = [3, 2, 1];
  revealOrder.forEach((rank, idx) => {
    setTimeout(() => {
      const block = document.querySelector(`.podium-block-${rank}`);
      const player = document.getElementById(`podium-player-${rank}`);
      if (block) block.classList.add('grown');
      if (player) {
        setTimeout(() => { player.style.opacity = '1'; player.style.transform = 'translateY(0)'; }, 300);
      }
    }, idx * 700);
  });
}

// ── RESULTS EXPORT ───────────────────────────────────────────

async function downloadResults() {
  if (!roomCode) { showToast('No game data to export'); return; }
  const btn = document.getElementById('download-results-btn');
  const originalText = btn.textContent;
  btn.textContent = 'Preparing file…';
  btn.disabled = true;

  try {
    const res = await fetch(`/api/results/${roomCode}`);
    if (!res.ok) throw new Error('Could not fetch results — the room may have expired.');
    const data = await res.json();
    buildResultsWorkbook(data);
  } catch (err) {
    showToast(err.message || 'Failed to download results');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function buildResultsWorkbook(data) {
  const rows = [];

  // ── Section 1: Final leaderboard ──
  rows.push(['FINAL LEADERBOARD']);
  if (data.mode === 'trivia') {
    rows.push(['Rank', 'Name', 'Score']);
    data.leaderboard.forEach(p => rows.push([p.rank, p.name, p.score]));
  } else {
    rows.push(['This was a Poll/Survey game — no scoring.']);
  }
  rows.push([]);
  rows.push([]);

  // ── Section 2: Per-question breakdown ──
  data.questions.forEach(q => {
    rows.push([`Question ${q.index + 1}: ${q.text}`]);
    rows.push([`Type: ${q.type.replace('_', ' ')}`]);
    if (q.correctAnswer) rows.push([`Correct answer: ${q.correctAnswer}`]);
    rows.push([]);

    if (q.type === 'word_cloud' || q.type === 'open_ended') {
      rows.push(['Name', 'Response']);
      q.answers.forEach(a => rows.push([a.name, a.answerText]));
    } else if (data.mode === 'trivia') {
      rows.push(['Name', 'Answer', 'Correct?', 'Points']);
      q.answers.forEach(a => rows.push([a.name, a.answerText, a.correct ? 'Yes' : 'No', a.points]));
    } else {
      rows.push(['Name', 'Answer']);
      q.answers.forEach(a => rows.push([a.name, a.answerText]));
    }
    rows.push([]);
    rows.push([]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 40 }, { wch: 14 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');

  const filename = `quizdrop-results-${data.roomCode}.xlsx`;
  XLSX.writeFile(wb, filename);
}

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
    disp.style.color = remaining <= 5 ? '#C0392B' : 'var(--accent)';
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

// Poll host for live tally every 2s while a question is active
setInterval(() => {
  if (document.getElementById('screen-question').classList.contains('active')) {
    socket.emit('host:request_live_tally');
  }
}, 2000);

// ── HERO TICKER ANIMATION (decorative, runs once on load) ─────

function animateHeroTicker() {
  const heights = { 1: 100, 2: 65, 3: 40 };
  const questions = [
    'Which planet has the most moons?',
    'What year did the first iPhone launch?',
    'Who painted the Mona Lisa?',
    'What is the capital of Australia?',
  ];
  const nameSets = [
    ['Maya', 'Devon', 'Priya'],
    ['Sam', 'Yuki', 'Theo'],
    ['Noor', 'Lucas', 'Ade'],
  ];
  let setIndex = 0;

  function runCycle() {
    const names = nameSets[setIndex % nameSets.length];
    document.getElementById('ticker-question').textContent = questions[setIndex % questions.length];
    [1,2,3].forEach((rank, idx) => {
      const nameEl = document.getElementById(`ticker-name-${rank}`);
      const barEl = document.getElementById(`ticker-bar-${rank}`);
      if (!nameEl || !barEl) return;
      nameEl.classList.remove('show');
      barEl.style.height = '0px';
      setTimeout(() => {
        nameEl.textContent = names[idx === 0 ? 1 : idx === 1 ? 0 : 2] || names[idx];
        nameEl.classList.add('show');
        barEl.style.height = heights[rank] + 'px';
      }, 150 + idx * 200);
    });
    setIndex++;
  }

  runCycle();
  setInterval(runCycle, 4000);
}

if (document.getElementById('ticker-podium')) {
  setTimeout(animateHeroTicker, 400);
}

// Init
addQuestion();
