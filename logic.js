'use strict';
// merge-chess の遊ぶ部分（画面に依存しない）。ブラウザでは MC として、Node では require で使う。
//
// 盤は小マス 64 個（index = 段*8 + 筋、段 0 = 1 段目、筋 0 = a 筋）。
// 駒は「マス（大きいマスなら 1 つ）」に置く。マスの id は、その中で最小の小マスの index
// （つながっていない普通のマスは、小マスの index そのまま）。
// 駒は文字で持つ。大文字 = 白、小文字 = 黒（K Q R B N P）。
(function (root) {
  const FILES = 'abcdefgh';
  const sqName = (s) => FILES[s % 8] + (Math.floor(s / 8) + 1);
  const rowOf = (s) => s >> 3;
  const colOf = (s) => s & 7;
  const isWhite = (p) => p === p.toUpperCase();
  const colorOf = (p) => (isWhite(p) ? 'w' : 'b');
  const other = (c) => (c === 'w' ? 'b' : 'w');

  // ---- 地形 ----

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // rects: [{r0,c0,r1,c1}]（両端を含む）から地形を作る。
  function makeTerrain(rects, seed) {
    const cellOf = new Array(64);
    for (let s = 0; s < 64; s++) cellOf[s] = s;
    const cells = new Array(64);
    for (const q of rects) {
      const squares = [];
      for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) squares.push(r * 8 + c);
      const id = Math.min(...squares);
      for (const s of squares) cellOf[s] = id;
      cells[id] = { id, squares, r0: q.r0, c0: q.c0, r1: q.r1, c1: q.c1, merged: true };
    }
    const cellIds = [];
    for (let s = 0; s < 64; s++) {
      if (cellOf[s] !== s) continue;
      if (!cells[s]) cells[s] = { id: s, squares: [s], r0: rowOf(s), c0: colOf(s), r1: rowOf(s), c1: colOf(s), merged: false };
      cellIds.push(s);
    }
    return { seed: seed == null ? null : seed, rects, cellOf, cells, cellIds };
  }

  const SHAPES = [[2, 1], [1, 2], [2, 2], [3, 1], [1, 3]]; // [幅, 高さ]

  // 形は 3〜6 段目（段 2〜5）の内側。180° 回転した位置にも同じ形を置く。最大 5 組。
  function generateTerrain(seed) {
    const rnd = mulberry32(seed);
    const occ = new Array(64).fill(false);
    const rects = [];
    const target = 1 + Math.floor(rnd() * 5);
    let groups = 0;
    const squaresOf = (q) => {
      const a = [];
      for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) a.push(r * 8 + c);
      return a;
    };
    for (let attempt = 0; attempt < 80 && groups < target; attempt++) {
      const [w, h] = SHAPES[Math.floor(rnd() * SHAPES.length)];
      const c0 = Math.floor(rnd() * (9 - w));
      const r0 = 2 + Math.floor(rnd() * (5 - h));
      const a = { r0, c0, r1: r0 + h - 1, c1: c0 + w - 1 };
      const b = { r0: 7 - a.r1, r1: 7 - a.r0, c0: 7 - a.c1, c1: 7 - a.c0 };
      const self = a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;
      const list = self ? [a] : [a, b];
      const sq = list.map(squaresOf);
      if (!self && sq[0].some((s) => sq[1].includes(s))) continue; // 回転した形が元と重なる
      if (sq.some((l) => l.some((s) => occ[s]))) continue;
      sq.forEach((l) => l.forEach((s) => { occ[s] = true; }));
      list.forEach((q) => rects.push(q));
      groups++;
    }
    return makeTerrain(rects, seed);
  }

  // マスの名前。つながったマスは「左下:右上」。
  function cellLabel(T, id) {
    const c = T.cells[id];
    return c.merged ? sqName(c.r0 * 8 + c.c0) + ':' + sqName(c.r1 * 8 + c.c1) : sqName(id);
  }

  // ---- 局面 ----

  function initialState() {
    const board = new Array(64).fill(null);
    const back = 'RNBQKBNR';
    for (let c = 0; c < 8; c++) {
      board[c] = back[c];
      board[8 + c] = 'P';
      board[48 + c] = 'p';
      board[56 + c] = back[c].toLowerCase();
    }
    return { board, turn: 'w', castle: { wK: true, wQ: true, bK: true, bQ: true }, ep: null, epPawn: null, half: 0, full: 1 };
  }

  const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

  // 擬似合法手（王の安全は見ない）。attackOnly のときは「その色が利いているマス」を出す
  // （ポーンは斜めだけ、自分の駒のいるマスも含む）。
  function pseudo(st, T, color, attackOnly) {
    const board = st.board;
    const out = new Map();
    const add = (m) => {
      const k = m.from + '-' + m.to + '-' + (m.promo || '') + (m.ep ? 'e' : '');
      if (!out.has(k)) out.set(k, m);
    };
    for (const id of T.cellIds) {
      const p = board[id];
      if (!p || colorOf(p) !== color) continue;
      const type = p.toUpperCase();
      const squares = T.cells[id].squares;
      if (type === 'N' || type === 'K') {
        const offs = type === 'N' ? KNIGHT : KING;
        for (const s of squares) {
          for (const [dr, dc] of offs) {
            const r = rowOf(s) + dr, c = colOf(s) + dc;
            if (!inB(r, c)) continue;
            const tc = T.cellOf[r * 8 + c];
            if (tc === id) continue;
            const q = board[tc];
            if (q && colorOf(q) === color && !attackOnly) continue;
            add({ from: id, to: tc, capture: !!q });
          }
        }
      } else if (type === 'P') {
        const dir = color === 'w' ? 1 : -1;
        const startRow = color === 'w' ? 1 : 6;
        const lastRow = color === 'w' ? 7 : 0;
        for (const s of squares) {
          const r = rowOf(s), c = colOf(s);
          const r2 = r + dir;
          if (!inB(r2, 0)) continue;
          if (!attackOnly) {
            const c1 = T.cellOf[r2 * 8 + c];
            if (c1 !== id && !board[c1]) {
              if (r2 === lastRow) for (const pr of 'QRBN') add({ from: id, to: c1, promo: pr, capture: false });
              else add({ from: id, to: c1, capture: false });
              if (r === startRow) {
                const c2 = T.cellOf[(r + 2 * dir) * 8 + c];
                if (c2 !== c1 && c2 !== id && !board[c2]) add({ from: id, to: c2, capture: false, dbl: true, mid: c1 });
              }
            }
          }
          for (const dc of [-1, 1]) {
            if (!inB(r2, c + dc)) continue;
            const tc = T.cellOf[r2 * 8 + c + dc];
            if (tc === id) continue;
            const q = board[tc];
            if (attackOnly) { add({ from: id, to: tc, capture: true }); continue; }
            if (q && colorOf(q) !== color) {
              if (r2 === lastRow) for (const pr of 'QRBN') add({ from: id, to: tc, promo: pr, capture: true });
              else add({ from: id, to: tc, capture: true });
            } else if (!q && st.ep === tc && st.epPawn != null) {
              add({ from: id, to: tc, capture: true, ep: true });
            }
          }
        }
      } else {
        const dirs = type === 'R' ? ROOK : type === 'B' ? BISHOP : ROOK.concat(BISHOP);
        for (const s of squares) {
          for (const [dr, dc] of dirs) {
            let r = rowOf(s) + dr, c = colOf(s) + dc;
            while (inB(r, c)) {
              const tc = T.cellOf[r * 8 + c];
              if (tc !== id) {
                const q = board[tc];
                if (!q) add({ from: id, to: tc, capture: false });
                else {
                  if (colorOf(q) !== color || attackOnly) add({ from: id, to: tc, capture: colorOf(q) !== color });
                  break;
                }
              }
              r += dr; c += dc;
            }
          }
        }
      }
    }
    return [...out.values()];
  }

  function attackedCells(st, T, byColor) {
    return new Set(pseudo(st, T, byColor, true).map((m) => m.to));
  }

  function kingCell(st, color) {
    const k = color === 'w' ? 'K' : 'k';
    return st.board.indexOf(k);
  }

  function inCheck(st, T, color) {
    const k = kingCell(st, color);
    return k >= 0 && attackedCells(st, T, other(color)).has(k);
  }

  function applyMove(st, T, m) {
    const board = st.board.slice();
    const p = board[m.from];
    const white = isWhite(p);
    const castle = Object.assign({}, st.castle);
    let capture = !!board[m.to];
    board[m.from] = null;
    if (m.ep) { board[st.epPawn] = null; capture = true; }
    board[m.to] = m.promo ? (white ? m.promo : m.promo.toLowerCase()) : p;
    if (m.castle) {
      const base = white ? 0 : 56;
      if (m.castle === 'K') { board[base + 5] = board[base + 7]; board[base + 7] = null; }
      else { board[base + 3] = board[base]; board[base] = null; }
    }
    if (m.from === 4) { castle.wK = castle.wQ = false; }
    if (m.from === 60) { castle.bK = castle.bQ = false; }
    for (const s of [m.from, m.to]) {
      if (s === 0) castle.wQ = false;
      if (s === 7) castle.wK = false;
      if (s === 56) castle.bQ = false;
      if (s === 63) castle.bK = false;
    }
    const pawn = p.toUpperCase() === 'P';
    return {
      board, turn: other(st.turn), castle,
      ep: m.dbl ? m.mid : null, epPawn: m.dbl ? m.to : null,
      half: pawn || capture ? 0 : st.half + 1,
      full: st.full + (st.turn === 'b' ? 1 : 0),
    };
  }

  function legalMoves(st, T) {
    const color = st.turn;
    const moves = pseudo(st, T, color, false);
    // キャスリング
    const base = color === 'w' ? 0 : 56;
    const king = color === 'w' ? 'K' : 'k';
    const rook = color === 'w' ? 'R' : 'r';
    if (st.board[base + 4] === king && (st.castle[color + 'K'] || st.castle[color + 'Q'])) {
      const att = attackedCells(st, T, other(color));
      if (!att.has(base + 4)) {
        const b = st.board;
        if (st.castle[color + 'K'] && b[base + 7] === rook && !b[base + 5] && !b[base + 6] && !att.has(base + 5) && !att.has(base + 6)) {
          moves.push({ from: base + 4, to: base + 6, castle: 'K', capture: false });
        }
        if (st.castle[color + 'Q'] && b[base] === rook && !b[base + 1] && !b[base + 2] && !b[base + 3] && !att.has(base + 2) && !att.has(base + 3)) {
          moves.push({ from: base + 4, to: base + 2, castle: 'Q', capture: false });
        }
      }
    }
    return moves.filter((m) => !inCheck(applyMove(st, T, m), T, color));
  }

  // 同じ局面かどうかの鍵（アンパッサンは、実際に取れるときだけ含める）。
  function positionKey(st, T) {
    let ep = '-';
    if (st.ep != null && legalMoves(st, T).some((m) => m.ep)) ep = String(st.ep);
    const c = st.castle;
    return st.board.map((p) => p || '.').join('') + st.turn + (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '') + ep;
  }

  function insufficient(st) {
    const rest = st.board.filter((p) => p && p.toUpperCase() !== 'K');
    if (rest.length === 0) return true;
    return rest.length === 1 && 'BN'.includes(rest[0].toUpperCase());
  }

  // keys: これまでの局面の鍵（いまの局面を含む）。
  function evaluate(st, T, keys) {
    const moves = legalMoves(st, T);
    const check = inCheck(st, T, st.turn);
    let result = null;
    if (!moves.length) {
      result = check
        ? { winner: other(st.turn), reason: 'チェックメイト' }
        : { winner: null, reason: 'ステイルメイト（指せる手がない）' };
    } else if (insufficient(st)) {
      result = { winner: null, reason: '駒不足（どちらもチェックメイトできない）' };
    } else if (st.half >= 100) {
      result = { winner: null, reason: '50手ルール（50手のあいだ、ポーンも取りもなし）' };
    } else if (keys && keys.length) {
      const cur = keys[keys.length - 1];
      if (keys.filter((k) => k === cur).length >= 3) result = { winner: null, reason: '同一局面3回' };
    }
    return { moves, check, result };
  }

  // 棋譜の 1 手分（王手の記号は呼び出し側が付ける）。
  function notation(st, T, m) {
    if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
    const p = st.board[m.from].toUpperCase();
    return (p === 'P' ? '' : p) + cellLabel(T, m.from) + (m.capture ? 'x' : '-') + cellLabel(T, m.to) + (m.promo ? '=' + m.promo : '');
  }

  const api = { sqName, cellLabel, makeTerrain, generateTerrain, initialState, legalMoves, applyMove, inCheck, positionKey, evaluate, notation, colorOf, other, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MC = api;
})(typeof self !== 'undefined' ? self : this);
