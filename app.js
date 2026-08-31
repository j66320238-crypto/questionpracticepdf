/* ===== Mock Exam Pro — PDF question paper test interface =====
   Exam Mode    : timed CBT-style test, auto-submit, key matching later
   Practice Mode: untimed drill, instant green/red feedback, final summary
   Auto-detect  : questions, options & answer key parsed from the PDF text
   100% static / offline — host on Render, Netlify, Vercel, GH Pages, or file:// */
'use strict';

const LS_KEY = 'mockexam_session_v1';
const LS_THEME = 'mockexam_theme';
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let state = null;            // persisted session
let uploadedFile = null;     // PDF File
let blobUrl = null;
let pdfDoc = null;
let workerReady = false;
let pageCache = new Map();
async function initPdfWorker(){
  if(workerReady) return;
  // Prefer a real worker when the environment allows it (normal browsers).
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  // Also run the worker script on the main thread: in sandboxed iframes / file://
  // pages where new Worker() is blocked, pdf.js automatically uses this as a
  // "fake worker", so PDF rendering still works everywhere.
  if(!globalThis.pdfjsWorker){
    const src = await (await fetch('lib/pdf.worker.min.js')).text();
    const sc = document.createElement('script');
    sc.textContent = src;
    document.documentElement.appendChild(sc);
    sc.remove();
  }
  if(!globalThis.pdfjsWorker) throw new Error('PDF worker init failed');
  workerReady = true;
}
let fitScale = 1, zoomFactor = 1, currentPage = 1;
let renderToken = 0, lastRenderTask = null;
let curQ = 1;
let timerInt = null;
let detection = null;        // {questions:[{num,text,options}], key|null, total}
let selectedMode = 'exam';   // 'exam' | 'practice'
let audioCtx = null;

/* ---------------- helpers ---------------- */
function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}
function escHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function saveState(){ if(state){ try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){} } }
function loadState(){ try{ return JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){ return null; } }
function clearState(){ try{ localStorage.removeItem(LS_KEY); }catch(e){} }
function toast(msg, ms=2800){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), ms);
}
function show(id){
  $$('.screen').forEach(s=>s.classList.add('hidden'));
  $(id).classList.remove('hidden');
  window.scrollTo(0,0);
}
function getPick(q){ return state.mode === 'practice' ? state.locked[q] : state.answers[q]; }
function countAnswered(){
  if(!state) return 0;
  const src = state.mode === 'practice' ? state.locked : state.answers;
  return Object.keys(src).length;
}
function countMarked(){ return state ? Object.keys(state.marked).length : 0; }

/* ---------------- theme ---------------- */
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  $$('[data-theme-btn]').forEach(b=>b.textContent = t === 'dark' ? '☀️' : '🌙');
  try{ localStorage.setItem(LS_THEME, t); }catch(e){}
}
function toggleTheme(){ applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
function initTheme(){
  let t = null;
  try{ t = localStorage.getItem(LS_THEME); }catch(e){}
  if(!t) t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  applyTheme(t);
}

/* ---------------- setup screen ---------------- */
function wireSetup(){
  const drop = $('#pdfDrop');
  drop.addEventListener('click', ()=>$('#pdfFile').click());
  $('#pdfFile').addEventListener('change', async e=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    uploadedFile = f;
    const n = $('#pdfName');
    n.textContent = '✅ ' + f.name; n.classList.add('ok');
    if(state && !state.submitted && !$('#examScreen').classList.contains('hidden')){
      await loadPdf();
      if($('#autoDetect').checked) await runDetection();
    } else if(!state){
      await loadPdf();
      if($('#autoDetect').checked) await runDetection();
    }
  });
  $$('.presets button').forEach(b=>b.addEventListener('click', ()=>{
    const m = +b.dataset.min;
    $('#th').value = Math.floor(m/60); $('#tm').value = m % 60; $('#ts').value = 0;
  }));
  const me = $('#modeExam'), mp = $('#modePractice');
  me.addEventListener('click', ()=>selectMode('exam'));
  mp.addEventListener('click', ()=>selectMode('practice'));
  $('#loadSample').addEventListener('click', loadSample);
  const provSel = $('#aiProvider');
  function fillProviderDefaults(){
    const p = AI_PRESETS[provSel.value];
    if(provSel.value !== 'custom'){
      $('#aiBase').value = p.base || '';
      if(!$('#aiModel').value) $('#aiModel').value = p.model || '';
    } else {
      $('#aiBase').placeholder = 'e.g. https://api.openai.com/v1';
      $('#aiModel').placeholder = 'e.g. gpt-4o-mini';
    }
    $('#baseRow').classList.toggle('hidden', provSel.value !== 'custom');
  }
  provSel.addEventListener('change', ()=>{
    fillProviderDefaults();
    saveAiCfg(uiCfg());
    updateKeyStatus();
  });
  ['aiModel','aiBase','aiKeys'].forEach(id => {
    document.getElementById(id).addEventListener('change', ()=>{
      saveAiCfg(uiCfg());
      updateKeyStatus();
    });
  });
  const saved = loadAiCfg();
  if(saved){
    if(saved.provider) provSel.value = saved.provider;
    $('#aiModel').value = saved.model || (AI_PRESETS[saved.provider || 'gemini'] || {}).model || '';
    $('#aiBase').value = saved.base || '';
    $('#aiKeys').value = (saved.keys || []).join('\n');
  }
  fillProviderDefaults();
  $('#aiKeySetup').addEventListener('click', async ()=>{
    if(aiRunning){ toast('AI is already working — wait or stop it'); return; }
    if(!detection || !detection.questions.length){ alert('Upload a PDF first and let auto-detect run — the AI needs the question text to solve.'); return; }
    const cfg = buildCfgFromUi();
    if(!cfg.keys.length){
      alert('No AI keys found.\n\nPaste 1 or more keys (one per line) in the "AI Answer Finder" box.\nFREE: Gemini — aistudio.google.com → Get API key\nFREE: Groq — console.groq.com → API Keys\n\nOr on Render: set the GEMINI_API_KEYS / GROQ_API_KEYS env vars.');
      return;
    }
    aiRunning = true; aiStopFlag = false;
    $('#aiKeySetup').disabled = true;
    try{
      const res = await aiSolveAll(detection.questions, (i, n, num) => {
        $('#aiKeySetup').textContent = '🤖 Solving Q' + num + '… (' + i + '/' + n + ')';
      }, cfg);
      if(res.solved){
        const ordered = Object.keys(res.map).map(Number).sort((a, b) => a - b);
        $('#keyInput2').value = ordered.map(k => k + '. ' + res.map[k]).join('  ');
        toast('🤖 ' + res.solved + ' AI answers filled in the Answer Key box');
      } else {
        alert('No answers found — check keys / rate limit. (Add more keys, or wait 30s.)');
      }
    }catch(e){
      alert('AI error: ' + (e && e.message ? e.message : e));
    }
    aiRunning = false;
    $('#aiKeySetup').disabled = false;
    $('#aiKeySetup').textContent = '🤖 Get AI Key';
  });
  $('#autoDetect').addEventListener('change', ()=>{
    if(uploadedFile && pdfDoc && $('#autoDetect').checked) runDetection();
    else { detection = null; $('#detectStatus').classList.remove('show'); }
  });
  $('#startBtn').addEventListener('click', startExam);
}
function selectMode(m){
  selectedMode = m;
  $('#modeExam').classList.toggle('sel', m === 'exam');
  $('#modePractice').classList.toggle('sel', m === 'practice');
  $('#startBtn').textContent = m === 'exam' ? '🚀 Start Exam' : '🎮 Start Practice';
}
async function loadSample(){
  try{
    const r = await fetch('sample-paper.pdf');
    if(!r.ok) throw new Error('not found');
    const b = await r.blob();
    uploadedFile = new File([b], 'sample-paper.pdf', {type:'application/pdf'});
    const n = $('#pdfName');
    n.textContent = '✅ sample-paper.pdf'; n.classList.add('ok');
    await loadPdf();
    if($('#autoDetect').checked) await runDetection();
    toast('Sample paper loaded — 15 questions with answer key');
  }catch(e){
    alert('Sample paper could not be loaded here.\n\nIt works when the app is served (this preview, Render, Netlify…) — not from a local file:// page.');
  }
}

