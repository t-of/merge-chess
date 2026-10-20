'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'merge-chess.' で始める。
const STORE = 'merge-chess.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'merge-chess', text: '中央のマスがところどころ長方形につながった盤で遊ぶ、2人対戦のチェス' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----

const $ = (id) => document.getElementById(id);
// 効果音（Web Audio）。設定は覚えておく。
let soundOn = load('sound', true) !== false;
let actx = null;
function beep(freq, dur, delay) {
  if (!soundOn) return;
  try {
    setAudioSession(true);
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), gn = actx.createGain();
    const t0 = actx.currentTime + (delay || 0);
    o.type = 'triangle'; o.frequency.value = freq;
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn); gn.connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch { /* 鳴らせなくても遊べる */ }
}
function soundBtn() {
  $('btn-sound').textContent = soundOn ? '音：入' : '音：切';
  $('btn-sound').setAttribute('aria-pressed', String(soundOn));
}

const GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const g = (p) => GLYPH[p.toUpperCase()] + '︎';

let T, states, keys, notes, lastMoves, cur, selected = null, pending = null, flipped = false, seed;

function newSeed() { return Math.floor(Math.random() * 1000000); }

function startGame(s) {
  seed = s;
  T = MC.generateTerrain(seed);
  const st = MC.initialState();
  states = [st]; keys = [MC.positionKey(st, T)]; notes = []; lastMoves = [null];
  selected = null; pending = null;
  cur = MC.evaluate(st, T, keys);
  save('seed', seed);
  render();
}

function curState() { return states[states.length - 1]; }

function play(m) {
  const st = curState();
  let note = MC.notation(st, T, m);
  const ns = MC.applyMove(st, T, m);
  states.push(ns); keys.push(MC.positionKey(ns, T)); lastMoves.push(m);
  cur = MC.evaluate(ns, T, keys);
  if (cur.check) note += cur.result && cur.result.winner ? '#' : '+';
  notes.push(note);
  selected = null; pending = null;
  if (cur.result) { beep(523, 0.15); beep(392, 0.15, 0.15); beep(262, 0.3, 0.3); }
  else if (cur.check) { beep(660, 0.1); beep(880, 0.15, 0.1); }
  else beep(m.capture ? 300 : 440, 0.09);
  render();
}

function undo() {
  if (states.length < 2) return;
  states.pop(); keys.pop(); notes.pop(); lastMoves.pop();
  cur = MC.evaluate(curState(), T, keys);
  selected = null; pending = null;
  render();
}

function onCell(id) {
  if (cur.result) return;
  const st = curState();
  if (pending) { pending = null; selected = null; render(); return; }
  if (selected != null) {
    const ms = cur.moves.filter((m) => m.from === selected && m.to === id);
    if (ms.length === 1) { play(ms[0]); return; }
    if (ms.length > 1) { pending = ms; render(); return; }
  }
  const p = st.board[id];
  if (p && MC.colorOf(p) === st.turn && cur.moves.some((m) => m.from === id)) selected = selected === id ? null : id;
  else selected = null;
  render();
}

function render() {
  const st = curState();
  const board = $('board');
  board.textContent = '';
  const lm = lastMoves[lastMoves.length - 1];
  const kc = cur.check ? st.board.indexOf(st.turn === 'w' ? 'K' : 'k') : -1;
  const targets = new Map();
  if (selected != null) for (const m of cur.moves) if (m.from === selected) targets.set(m.to, m.capture);
  const dr = (r) => (flipped ? r : 7 - r);
  const dc = (c) => (flipped ? 7 - c : c);
  for (const id of T.cellIds) {
    const cell = T.cells[id];
    const b = document.createElement('button');
    b.type = 'button';
    const rows = [dr(cell.r0), dr(cell.r1)], cols = [dc(cell.c0), dc(cell.c1)];
    b.style.gridRow = (Math.min(...rows) + 1) + ' / ' + (Math.max(...rows) + 2);
    b.style.gridColumn = (Math.min(...cols) + 1) + ' / ' + (Math.max(...cols) + 2);
    let cls = 'cell';
    if (cell.merged) cls += ' merged';
    else if ((cell.r0 + cell.c0) % 2 === 1) cls += ' light';
    if (lm && (lm.from === id || lm.to === id)) cls += ' last';
    if (id === kc) cls += ' chk';
    if (id === selected) cls += ' sel';
    if (targets.has(id)) cls += ' tgt' + (targets.get(id) ? ' cap' : '');
    b.className = cls;
    const p = st.board[id];
    b.setAttribute('aria-label', MC.cellLabel(T, id) + (p ? ' ' + p : ''));
    if (p) {
      const s = document.createElement('span');
      s.className = 'pc ' + MC.colorOf(p);
      s.textContent = g(p);
      b.appendChild(s);
    }
    if (!cell.merged) {
      if (dr(cell.r0) === 7) { const f = document.createElement('span'); f.className = 'coord f'; f.textContent = 'abcdefgh'[cell.c0]; b.appendChild(f); }
      if (dc(cell.c0) === 0) { const f = document.createElement('span'); f.className = 'coord r'; f.textContent = cell.r0 + 1; b.appendChild(f); }
    }
    b.addEventListener('click', () => onCell(id));
    board.appendChild(b);
  }

  // 手番・王手
  const status = $('status');
  status.textContent = '';
  if (!cur.result) {
    status.append((st.turn === 'w' ? '白' : '黒') + 'の番');
    if (cur.check) { const s = document.createElement('span'); s.className = 'chk'; s.textContent = '　王手！'; status.appendChild(s); }
  } else status.textContent = '対局終了';

  // 結果
  const res = $('result');
  res.hidden = !cur.result;
  if (cur.result) res.textContent = (cur.result.winner ? (cur.result.winner === 'w' ? '白の勝ち' : '黒の勝ち') : '引き分け') + '：' + cur.result.reason;

  // 昇格の選択
  const promo = $('promo');
  promo.hidden = !pending;
  promo.textContent = '';
  if (pending) {
    promo.append('昇格：');
    for (const m of pending) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = g(st.turn === 'w' ? m.promo : m.promo.toLowerCase());
      btn.setAttribute('aria-label', m.promo);
      btn.addEventListener('click', () => play(m));
      promo.appendChild(btn);
    }
  }

  $('seed').textContent = seed;
  $('btn-undo').disabled = states.length < 2;

  // 棋譜
  const mv = $('moves');
  mv.textContent = '';
  notes.forEach((n, i) => {
    if (i % 2 === 0) { const s = document.createElement('span'); s.className = 'n'; s.textContent = (i / 2 + 1) + '.'; mv.appendChild(s); }
    const s = document.createElement('span'); s.className = 'm'; s.textContent = n; mv.appendChild(s);
  });
  mv.scrollTop = mv.scrollHeight;
}

$('btn-new').addEventListener('click', () => startGame(newSeed()));
$('btn-sound').addEventListener('click', () => { soundOn = !soundOn; save('sound', soundOn); setAudioSession(soundOn); soundBtn(); beep(440, 0.08); });
$('btn-undo').addEventListener('click', undo);
$('btn-flip').addEventListener('click', () => { flipped = !flipped; render(); });
$('seedform').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseInt($('seedin').value, 10);
  if (Number.isFinite(v) && v >= 0 && v <= 999999) startGame(v);
});

soundBtn();
startGame(newSeed());