/* ---------------- start / enter ---------------- */
function startExam(){
  const prev = loadState();
  if(prev && prev.total && !prev.submitted &&
     !confirm('A saved test is in progress: ' + prev.name + ' (' + countOfSession(prev) + '/' + prev.total + ' answered).\n\nStart a NEW test and discard the saved one?')) return;
  const name  = $('#examName').value.trim() || 'Mock Exam';
  let total   = parseInt($('#totalQ').value, 10) || 0;
  const dur   = (parseInt($('#th').value,10)||0)*3600 + (parseInt($('#tm').value,10)||0)*60 + (parseInt($('#ts').value,10)||0);
  const pos   = parseFloat($('#posMark').value) || 0;
  const neg   = parseFloat($('#negMark').value) || 0;
  const mode  = selectedMode;
  const autoAdvance = $('#autoAdvance').checked;
  const sound = $('#soundOn').checked;
  const strict = $('#strictMode').value;

  let keyMap = null, keyStr = '';
  let keySource = null;
  if(detection && detection.key){
    keyMap = detection.key;
    keyStr = Object.keys(detection.key).map(k => k + '. ' + detection.key[k]).join('  ');
    keySource = 'pdf';
  }
  if(mode === 'practice'){
    if(!keyMap){
      const r = parseKey($('#keyInput2').value, 500);
      if(r.count > 0){ keyMap = r.map; keyStr = $('#keyInput2').value.trim(); keySource = 'manual'; }
    }
    if(!keyMap && !confirm('Practice Mode works best with an answer key (green/red feedback).\nNo key was detected or pasted.\n\nStart without a feedback key?')) return;
  }
  if(detection && detection.questions.length) total = detection.questions.length;
  if(!total || total < 1){ alert('Total questions: set a number between 1 and 500.'); return; }
  if(mode === 'exam' && dur <= 0){ alert('Set a test duration (at least 1 minute).'); return; }

  state = {
    name, total, duration: dur, pos, neg,
    mode, autoAdvance, sound, strict, violations: 0,
    answers: {}, locked: {}, marked: {}, visited: {},
    startedAt: Date.now(), endTime: Date.now() + (mode === 'exam' ? dur : 0)*1000,
    submitted: false, submittedReason: '',
    key: keyStr, keyMap, keySource,
    detected: detection ? {questions: detection.questions, key: detection.key} : null,
    curQ: 1, demoPaper: false
  };
  curQ = 1;
  saveState();
  enterExam(false);
}

function enterExam(resumed){
  show('#examScreen');
  $('#headerExamName').textContent = state.name;
  const badge = $('#modeBadge');
  badge.textContent = state.mode === 'practice' ? 'PRACTICE' : 'EXAM';
  badge.classList.toggle('practice', state.mode === 'practice');
  $('#timer').classList.toggle('hidden', state.mode === 'practice');
  const sb = $('#submitBtn');
  sb.textContent = state.mode === 'practice' ? 'Finish' : 'Submit';
  sb.classList.toggle('finish', state.mode === 'practice');
  $('.q-num .q-total').textContent = ' / ' + state.total;
  $$('.q-num .q-total').forEach(el=>el.textContent = ' / ' + state.total);
  buildPalette();

  const hasDet = !!(state.detected && state.detected.questions.length);
  setTab(hasDet ? 'question' : 'answer');
  renderAll();

  if(pdfDoc){ renderPage(); }
  else if(state.demoPaper){ showPaperPlaceholder('📘 <b>DEMO PAPER</b> — your question paper PDF will appear here.'); }
  else { showPaperPlaceholder('No PDF yet. Use 📁 <b>Change PDF</b> to pick your question paper.<br>You can also run a test without one — just use the Answer tab.'); }

  if(state.mode === 'exam') startTimer();
  else { stopTimer(); $('#timer').textContent = '00:00:00'; }
  if(resumed) toast('Session resumed — where you left off', 3000);
}

/* ---------------- timer (Exam Mode only) ---------------- */
function startTimer(){ stopTimer(); timerInt = setInterval(tick, 500); tick(); }
function stopTimer(){ if(timerInt){ clearInterval(timerInt); timerInt = null; } }
function tick(){
  if(!state || state.submitted || state.mode !== 'exam') return;
  const left = Math.max(0, Math.round((state.endTime - Date.now())/1000));
  const t = $('#timer');
  t.textContent = fmtTime(left);
  t.classList.toggle('warn', left > 0 && left <= 300);
  t.classList.toggle('danger', left > 0 && left <= 60);
  if(left <= 0) timeUp();
  else if(state.sound && (left === 60 || left === 30) && t._lastBeep !== left){ t._lastBeep = left; beep(1); }
}
function timeUp(){
  stopTimer();
  $('#timer').textContent = '00:00:00';
  $('#timer').classList.add('danger');
  if(state.sound) beep(3);
  strictPausedLeft = null;
  state.submitted = true;
  state.submittedReason = 'Time Up';
  saveState();
  showResult('time');
}

$('#submitBtn').addEventListener('click', ()=>{
  if(!state || state.submitted) return;
  if(state.mode === 'exam'){
    const a = countAnswered();
    if(!confirm('SUBMIT THE TEST?\n\nAnswered: ' + a + ' / ' + state.total + '\nNot answered: ' + (state.total - a) + '\n\nYou cannot change answers after submitting.')) return;
    state.submitted = true; state.submittedReason = 'Submitted';
    strictPausedLeft = null;
  } else {
    const a = countAnswered();
    if(a < state.total && !confirm('Finish practice now?\n\nCompleted: ' + a + ' / ' + state.total + '. Unanswered questions will count as skipped.')) return;
    finishPractice('Practice finished');
    return;
  }
  saveState(); stopTimer();
  showResult('manual');
});

/* ---------------- exit / resume (user-friendly back) ---------------- */
function countOfSession(s2){
  return Object.keys(s2.mode === 'practice' ? (s2.locked || {}) : (s2.answers || {})).length;
}
function refreshResumeBar(){
  const bar = $('#resumeBar');
  if(!bar) return;
  const s2 = loadState();
  if(s2 && s2.total && !s2.submitted){
    const left = Math.max(0, Math.round((s2.endTime - Date.now())/1000));
    $('#resumeText').textContent = '📌 Saved test: ' + s2.name + ' — ' + countOfSession(s2) + '/' + s2.total +
      ' answered (' + (s2.mode === 'practice' ? 'practice' : 'exam') +
      (s2.mode === 'exam' ? ', ' + fmtTime(left) + ' left' : '') + ')';
    bar.classList.remove('hidden');
  } else bar.classList.add('hidden');
}
function showSetup(){
  show('#setupScreen');
  refreshResumeBar();
}
$('#exitBtn').addEventListener('click', ()=>{
  if(!state) return;
  if(state.submitted){ showSetup(); return; }
  if(confirm('Exit to setup screen?\n\nYour progress is SAFE — resume the same test later from the setup screen.')){
    saveState();
    stopTimer();
    showSetup();
  }
});
$('#resumeBtn').addEventListener('click', ()=>{
  const s2 = loadState();
  if(!s2 || !s2.total) return;
  state = s2;
  curQ = s2.curQ || 1;
  if(s2.mode === undefined) s2.mode = 'exam';
  if(!s2.locked) s2.locked = {};
  if(!s2.violations) s2.violations = 0;
  if(!s2.strict) s2.strict = 'off';
  if(!s2.autoAdvance) s2.autoAdvance = true;
  refreshResumeBar();
  if(s2.submitted){ showResult('resume'); return; }
  if(s2.mode === 'exam' && s2.endTime <= Date.now()){
    s2.submitted = true; s2.submittedReason = 'Time Up';
    saveState();
    showResult('time');
    return;
  }
  enterExam(true);
});
$('#discardBtn').addEventListener('click', ()=>{
  if(!confirm('Discard the saved test? Answers will be deleted.')) return;
  clearState();
  state = null;
  refreshResumeBar();
});

/* ---------------- tabs ---------------- */
function setTab(t){
  document.body.dataset.tab = t;
  $$('#mobileTabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab === t));
  const isSide = ['question','answer','palette'].includes(t);
  $$('.spanel').forEach(p=>p.classList.toggle('active', isSide && p.id === t + 'Panel'));
  $$('#sideTabs button').forEach(b=>b.classList.toggle('active', isSide ? b.dataset.stab === t : b.dataset.stab === 'question'));
}
$$('#mobileTabs button').forEach(b=>b.addEventListener('click', ()=>setTab(b.dataset.tab)));
$$('#sideTabs button').forEach(b=>b.addEventListener('click', ()=>setTab(b.dataset.stab)));

/* ---------------- question view (auto-detected) ---------------- */
function renderQuestionView(){
  $('#qvNum').textContent = curQ;
  const body = $('#qvBody');
  const det = state.detected;
  const q = det ? det.questions.find(x => x.num === curQ) : null;
  const pick = getPick(curQ);
  const isPractice = state.mode === 'practice';
  const key = state.keyMap ? state.keyMap[curQ] : '';

  if(!q){
    body.innerHTML =
      '<div class="qv-none">No text was detected for this question in the PDF — use the A–D buttons below.</div>' +
      bigOptGrid(pick, isPractice, key);
    wireOptButtons(body);
    return;
  }
  const opts = q.options;
  let statusHtml = '';
  if(isPractice && pick){
    if(!key) statusHtml = '<div class="qv-status nokey">No answer key for this question</div>';
    else if(pick === key) statusHtml = '<div class="qv-status ok">✓ Correct <b>+' + state.pos + '</b></div>';
    else statusHtml = '<div class="qv-status bad">✗ Wrong <b>−' + state.neg + '</b> &nbsp;·&nbsp; Correct answer: <b>' + key + '</b></div>';
  }
  const rows = ['A','B','C','D'].map(L => {
    let cls = 'qvopt';
    if(isPractice && pick && key){
      if(L === key) cls += ' right';
      if(pick === L && L !== key) cls += ' wrong';
    } else if(pick === L) cls += ' sel';
    const dis = (isPractice && pick) ? ' disabled' : '';
    const txt = opts[L] ? escHtml(opts[L]) : '<i>options not detected — tap to select ' + L + '</i>';
    return '<button class="' + cls + '" data-opt="' + L + '"' + dis + '><span class="qvL">' + L + '</span><span class="qvT">' + txt + '</span></button>';
  }).join('');
  body.innerHTML =
    '<div class="qv-text">' + escHtml(q.text) + '</div>' +
    '<div class="qv-opts">' + rows + '</div>' +
    statusHtml +
    '<div class="qv-foot">' +
      '<button class="chip-btn" id="qvMarkBtn' + (state.marked[curQ] ? ' active' : '') + '">' + (state.marked[curQ] ? '🚩 Marked' : '🚩 Mark') + '</button>' +
      '<button class="chip-btn" id="qvClearBtn">Clear</button>' +
      '<span class="spacer"></span>' +
      '<span style="font-size:13px;font-weight:600">Go to Q</span>' +
      '<input id="qvJump" type="number" value="' + curQ + '" min="1" max="' + state.total + '">' +
      '<button class="chip-btn" id="qvJumpGo">Go</button>' +
    '</div>';
  wireOptButtons(body);
  $('#qvMarkBtn').addEventListener('click', toggleMark);
  $('#qvClearBtn').addEventListener('click', clearPick);
  $('#qvJumpGo').addEventListener('click', ()=>gotoQ(parseInt($('#qvJump').value, 10)));
  $('#qvJump').addEventListener('keydown', e=>{ if(e.key === 'Enter') gotoQ(parseInt($('#qvJump').value,10)); });
}
function bigOptGrid(pick, isPractice, key){
  return '<div class="opts">' + ['A','B','C','D'].map(L=>{
    let cls = 'opt';
    if(isPractice && pick && key){ if(L===key) cls+=' right'; if(pick===L && L!==key) cls+=' wrong'; }
    else if(pick===L) cls += ' sel';
    return '<button class="' + cls + '" data-opt="' + L + '"' + (isPractice && pick ? ' disabled' : '') + '>' + L + '</button>';
  }).join('') + '</div>';
}
function wireOptButtons(container){
  container.querySelectorAll('.opt[data-opt],.qvopt[data-opt]').forEach(b=>{
    if(b.disabled) return;
    b.addEventListener('click', ()=>pickAnswer(curQ, b.dataset.opt));
  });
}
$('#qvPrev').addEventListener('click', ()=>gotoQ(curQ - 1));
$('#qvNext').addEventListener('click', ()=>gotoQ(curQ + 1));

/* ---------------- answering ---------------- */
function pickAnswer(q, opt){
  if(!state || state.submitted) return;
  state.visited[q] = 1;
  if(state.mode === 'practice'){
    if(state.locked[q]){ toast('Practice: your pick is locked'); return; }
    state.locked[q] = opt;
    saveState();
    renderAll();
    if(state.autoAdvance){
      if(q < state.total) gotoQSilent(q + 1);
      else maybeFinishPractice();
    }
    return;
  }
  state.answers[q] = opt;
  saveState();
  renderAll();
  if(state.autoAdvance && q < state.total){
    curQ = q + 1; state.curQ = curQ; saveState(); renderAll();
  }
}
function gotoQSilent(q){
  curQ = Math.max(1, Math.min(state.total, q));
  state.curQ = curQ;
  state.visited[curQ] = 1;
  saveState();
  renderAll();
}
function gotoQ(q){ if(!state) return; gotoQSilent(q); }
function toggleMark(){
  if(!state || state.submitted) return;
  state.visited[curQ] = 1;
  if(state.marked[curQ]) delete state.marked[curQ]; else state.marked[curQ] = 1;
  saveState(); renderAll();
}
function clearPick(){
  if(!state || state.submitted) return;
  if(state.mode === 'practice'){
    if(state.locked[curQ]){ toast('Practice: answers are locked once selected'); return; }
  } else {
    delete state.answers[curQ];
  }
  state.visited[curQ] = 1;
  saveState(); renderAll();
}
function maybeFinishPractice(){
  if(state && !state.submitted && state.mode === 'practice' && countAnswered() >= state.total){
    finishPractice('All questions completed');
  }
}
function finishPractice(reason){
  if(state.submitted) return;
  strictPausedLeft = null;
  state.submitted = true;
  state.submittedReason = reason || 'Practice finished';
  saveState();
  showResult('practice');
}

/* ---------------- answer sheet panel ---------------- */
function renderAnswerPanel(){
  $('#curQ').textContent = curQ;
  $('#jumpQ').max = state.total;
  $('#jumpQ').value = curQ;
  const pick = getPick(curQ), m = !!state.marked[curQ], v = !!state.visited[curQ];
  const isPractice = state.mode === 'practice';
  const key = state.keyMap ? state.keyMap[curQ] : '';
  const badge = $('#qStatusBadge');
  let txt, cls;
  if(isPractice && pick){
    if(!key){ txt = 'Locked (no key)'; cls = ''; }
    else if(pick === key){ txt = '✓ Correct'; cls = 'p-ok'; }
    else { txt = '✗ Wrong — correct: ' + key; cls = 'p-bad'; }
  } else if(pick && m){ txt = 'Answered + Marked'; cls = 'am'; }
  else if(pick){ txt = 'Answered ✓'; cls = 'a'; }
  else if(m){ txt = 'Marked for Review 🚩'; cls = 'm'; }
  else if(v){ txt = 'Not Answered'; cls = 'n'; }
  else { txt = 'Not Visited'; cls = ''; }
  badge.textContent = txt;
  badge.className = 'badge ' + cls;
  $$('#answerPanel .opt').forEach(b=>{
    let cls2 = 'opt';
    if(isPractice && pick && key){ if(b.dataset.opt===key) cls2 += ' right'; if(pick===b.dataset.opt && b.dataset.opt!==key) cls2 += ' wrong'; }
    else if(pick === b.dataset.opt) cls2 += ' sel';
    b.className = cls2;
    b.disabled = !!(isPractice && pick);
  });
  const mb = $('#markBtn');
  mb.classList.toggle('active', m);
  mb.textContent = m ? '🚩 Marked (tap to unmark)' : '🚩 Mark for Review';
}
$$('#answerPanel .opt').forEach(b=>b.addEventListener('click', ()=>pickAnswer(curQ, b.dataset.opt)));
$('#markBtn').addEventListener('click', toggleMark);
$('#clearBtn').addEventListener('click', clearPick);
$('#qPrev').addEventListener('click', ()=>gotoQ(curQ - 1));
$('#qNext').addEventListener('click', ()=>gotoQ(curQ + 1));
$('#jumpGo').addEventListener('click', ()=>gotoQ(parseInt($('#jumpQ').value, 10)));
$('#jumpQ').addEventListener('keydown', e=>{ if(e.key === 'Enter') gotoQ(parseInt($('#jumpQ').value,10)); });

function updateMiniStats(){
  const a = countAnswered(), m = countMarked(), n = state.total - a;
  $('#miniStats').innerHTML =
    '<span class="ms a">✓ ' + a + ' Answered</span>' +
    '<span class="ms m">🚩 ' + m + ' Marked</span>' +
    '<span class="ms n">✗ ' + n + ' Not Answered</span>';
  $('#msBar').style.width = Math.round(a / state.total * 100) + '%';
}

/* ---------------- palette ---------------- */
function buildPalette(){
  const g = $('#paletteGrid');
  g.innerHTML = '';
  const frag = document.createDocumentFragment();
  for(let q = 1; q <= state.total; q++){
    const b = document.createElement('button');
    b.className = 'pq'; b.textContent = q; b.dataset.q = q;
    b.addEventListener('click', ()=>{ gotoQSilent(q); setTab('question'); renderAll(); });
    frag.appendChild(b);
  }
  g.appendChild(frag);
  renderPalette();
}
function pqClass(q){
  const a = !!getPick(q), m = !!state.marked[q], v = !!state.visited[q];
  let c = 'pq';
  if(a && m) c += ' am'; else if(a) c += ' a'; else if(m) c += ' m'; else if(v) c += ' n';
  if(q === curQ) c += ' cur';
  return c;
}
function renderPalette(){ $$('#paletteGrid .pq').forEach(b=>{ b.className = pqClass(+b.dataset.q); }); }

function renderAll(){
  if(!state) return;
  renderQuestionView();
  renderAnswerPanel();
  renderPalette();
  updateMiniStats();
}

/* ---------------- PDF loading & rendering ---------------- */
function showPaperPlaceholder(html){
  $('#paperView').innerHTML = '<div class="paper-ph">' + html + '</div>';
  $('#pageLabel').textContent = '– / –';
  $('#zoomLabel').textContent = '100%';
  $('#prevPage').disabled = $('#nextPage').disabled = true;
  $('#openPdfTab').classList.add('hidden');
}
async function loadPdf(){
  if(!uploadedFile){ showPaperPlaceholder('No PDF yet — tap 📁 <b>Change PDF</b> (or “Load Sample Paper” on the setup screen).'); return; }
  const view = $('#paperView');
  view.innerHTML = '<div class="paper-ph">⏳ Loading PDF…</div>';
  if(blobUrl){ try{ URL.revokeObjectURL(blobUrl); }catch(e){} }
  blobUrl = URL.createObjectURL(uploadedFile);
  pdfDoc = null;
  pageCache.clear();
  try{
    if(!window.pdfjsLib) throw new Error('pdf.js missing');
    await initPdfWorker();
    const data = await uploadedFile.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({data, isEvalSupported:false}).promise;
    currentPage = 1;
    await renderPage();
    $('#openPdfTab').classList.remove('hidden');
  }catch(err){
    console.warn('pdf.js render failed, falling back to native viewer:', err);
    pdfDoc = null;
    fallbackEmbed();
  }
}
async function renderPage(){
  if(!pdfDoc) return;
  const view = $('#paperView');
  const cached = pageCache.get(currentPage);
  if(cached){
    view.innerHTML = '';
    view.appendChild(cached);
    $('#pageLabel').textContent = currentPage + ' / ' + pdfDoc.numPages;
    $('#zoomLabel').textContent = Math.round(zoomFactor * 100) + '%';
    $('#prevPage').disabled = currentPage <= 1;
    $('#nextPage').disabled = currentPage >= pdfDoc.numPages;
    view.scrollLeft = 0; view.scrollTop = 0;
    return;
  }
  const tok = ++renderToken;
  if(lastRenderTask){ try{ lastRenderTask.cancel(); }catch(e){} }
  try{
    const page = await pdfDoc.getPage(currentPage);
    const cw = Math.max(200, view.clientWidth - 20);
    const vp1 = page.getViewport({scale: 1});
    fitScale = Math.min(cw / vp1.width, 2.5);
    const scale = fitScale * zoomFactor;
    const vp = page.getViewport({scale});
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    view.innerHTML = '';
    view.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    lastRenderTask = page.render({
      canvasContext: ctx, viewport: vp,
      transform: dpr !== 1 ? [dpr,0,0,dpr,0,0] : null
    });
    await lastRenderTask.promise;
    if(tok !== renderToken) return;
    pageCache.set(currentPage, canvas);
    if(pageCache.size > 6) pageCache.delete(pageCache.keys().next().value);
    $('#pageLabel').textContent = currentPage + ' / ' + pdfDoc.numPages;
    $('#zoomLabel').textContent = Math.round(zoomFactor * 100) + '%';
    $('#prevPage').disabled = currentPage <= 1;
    $('#nextPage').disabled = currentPage >= pdfDoc.numPages;
    view.scrollLeft = 0; view.scrollTop = 0;
  }catch(e){ /* cancelled render */ }
}
function fallbackEmbed(){
  const view = $('#paperView');
  view.innerHTML = '';
  const em = document.createElement('embed');
  em.src = blobUrl; em.type = 'application/pdf'; em.className = 'pdf-embed';
  view.appendChild(em);
  const note = document.createElement('div');
  note.className = 'paper-ph';
  note.innerHTML = 'Built-in viewer is shown above. Tip: <a href="' + blobUrl + '" target="_blank" rel="noopener">open the PDF in a new tab</a> for a bigger view.';
  view.appendChild(note);
  $('#pageLabel').textContent = 'PDF viewer';
  $('#zoomLabel').textContent = '100%';
  $('#prevPage').disabled = $('#nextPage').disabled = true;
  $('#openPdfTab').classList.remove('hidden');
}
$('#zoomIn').addEventListener('click', ()=>{ zoomFactor = Math.min(3, +(zoomFactor + 0.25).toFixed(2)); pageCache.clear(); renderPage(); });
$('#zoomOut').addEventListener('click', ()=>{ zoomFactor = Math.max(0.4, +(zoomFactor - 0.25).toFixed(2)); pageCache.clear(); renderPage(); });
$('#nextPage').addEventListener('click', ()=>{ if(pdfDoc && currentPage < pdfDoc.numPages){ currentPage++; renderPage(); } });
$('#prevPage').addEventListener('click', ()=>{ if(pdfDoc && currentPage > 1){ currentPage--; renderPage(); } });
$('#changePdf').addEventListener('click', ()=>$('#changePdfInput').click());
$('#changePdfInput').addEventListener('change', async e=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  uploadedFile = f;
  toast('📄 PDF set: ' + f.name);
  await loadPdf();
});
$('#openPdfTab').addEventListener('click', ()=>{ if(blobUrl){ try{ window.open(blobUrl, '_blank'); }catch(e){} } });

/* ---------------- text extraction & auto-detection ---------------- */
async function extractPdfText(){
  if(!pdfDoc) return '';
  const parts = [];
  for(let p = 1; p <= pdfDoc.numPages; p++){
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    const lines = {};
    for(const it of tc.items){
      if(!it.str) continue;
      const y = Math.round(it.transform[5]);
      (lines[y] = lines[y] || []).push([it.transform[4], it.str]);
    }
    parts.push(Object.keys(lines).map(Number).sort((a,b)=>b-a)
      .map(y => lines[y].sort((a,b)=>a[0]-b[0]).map(o=>o[1]).join(' ')).join('\n'));
  }
  return parts.join('\n');
}
function extractOptions(block){
  const find = re => {
    const out = []; let m; re.lastIndex = 0;
    while((m = re.exec(block)) !== null) out.push({letter: m[1].toUpperCase(), index: m.index, full: m[0]});
    return out;
  };
  let marks = find(/\(\s*([A-Da-d])\s*\)\s*/g);
  if(marks.length < 2) marks = find(/(?:^|\n)\s*([A-Da-d])\s*[\.:)]\s+/gm);
  if(marks.length < 2) return {};
  const clean = []; const seen = {};
  for(const m of marks){ if(!seen[m.letter]){ seen[m.letter] = 1; clean.push(m); if(clean.length === 4) break; } }
  if(clean.length < 2) return {};
  const opts = {};
  clean.forEach((m, i) => {
    const end = i + 1 < clean.length ? clean[i+1].index : block.length;
    let t = block.slice(m.index + m.full.length, end).replace(/\s+/g, ' ').trim();
    t = t.replace(/\.+$/,'').slice(0, 160);
    opts[m.letter] = t;
  });
  return opts;
}
function parsePairsIn(text, cap){
  const map = {};
  // lookbehind stops false hits from big numbers like "4,300" / "1,50,000"
  const re = /(?<![\d,])(\d{1,3})\s*[-–.:)\]]?\s*([A-Da-d])\b/g;
  let m;
  while((m = re.exec(text)) !== null){
    const q = +m[1];
    if(q >= 1 && q <= cap && !(q in map)) map[q] = m[2].toUpperCase();
  }
  return map;
}
function detectAnswerKey(text, total){
  const cap = total > 0 ? total : 200;
  let map = {};
  const hm = /(^|\n)\s*(?:ANSWERS?\s*(?:KEY|SHEET|TABLE)?|KEY\s*ANSWERS?|SOLUTIONS?)\b/i.exec(text);
  if(hm){
    map = parsePairsIn(text.slice(hm.index + hm[0].length), cap);
    if(Object.keys(map).length < 3) map = parsePairsIn(text, cap);
  } else {
    map = parsePairsIn(text, cap);
  }
  const keys = Object.keys(map).map(Number);
  if(keys.length < 3) return {};
  if(Math.min.apply(null, keys) !== 1) return {};
  if(total > 0 && keys.length < Math.max(3, Math.floor(total / 2))) return {};
  return map;
}
function keyHeadingPos(text){
  const m = /(^|\n)\s*(?:ANSWERS?\s*(?:KEY|SHEET|TABLE)?|KEY\s*ANSWERS?|SOLUTIONS?)\b/i.exec(text);
  return m ? m.index : -1;
}
function detectPaper(text, fallbackTotal){
  const keyPos = keyHeadingPos(text);
  const qRe = /(?:^|\n)[ \t]*(?:Q\.?[ \t]*|Question[ \t]+)?(\d{1,3})[ \t]*[).][ \t]+/g;
  const found = [];
  let m, last = 0;
  while((m = qRe.exec(text)) !== null){
    const num = +m[1];
    if(num < 1 || num > 500 || num <= last) continue;
    last = num;
    found.push({num, index: m.index, start: m.index + m[0].length});
  }
  let questions = [];
  if(found.length >= 3 && found[0].num === 1){
    for(let i = 0; i < found.length; i++){
      let end = i + 1 < found.length ? found[i+1].index : Math.min(text.length, found[i].start + 900);
      if(keyPos > found[i].start && keyPos < end) end = keyPos;
      const block = text.slice(found[i].start, end);
      const opts = extractOptions(block);
      // cut the question text at the first option marker, so options don't repeat in the text
      let cut = -1;
      const mParen = /\(\s*[A-Da-d]\s*\)\s*/.exec(block);
      const mLine = /(?:^|\n)\s*[A-Da-d]\s*[\.:)]\s+/.exec(block);
      if(mParen) cut = mParen.index;
      if(mLine && (cut === -1 || mLine.index < cut)) cut = mLine.index;
      const qblock = cut > 0 ? block.slice(0, cut) : block;
      questions.push({num: found[i].num, text: qblock.replace(/\s+/g, ' ').trim().slice(0, 400), options: opts});
    }
  }
  const key = detectAnswerKey(text, questions.length || fallbackTotal);
  return {
    questions,
    key: Object.keys(key).length >= 3 ? key : null,
    total: questions.length || fallbackTotal
  };
}
async function runDetection(){
  const box = $('#detectStatus');
  if(!uploadedFile){ detection = null; box.classList.remove('show'); return; }
  if(!pdfDoc){ try{ await loadPdf(); }catch(e){} }
  if(!pdfDoc || !$('#autoDetect').checked){ detection = null; box.classList.remove('show'); return; }
  box.textContent = '⏳ Detecting questions, options & answer key…';
  box.classList.add('show');
  try{
    const text = await extractPdfText();
    detection = detectPaper(text, parseInt($('#totalQ').value, 10) || 0);
    const n = detection.questions.length;
    const nOpts = detection.questions.filter(q=>Object.keys(q.options).length >= 2).length;
    let msg = '';
    if(n){
      $('#totalQ').value = n;
      msg = '✅ ' + n + ' questions detected (' + nOpts + ' with options)';
    } else {
      msg = '⚠️ Could not auto-detect numbered questions — the Answer tab (A–D) still works';
    }
    if(detection.key){
      const keys = Object.keys(detection.key).map(Number).sort((a,b)=>a-b);
      msg += ' · 🔑 Answer key found (' + keys.length + '/' + (detection.total || '?') + ')';
      $('#keyInput2').value = keys.map(k => k + '. ' + detection.key[k]).join('  ');
    } else {
      msg += ' · no answer key found (paste one for Practice Mode)';
    }
    box.textContent = msg;
  }catch(e){
    detection = null;
    box.textContent = '⚠️ Auto-detection failed — Answer tab still works.';
  }
}

/* ---------------- strict mode (tab/window switch) ---------------- */
let strictPausedLeft = null;
let lastStrictLog = 0;
function onLeaveApp(){
  if(!state || state.submitted || state.mode !== 'exam') return;
  if(!state.strict || state.strict === 'off') return;
  const now = Date.now();
  if(now - lastStrictLog < 1500) return;
  lastStrictLog = now;
  state.violations = (state.violations || 0) + 1;
  if(state.strict === 'pause'){
    strictPausedLeft = Math.max(0, state.endTime - Date.now());
    stopTimer();
  }
  saveState();
}
function onBackApp(){
  if(!state || state.submitted) return;
  tick();
  if(state.mode !== 'exam') return;
  if(!state.strict || state.strict === 'off') return;
  if(strictPausedLeft != null){
    state.endTime = Date.now() + strictPausedLeft;
    strictPausedLeft = null;
    saveState();
    startTimer();
    showStrictBanner('Timer was paused while you were away — it has resumed now.');
  } else if(state.violations){
    showStrictBanner();
  }
}
function showStrictBanner(msg){
  const b = $('#strictBanner');
  b.textContent = '⚠ Strict Mode: ' + (msg || 'tab/window switch detected') +
    (state.violations ? ' — total switches: ' + state.violations : '');
  b.classList.add('show');
  clearTimeout(b._h); b._h = setTimeout(()=>b.classList.remove('show'), 5000);
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', e=>{
  if(!state || state.submitted) return;
  if($('#examScreen').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toUpperCase();
  if(tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if(k === 'A' || k === 'B' || k === 'C' || k === 'D') pickAnswer(curQ, k);
  else if(e.key === 'ArrowLeft') gotoQ(curQ - 1);
  else if(e.key === 'ArrowRight') gotoQ(curQ + 1);
});

/* ---------------- AI answer finder (Gemini / Groq / OpenAI, multi-key) ---------------- */
const AI_LS = 'mockexam_ai_cfg';
function loadAiCfg(){ try{ return JSON.parse(localStorage.getItem(AI_LS) || 'null'); }catch(e){ return null; } }
function saveAiCfg(c){ try{ localStorage.setItem(AI_LS, JSON.stringify(c)); }catch(e){} }
const AI_PRESETS = {
  gemini: { base: '', model: 'gemini-2.5-flash' },
  groq:   { base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { base: '', model: '' }
};
function parseKeys(text){
  return (text || '').split(/[\n,;]+/).map(x => x.trim()).filter(x => x.length > 5);
}
let serverKeys = { gemini: [], groq: [], openai: [] };
async function fetchServerKeys(){
  try{
    const r = await fetch('api/ai-config', {cache: 'no-store'});
    if(!r.ok) return;
    const j = await r.json();
    serverKeys = {
      gemini: j.gemini || [],
      groq: j.groq || [],
      openai: j.openai || []
    };
    const n = serverKeys.gemini.length + serverKeys.groq.length + serverKeys.openai.length;
    if(n > 0) updateKeyStatus();
  }catch(e){ /* static hosting / file:// — no server keys */ }
}
function uiCfg(){
  const saved = loadAiCfg() || {};
  return {
    provider: ($('#aiProvider') ? $('#aiProvider').value : 'gemini'),
    model: ($('#aiModel') ? $('#aiModel').value.trim() : ''),
    base: ($('#aiBase') ? $('#aiBase').value.trim() : ''),
    localKeys: parseKeys($('#aiKeys') ? $('#aiKeys').value : '')
  };
}
// combined pool = server env keys + your local keys (for the chosen provider)
function keyPool(provider){
  const ui = uiCfg();
  const srv = (serverKeys[provider] || []).slice();
  const loc = ui.localKeys.slice();
  return srv.concat(loc);
}
function buildCfgFromUi(){
  const ui = uiCfg();
  const keys = keyPool(ui.provider);
  const preset = AI_PRESETS[ui.provider] || {};
  return {
    provider: ui.provider,
    model: ui.model || preset.model || '',
    base: ui.provider === 'custom' ? ui.base : (preset.base || ''),
    keys
  };
}
let keyCursor = {};
let keyCooldown = {};
function nextKeyIndex(provider, poolSize){
  if(poolSize === 0) return -1;
  const now = Date.now();
  for(let i = 0; i < poolSize; i++){
    const idx = ((keyCursor[provider] || 0) + i) % poolSize;
    const until = keyCooldown[provider + ':' + idx] || 0;
    if(until < now) return idx;
  }
  // all cooling: pick the one cooling down least
  let best = 0, bestUntil = Infinity;
  for(let i = 0; i < poolSize; i++){
    const until = keyCooldown[provider + ':' + i] || 0;
    if(until < bestUntil){ bestUntil = until; best = i; }
  }
  return best;
}
function setCooldown(provider, idx, ms){ keyCooldown[provider + ':' + idx] = Date.now() + ms; }

function aiPromptForQ(q){
  let t = 'Question: ' + (q.text || 'See the options.');
  const opts = q.options || {};
  if(Object.keys(opts).length >= 2){
    ['A','B','C','D'].forEach(L => { if(opts[L]) t += '\n(' + L + ') ' + opts[L]; });
  }
  t += '\n\nWhat is the correct option? Reply with ONLY one letter: A, B, C or D.';
  return t;
}
function parseAiLetter(txt){
  if(!txt) return null;
  const up = String(txt).toUpperCase().trim();
  // 1) explicit: "ANSWER IS C", "OPTION (B)", "CORRECT: D", "KEY: A"
  let m = up.match(/\b(?:ANSWER|OPTION|CORRECT|KEY)\s*(?:IS|:|=)?\s*\(?([A-D])\b/);
  if(m) return m[1];
  // standalone letter token: "A", "(B)", "C.", "D," ...
  const standalone = /(^|[\s,.:;(\[])(\(?[A-D]\)?)(?=[\s,.:;)\]]|$)/;
  const letters = [];
  let mm;
  const re = new RegExp(standalone.source, 'g');
  while((mm = re.exec(up)) !== null) letters.push(mm[2].replace(/[^A-D]/g, ''));
  if(!letters.length) return null;
  // 2) short reply -> first letter; long explanation -> last letter (final verdict)
  return up.length <= 25 ? letters[0] : letters[letters.length - 1];
}
async function solveWithKey(provider, key, model, base, prompt){
  if(provider === 'gemini'){
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model || 'gemini-2.5-flash') + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: {parts: [{text: 'You are an expert exam answer solver. You always give the single correct option.'}]},
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {temperature: 0, maxOutputTokens: 40}
      })
    });
    if(!r.ok){
      const e = new Error('Gemini API ' + r.status);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    const txt = j.candidates && j.candidates[0] && j.candidates[0].content
      ? j.candidates[0].content.parts.map(p => p.text || '').join('') : '';
    return parseAiLetter(txt);
  }
  // groq / openai / custom — OpenAI-compatible chat/completions
  const b = (base || '').replace(/\/+$/, '');
  const r = await fetch(b + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 20,
      messages: [
        { role: 'system', content: 'You are an expert exam answer solver. You always give the single correct option.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if(!r.ok){
    const e = new Error('API ' + r.status);
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  const txt = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  return parseAiLetter(txt);
}
async function aiSolveOne(q, cfg){
  const poolSize = cfg.keys.length;
  if(poolSize === 0) throw new Error('no-key');
  const prompt = aiPromptForQ(q);
  let lastErr = null;
  // try up to all keys (rotation), skipping cooling-down ones
  for(let attempt = 0; attempt < poolSize; attempt++){
    const idx = nextKeyIndex(cfg.provider, poolSize);
    if(idx < 0) break;
    keyCursor[cfg.provider] = (idx + 1) % poolSize;
    const key = cfg.keys[idx];
    try{
      const letter = await solveWithKey(cfg.provider, key, cfg.model, cfg.base, prompt);
      return letter;
    }catch(e){
      lastErr = e;
      if(e && (e.status === 429 || e.status === 403 || e.status === 401 || (e.status || 0) >= 500)){
        setCooldown(cfg.provider, idx, 30000); // rate limit / auth -> cool down, try next key
        continue;
      }
      throw e; // other errors (network, bad model) -> stop
    }
  }
  throw lastErr || new Error('All keys failed (rate limit) — add more keys or wait a bit.');
}
let aiStopFlag = false;
async function aiSolveAll(questions, onProgress, cfg){
  if(!cfg || !cfg.keys.length) throw new Error('no-key');
  const map = {}; let solved = 0, failed = 0;
  for(let i = 0; i < questions.length; i++){
    if(aiStopFlag) break;
    onProgress && onProgress(i + 1, questions.length, questions[i].num);
    try{
      const L = await aiSolveOne(questions[i], cfg);
      if(L){ map[questions[i].num] = L; solved++; } else failed++;
    }catch(e){
      failed++;
      if(e && e.message === 'no-key') throw e;
    }
    await new Promise(res => setTimeout(res, 400)); // gentle pacing
  }
  return {map, solved, failed, stopped: aiStopFlag};
}
function updateKeyStatus(){
  const el = $('#keyStatus');
  if(!el) return;
  const ui = uiCfg();
  const pool = keyPool(ui.provider);
  const srv = (serverKeys[ui.provider] || []).length;
  let txt = '🔑 Key pool (' + ui.provider + '): ' + pool.length +
    (pool.length ? ' — ' + srv + ' from server env, ' + (pool.length - srv) + ' added by you' : ' — no keys yet');
  if(!ui.model && AI_PRESETS[ui.provider]) txt += ' · model: ' + (AI_PRESETS[ui.provider].model || 'default');
  el.textContent = txt;
  el.classList.add('show');
}
function applyAiKey(map){
  const ordered = Object.keys(map).map(Number).sort((a, b) => a - b);
  $('#keyInput').value = ordered.map(k => k + '. ' + map[k]).join('  ');
  state.key = $('#keyInput').value;
  state.keyMap = map;
  state.keySource = 'ai';
  saveState();
  renderResult();
}
let aiRunning = false;
async function runAiFind(){
  if(aiRunning) return;
  const cfg = buildCfgFromUi();
  if(!cfg.keys.length){
    if(confirm('No AI API keys found.\n\nAdd your keys in Setup → "AI Answer Finder" (multiple keys, one per line).\nFREE options: Gemini (aistudio.google.com) or Groq (console.groq.com).\nIf this app is on Render, set GEMINI_API_KEYS / GROQ_API_KEYS env vars.\n\nOpen Setup now?')) showSetup();
    return;
  }
  if(!state.detected || !state.detected.questions.length){
    alert('No detected questions in this PDF — the AI answer finder needs question text + options.\nUpload a text-based PDF (not a scanned image).');
    return;
  }
  // if we already have AI answers, solve only the missing ones (retry after rate limit)
  const prevAi = (state.keySource === 'ai' && state.keyMap) ? state.keyMap : null;
  let questions = state.detected.questions;
  if(prevAi){
    questions = questions.filter(q => !prevAi[q.num]);
    if(!questions.length){
      $('#aiStatus').textContent = 'All questions already have AI answers.';
      return;
    }
  }
  aiRunning = true; aiStopFlag = false;
  const btn = $('#aiFindBtn'), stopB = $('#aiStopBtn');
  btn.disabled = true; stopB.classList.remove('hidden');
  $('#aiStatus').textContent = '🤖 ' + (prevAi ? 'Retrying ' + questions.length + ' missing… ' : 'Starting… ') + '(' + cfg.keys.length + ' key(s) in rotation)';
  try{
    const res = await aiSolveAll(questions, (i, n, num) => {
      btn.textContent = '🤖 Solving Q' + num + '… (' + i + '/' + n + ')';
    }, cfg);
    if(!res.solved){
      $('#aiStatus').textContent = (res.stopped ? '⏹ Stopped. ' : '') + '❌ No answers found — check keys / rate limit. Add more keys or retry after 30s.';
    } else {
      applyAiKey(prevAi ? Object.assign({}, prevAi, res.map) : res.map);
      const totalMapped = Object.keys(state.keyMap).length;
      $('#aiStatus').textContent = '🤖 ' + res.solved + ' more answers found (key now ' + totalMapped + '/' + state.total + ')' +
        (res.failed ? ' — ' + res.failed + ' still missing (rate limit?): press Find Answers again to retry only those' : '') +
        (res.stopped ? ' (stopped early)' : '') + '.';
    }
  }catch(e){
    $('#aiStatus').textContent = '❌ ' + (e && e.message ? e.message : e);
  }
  aiRunning = false;
  btn.disabled = false;
  btn.textContent = '🤖 Find Answers (AI)';
  stopB.classList.add('hidden');
}
$('#aiFindBtn').addEventListener('click', runAiFind);
$('#aiStopBtn').addEventListener('click', ()=>{ aiStopFlag = true; $('#aiStatus').textContent = '⏹ Stopping…'; });

/* ---------------- result ---------------- */
function computeResult(){
  const keyMap = state.keyMap || {};
  let correct = 0, wrong = 0, skipped = 0, nokey = 0;
  const rows = [];
  for(let q = 1; q <= state.total; q++){
    const mine = getPick(q) || '';
    const key = keyMap[q] || '';
    let st;
    if(!mine) st = 'skipped';
    else if(!key) st = 'nokey';
    else if(mine === key) st = 'correct';
    else st = 'wrong';
    if(st === 'correct') correct++;
    else if(st === 'wrong') wrong++;
    else if(st === 'skipped') skipped++;
    else nokey++;
    rows.push({q, mine, key, st});
  }
  const score = +(correct * state.pos - wrong * state.neg).toFixed(2);
  const answered = countAnswered();
  const acc = answered > 0 && (correct + wrong) > 0 ? Math.round(correct / (correct + wrong) * 100) : null;
  return {correct, wrong, skipped, nokey, score, rows, hasKey: !!state.keyMap, answered, acc};
}
function card(v, l, cls){ return '<div class="card ' + cls + '"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
async function copyAnswers(){
  if(!state) return;
  const txt = state.name + ' — answers: ' +
    Array.from({length: state.total}, (_, i) => (i+1) + ':' + (getPick(i+1) || '-')).join(' ');
  try{
    await navigator.clipboard.writeText(txt);
    toast('Copied all answers to clipboard');
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    let ok = false;
    try{ ok = document.execCommand('copy'); }catch(e2){}
    ta.remove();
    toast(ok ? 'Copied all answers' : 'Copy failed — select the text manually');
  }
}
function showResult(reason){
  stopTimer();
  if(!state) return;
  show('#resultScreen');
  $('#resultSub').textContent =
    reason === 'time'      ? '⏰ Time up! The test was auto-submitted — all answers are saved.' :
    reason === 'manual'    ? '✅ Test submitted — all answers are saved.' :
    reason === 'practice'  ? '🎮 Practice session finished — full summary below.' :
                             '📋 Saved session opened — all answers are intact.';
  $('#keyInput').value = state.key || '';
  const sn = $('#strictNote');
  if(state.violations && state.strict && state.strict !== 'off'){
    sn.textContent = '⚠ Strict mode: ' + state.violations + ' tab/window switch(es) recorded during this test.';
    sn.classList.add('show');
  } else sn.classList.remove('show');
  renderResult();
}
function renderResult(){
  const r = computeResult();
  const kd = $('#keyDisclaimer');
  if(state.keySource === 'ai'){
    kd.innerHTML = '⚠️ <b>AI-estimated answers</b> — the app found these automatically. <b>Mistakes are possible — please check/verify them yourself before final use.</b>';
    kd.classList.add('show');
  } else kd.classList.remove('show');
  $('#ansLine').innerHTML =
    '<b>Your answers (all ' + state.total + ' questions):</b><br><span class="mono">' +
    r.rows.map(x => x.q + ':' + (x.mine || '—')).join(' &nbsp; ') +
    '</span> <button class="chip-btn" id="copyAns">📋 Copy</button>';
  $('#copyAns').addEventListener('click', copyAnswers);
  let html =
    card(state.total, 'Total', '') +
    card(r.answered, 'Answered', 'ok') +
    card(countMarked(), 'Marked', '') +
    card(state.total - r.answered, 'Not Answered', 'skip');
  if(r.hasKey){
    html +=
      card(r.correct, 'Correct', 'ok') +
      card(r.wrong, 'Wrong', 'bad') +
      card(r.skipped + r.nokey, 'Skipped / No Key', 'skip') +
      (r.acc !== null ? card(r.acc + '%', 'Accuracy', 'score') : '') +
      card(r.score, 'Score', 'score');
  }
  $('#resultCards').innerHTML = html;
  $('#resultBody').innerHTML = r.rows.map(row=>{
    const label = {correct:'✓ Correct', wrong:'✗ Wrong', skipped:'— Skipped', nokey:'? No key'}[row.st];
    return '<tr class="st-' + row.st + '"><td>' + row.q + '</td><td><b>' + (row.mine || '—') + '</b></td><td>' + (row.key || '—') + '</td><td>' + label + '</td></tr>';
  }).join('');
}

/* manual key parsing (setup + result) */
function parseKey(text, total){
  text = (text || '').toUpperCase();
  const cap = total > 0 ? total : 500;
  const map = {};
  const pairRe = /Q?\s*(?<![\d,])(\d{1,3})\s*Q?\s*[:.\-)]?\s*([A-D])\b/g;
  let m, count = 0;
  while((m = pairRe.exec(text)) !== null){
    const q = +m[1];
    if(q >= 1 && q <= cap && !(q in map)){ map[q] = m[2]; count++; }
  }
  if(count === 0){
    const foreign = text.replace(/[-–—,.:;()\[\]{}Qq\s]/g, '');
    if(!/^[A-D]*$/.test(foreign)) return {map, count: 0};
    const letters = text.replace(/[^A-D]/g, '');
    for(let i = 0; i < letters.length && i < cap; i++) map[i+1] = letters[i];
    count = Math.min(letters.length, cap);
  }
  return {map, count};
}
$('#matchBtn').addEventListener('click', ()=>{
  if(!state) return;
  const txt = $('#keyInput').value;
  const r = parseKey(txt, state.total);
  if(r.count === 0){
    alert('Could not read the key. Use one of these formats:\n\n"1. A   2. B   3. C ..."  \nor just letters in order: "A B C D ..."');
    return;
  }
  if(r.count < state.total && !confirm('Found only ' + r.count + ' answers in the key (total ' + state.total + '). The rest will show "No key".\n\nContinue?')) return;
  state.key = txt.trim();
  state.keyMap = r.map;
  state.keySource = 'manual';
  saveState();
  renderResult();
  toast('✅ Matched — see your score');
});

function download(filename, text){
  const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}
$('#dlResponse').addEventListener('click', ()=>{
  if(!state) return;
  const L = [];
  L.push(state.name + ' — RESPONSE SHEET (' + state.mode.toUpperCase() + ' MODE)');
  L.push('Date: ' + new Date().toLocaleString());
  L.push('Total Q: ' + state.total);
  L.push('');
  const letters = [];
  for(let q = 1; q <= state.total; q++) letters.push(getPick(q) || '-');
  L.push('Quick line: ' + letters.join(' '));
  L.push('');
  for(let q = 1; q <= state.total; q++) L.push('Q' + q + ': ' + (getPick(q) || 'Not answered'));
  L.push('');
  L.push('Answered: ' + countAnswered() + '/' + state.total + ' | Marked: ' + countMarked());
  download(state.name.replace(/\s+/g, '_') + '_response.txt', L.join('\n'));
});
$('#dlResult').addEventListener('click', ()=>{
  if(!state) return;
  const r = computeResult();
  const L = [];
  L.push(state.name + ' — RESULT (' + state.mode.toUpperCase() + ' MODE)');
  L.push('Date: ' + new Date().toLocaleString());
  L.push('Answered: ' + r.answered + '/' + state.total);
  if(r.hasKey){
    L.push('Correct: ' + r.correct + ' | Wrong: ' + r.wrong + ' | Skipped: ' + r.skipped + ' | No key: ' + r.nokey +
      (r.acc !== null ? ' | Accuracy: ' + r.acc + '%' : ''));
    L.push('Marks: +' + state.pos + ' / -' + state.neg);
    L.push('SCORE: ' + r.score);
  }
  L.push('');
  L.push('Q | Yours | Key | Status');
  r.rows.forEach(row=>{
    L.push(row.q + ' | ' + (row.mine || '-') + ' | ' + (row.key || '-') + ' | ' +
      {correct:'CORRECT', wrong:'WRONG', skipped:'SKIPPED', nokey:'NO KEY'}[row.st]);
  });
  download(state.name.replace(/\s+/g, '_') + '_result.txt', L.join('\n'));
});
$('#newExam').addEventListener('click', ()=>{
  if(!confirm('Start a new exam?\n\nCurrent data (answers, timer) will be deleted.')) return;
  clearState();
  state = null;
  if(blobUrl){ try{ URL.revokeObjectURL(blobUrl); }catch(e){} blobUrl = null; }
  pdfDoc = null; uploadedFile = null; detection = null;
  const pf = $('#pdfFile'); if(pf) pf.value = '';
  const pn = $('#pdfName'); pn.textContent = '📄 Tap to choose a PDF'; pn.classList.remove('ok');
  $('#detectStatus').classList.remove('show');
  $('#keyInput2').value = '';
  showSetup();
});

/* ---------------- sound ---------------- */
function beep(times = 1){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    for(let i = 0; i < times; i++){
      const o = audioCtx.createOscillator(), g = autoGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'square'; o.frequency.value = 880;
      const t0 = audioCtx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.start(t0); o.stop(t0 + 0.32);
    }
  }catch(e){}
}
function autoGain(){ return audioCtx.createGain(); }

/* ---------------- demo (?demo) ---------------- */
async function bootDemo(){
  try{
    const r = await fetch('sample-paper.pdf');
    if(!r.ok) throw new Error('sample not found');
    uploadedFile = new File([await r.blob()], 'sample-paper.pdf', {type:'application/pdf'});
    const n = $('#pdfName');
    n.textContent = '✅ sample-paper.pdf (demo)'; n.classList.add('ok');
    await loadPdf();
    await runDetection();
    if(detection && detection.questions.length) $('#totalQ').value = detection.questions.length;
    $('#th').value = 0; $('#tm').value = 15; $('#ts').value = 0;
    selectMode('exam');
    startExam();
  }catch(e){
    toast('Demo sample paper could not be loaded');
  }
}

/* ---------------- boot ---------------- */
window.addEventListener('load', ()=>{
  initTheme();
  $$('[data-theme-btn]').forEach(b=>b.addEventListener('click', toggleTheme));
  wireSetup();

  if(location.search.includes('demo')){ bootDemo(); return; }

  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) onLeaveApp(); else onBackApp();
  });
  fetchServerKeys().then(()=>updateKeyStatus());

  const s = loadState();
  if(s && s.total){
    state = s;
    curQ = s.curQ || 1;
    if(state.mode === undefined) state.mode = 'exam';
    if(!state.locked) state.locked = {};
    if(!state.autoAdvance) state.autoAdvance = true;
    if(!state.violations) state.violations = 0;
    if(!state.strict) state.strict = 'off';
    if(!state.keySource) state.keySource = state.keyMap ? 'manual' : null;
    if(state.submitted){ showResult('resume'); return; }
    if(state.mode === 'exam' && s.endTime > Date.now()){ enterExam(true); return; }
    if(state.mode === 'practice'){ enterExam(true); return; }
    s.submitted = true; s.submittedReason = 'Time Up';
    saveState();
    showResult('time');
    return;
  }
  showSetup();
});

window.addEventListener('beforeunload', saveState);
