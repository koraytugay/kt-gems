/* ==========================================================================
   HexaGems — a hexagonal Lights Out-style flip puzzle, endless mode.

   Board: a 2D array of booleans, board[row][col] === true means BLACK.
   The grid is hexagonal in "odd-r" layout: odd rows sit half a cell to the right.
   A move at (r, c) flips that cell and all six touching neighbours.
   Moves are their own inverse, and the order of moves does not matter.

   Goal: make every hexagon the same color — all black or all white, either wins.

   Endless mode: each level's puzzle has an exact shortest solution. It starts
   at one click and needs one more click every few levels; the board grows too.

   Part 1 is pure logic (no DOM) so it can be tested in Node.
   Part 2 wires the logic to the page.
   ========================================================================== */
'use strict';

/* ==========================================================================
   Part 1 · Rules, generation and solving
   ========================================================================== */

const MAX_SIZE = 10;
const LEVELS_PER_CLICK = 3;    // levels 1-3 need 1 click, 4-6 need 2, …
const MAX_CLICKS = 40;
// Four clicks is where puzzles get noticeably harder, so it is eased in: before the
// normal 4-click levels come a few "spread" ones whose clicks never overlap.
const EASY_FOUR_START = 10;    // the first level that needs 4 clicks
const EASY_FOUR_LEVELS = 4;    // levels 10-13: 4 spread-out clicks; 14-16: normal 4 clicks

/**
 * Board size, required clicks, and whether the clicks are spread apart (easy),
 * for a level: a gentle, steady climb.
 */
function levelConfig(level) {
    const easy = level >= EASY_FOUR_START && level < EASY_FOUR_START + EASY_FOUR_LEVELS;
    const step = easy ? EASY_FOUR_START
        : level >= EASY_FOUR_START + EASY_FOUR_LEVELS ? level - EASY_FOUR_LEVELS
        : level;
    const clicks = Math.min(MAX_CLICKS, 1 + Math.floor((step - 1) / LEVELS_PER_CLICK));
    const size = Math.min(MAX_SIZE, 4 + Math.floor((clicks - 1) / 2));
    return { size, clicks, spread: easy };
}

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function createBoard(size, black) {
    return Array.from({ length: size }, () => Array(size).fill(black));
}

function cloneBoard(board) {
    return board.map(row => row.slice());
}

function boardsEqual(a, b) {
    return a.length === b.length && a.every((row, r) => row.every((v, c) => v === b[r][c]));
}

/** The six neighbours of (r, c) in an odd-r hex grid, in board bounds. */
function hexNeighbors(size, r, c) {
    const odd = r % 2 === 1;
    const deltas = odd
        ? [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]]
        : [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]];
    return deltas
        .map(([dr, dc]) => [r + dr, c + dc])
        .filter(([y, x]) => y >= 0 && y < size && x >= 0 && x < size);
}

/** Flips the single cell at (r, c). Positions outside the board are ignored. */
function flipCell(board, r, c) {
    if (r >= 0 && r < board.length && c >= 0 && c < board[r].length) {
        board[r][c] = !board[r][c];
    }
}

/** Flips all six touching hexagons of (r, c). */
function flipNeighbors(board, r, c) {
    for (const [y, x] of hexNeighbors(board.length, r, c)) flipCell(board, y, x);
}

/** One game move: the exact operation used by both the player and the shuffle. */
function applyMove(board, r, c) {
    flipCell(board, r, c);
    flipNeighbors(board, r, c);
}

/** Positions a move at (r, c) changes. */
function affectedCells(size, r, c) {
    return [[r, c], ...hexNeighbors(size, r, c)];
}

/** Steps between two cells on the hex grid (via cube coordinates). */
function hexDistance(r1, c1, r2, c2) {
    const toCube = (r, c) => { const x = c - (r - (r & 1)) / 2; return [x, r, -x - r]; };
    const a = toCube(r1, c1), b = toCube(r2, c2);
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * The board is solved when every single cell has the same color.
 * Returns 'black' or 'white' for a solved board, otherwise null.
 */
function checkWinCondition(board) {
    const first = board[0][0];
    for (const row of board) {
        for (const cell of row) {
            if (cell !== first) return null;
        }
    }
    return first ? 'black' : 'white';
}

/**
 * Applies `count` moves on distinct, randomly chosen cells (no cell is picked
 * twice, since pressing a cell twice cancels out). Returns the cells used.
 */
function shuffleBoard(board, count, spread = false) {
    const size = board.length;
    const all = [];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) all.push([r, c]);
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }
    let picked;
    if (spread) {
        // Spread: no two clicks flip a common hexagon (3+ steps apart), so the
        // scrambled board shows separate, recognisable flower shapes
        picked = [];
        for (const cell of all) {
            if (picked.length === count) break;
            if (picked.every(([r, c]) => hexDistance(r, c, cell[0], cell[1]) >= 3)) picked.push(cell);
        }
        if (picked.length < count) return null;   // didn't fit this time; the caller retries
    } else {
        picked = all.slice(0, Math.min(count, all.length));
    }
    for (const [r, c] of picked) applyMove(board, r, c);
    return picked;
}

/**
 * Finds a shortest solution with Gaussian elimination over GF(2).
 * Returns an array of [r, c] moves, or null when the board cannot reach the target.
 * When several solutions exist (the grid has "quiet patterns"), the shortest wins.
 */
function solveBoard(board, target) {
    const size = board.length;
    const n = size * size;
    const wantBlack = target === 'black';
    // Augmented matrix: row i = "cell i ends up on target", column j = "press cell j"
    const m = [];
    for (let i = 0; i < n; i++) {
        const row = new Uint8Array(n + 1);
        const r = Math.floor(i / size), c = i % size;
        // Hex adjacency is symmetric, so "cells j that affect i" = "cells i affects"
        for (const [y, x] of affectedCells(size, r, c)) row[y * size + x] = 1;
        row[n] = board[r][c] !== wantBlack ? 1 : 0;
        m.push(row);
    }

    const pivotCols = [];
    let rank = 0;
    for (let col = 0; col < n && rank < n; col++) {
        let pivot = -1;
        for (let i = rank; i < n; i++) if (m[i][col]) { pivot = i; break; }
        if (pivot === -1) continue;
        [m[rank], m[pivot]] = [m[pivot], m[rank]];
        for (let i = 0; i < n; i++) {
            if (i !== rank && m[i][col]) {
                const a = m[i], p = m[rank];
                for (let k = col; k <= n; k++) a[k] ^= p[k];
            }
        }
        pivotCols.push(col);
        rank++;
    }
    for (let i = rank; i < n; i++) if (m[i][n]) return null; // inconsistent

    const isPivot = new Uint8Array(n);
    pivotCols.forEach(col => { isPivot[col] = 1; });
    const freeCols = [];
    for (let col = 0; col < n; col++) if (!isPivot[col]) freeCols.push(col);

    const combos = freeCols.length <= 12 ? 1 << freeCols.length : 1;
    let best = null;
    for (let mask = 0; mask < combos; mask++) {
        const x = new Uint8Array(n);
        freeCols.forEach((col, k) => { x[col] = (mask >> k) & 1; });
        for (let i = 0; i < rank; i++) {
            let v = m[i][n];
            for (const col of freeCols) if (m[i][col] && x[col]) v ^= 1;
            x[pivotCols[i]] = v;
        }
        const weight = x.reduce((s, v) => s + v, 0);
        if (!best || weight < best.weight) best = { x, weight };
    }

    const moves = [];
    best.x.forEach((v, i) => { if (v) moves.push([Math.floor(i / size), i % size]); });
    return moves;
}

/** Shortest way to make the board one color, trying both colors. */
function solveShortest(board) {
    let best = null;
    for (const color of ['white', 'black']) {
        const moves = solveBoard(board, color);
        if (moves && (!best || moves.length < best.moves.length)) best = { color, moves };
    }
    return best;
}

/**
 * Builds the puzzle for a level by scrambling a one-color board with real moves.
 * The scramble is kept only if its shortest solution (to either color) is
 * exactly the level's click count, so there is no shortcut.
 */
function generatePuzzle(level, previousBoard) {
    const { size, clicks, spread } = levelConfig(level);
    let fallback = null;

    for (let attempt = 0; attempt < 400; attempt++) {
        const board = createBoard(size, Math.random() < 0.5);
        const shuffleMoves = shuffleBoard(board, clicks, spread && attempt < 300);
        if (!shuffleMoves || checkWinCondition(board)) continue;
        if (previousBoard && attempt < 50 && boardsEqual(board, previousBoard)) continue;

        const best = solveShortest(board);
        const solution = best.moves;
        const puzzle = { board, par: solution.length, size, clicks, shuffleMoves, solution, solutionColor: best.color };
        if (solution.length === clicks) return puzzle;
        if (!fallback || puzzle.par > fallback.par) fallback = puzzle;
    }
    return fallback;
}

/* ==========================================================================
   Part 2 · The page
   ========================================================================== */

const HEX_R = 10;                        // circumradius in SVG units
const HEX_W = Math.sqrt(3) * HEX_R;      // pointy-top hex width
const HEX_PAD = 3;
const TILE_R = 8.1;                      // piece radius (leaves a gap between pieces)
const TILE_ROUND = 1.6;                  // rounded corners: a same-color stroke this wide
const TILE_BEVEL = 0.68;                 // flat top's size relative to the piece; the rest is bevel
// Light from the upper left: how much each of the six bevel facets is lit (+) or shaded (-).
// Facet i runs between corner i and i+1, starting at the top corner and going clockwise.
const FACET_LIGHT = [0.5, -0.5, -1, -0.5, 0.5, 1];
const TILE_EDGE = 1.7;                   // visible thickness of a piece below its top face
const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'bw-hex-progress';
const NEXT_LEVEL_DELAY = 350;            // pause after the solve wave before the next level drops in

// Anonymous stats + global leaderboard (Supabase). The key is the project's PUBLIC
// anon / publishable key: it can only call the functions in supabase/schema.sql.
// With no key the game simply plays offline.
const ONLINE = {
    url: 'https://cxtibqbukakubilrvwwu.supabase.co',
    key: ''
};

const state = {
    level: 1,             // the level being played
    best: 1,              // highest level reached
    runId: null,          // this run's anonymous id on the leaderboard (null = not ranked)
    size: 4,
    board: [],
    initialBoard: [],
    par: 0,
    history: [],          // previous board states, one per move
    moves: 0,
    solved: false,
    advanceTimer: null,
    focus: [0, 0],
    lastMove: null
};

const ui = {};

function initializeGame() {
    const $ = id => document.getElementById(id);
    Object.assign(ui, {
        board: $('board'),
        level: $('stat-level'),
        total: $('stat-total'),
        moves: $('stat-moves'),
        par: $('stat-par'),
        newGame: $('new-game-button'),
        restart: $('restart-button'),
        undo: $('undo-button'),
        settings: $('settings-modal'),
        schemeList: $('scheme-list'),
        announcer: $('announcer'),
        help: $('help-modal'),
        cells: []
    });

    loadProgress();

    ui.newGame.addEventListener('click', newRun);
    ui.restart.addEventListener('click', restartGame);
    ui.undo.addEventListener('click', undoMove);
    $('settings-button').addEventListener('click', () => openModal(ui.settings));
    ui.schemeList.addEventListener('click', e => {
        const btn = e.target.closest('[data-scheme]');
        if (btn) {
            applyScheme(btn.dataset.scheme);
            closeModal(ui.settings);   // pick and move on
        }
    });
    renderSchemes();
    $('help-button').addEventListener('click', () => openModal(ui.help));
    ui.leaderboard = $('leaderboard-modal');
    $('leaderboard-button').addEventListener('click', showLeaderboard);

    // Drop the flip class when the flip ends, so hover tints react instantly again
    ui.board.addEventListener('animationend', e => {
        const cell = e.target.closest && e.target.closest('.game-cell');
        if (cell) cell.classList.remove('flip-a', 'flip-b');
    });

    ui.board.addEventListener('click', e => {
        const cell = e.target.closest('.game-cell');
        if (cell) handleCellPress(+cell.dataset.row, +cell.dataset.col);
    });
    ui.board.addEventListener('keydown', handleBoardKeydown);
    ui.board.addEventListener('pointerover', e => {
        const cell = e.target.closest('.game-cell');
        if (cell && e.pointerType === 'mouse') showPreview(+cell.dataset.row, +cell.dataset.col);
    });
    ui.board.addEventListener('pointerleave', clearPreview);
    // Touch and pen: lift the pieces while the finger is down, settle them after the flip
    ui.board.addEventListener('pointerdown', e => {
        const cell = e.target.closest('.game-cell');
        if (cell && e.pointerType !== 'mouse') showPreview(+cell.dataset.row, +cell.dataset.col);
    });
    const settle = e => { if (e.pointerType !== 'mouse') setTimeout(clearPreview, 220); };
    ui.board.addEventListener('pointerup', settle);
    ui.board.addEventListener('pointercancel', settle);
    ui.board.addEventListener('focusin', e => {
        const cell = e.target.closest('.game-cell');
        if (cell && cell.matches(':focus-visible')) showPreview(+cell.dataset.row, +cell.dataset.col);
    });
    ui.board.addEventListener('focusout', clearPreview);

    document.querySelectorAll('.kt-modal').forEach(modal => {
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.closest('[data-close-modal]')) closeModal(modal);
        });
    });
    document.addEventListener('keydown', handleGlobalKeydown);

    initOnline();
    startNewGame(true);   // resume the saved puzzle, if there is one
}

/* ---------- Progress (this browser only) ---------- */

/* The level AND the puzzle being played are saved, so reloading the page brings back
   the same puzzle (as you left it) instead of dealing a new one. The only way to a
   different puzzle is to solve it or to start a new run. */

const encodeBoard = board => board.map(row => row.map(v => (v ? '1' : '0')).join('')).join('/');

function decodeBoard(text, size) {
    if (typeof text !== 'string') return null;
    const rows = text.split('/');
    if (rows.length !== size || rows.some(row => !/^[01]+$/.test(row) || row.length !== size)) return null;
    return rows.map(row => [...row].map(ch => ch === '1'));
}

function loadProgress() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && Number.isInteger(saved.level) && saved.level >= 1) {
            state.level = saved.level;
            state.best = Math.max(saved.level, saved.best | 0);
            if (typeof saved.runId === 'string' && UUID_RE.test(saved.runId)) state.runId = saved.runId;
            if (saved.puzzle && saved.puzzle.level === saved.level) state.savedPuzzle = saved.puzzle;
        }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
}

function saveProgress() {
    const data = { level: state.level, best: state.best, runId: state.runId };
    if (!state.solved && state.initialBoard.length && state.puzzleLevel === state.level) {
        data.puzzle = {
            level: state.puzzleLevel,
            start: encodeBoard(state.initialBoard),
            now: encodeBoard(state.board),
            moves: state.moves
        };
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
}

/** The saved puzzle for the current level, if it is valid; otherwise null. */
function takeSavedPuzzle() {
    const saved = state.savedPuzzle;
    state.savedPuzzle = null;
    if (!saved || saved.level !== state.level) return null;
    const { size } = levelConfig(state.level);
    const start = decodeBoard(saved.start, size);
    const now = decodeBoard(saved.now, size);
    if (!start || !now || checkWinCondition(start) || checkWinCondition(now)) return null;
    const best = solveShortest(start);
    if (!best) return null;
    return { board: start, now, par: best.moves.length, moves: Math.max(0, saved.moves | 0) };
}

/**
 * A new run always starts again from level 1 — there is no skipping to a fresh
 * puzzle at the current level. Past level 1 it asks first, so a misclick can't end a run.
 */
function newRun() {
    if (state.level > 1 && !window.confirm(`Start a new run from level 1? You are on level ${state.level}.`)) return;
    state.level = 1;
    state.runId = beginRun();
    saveProgress();
    startNewGame();
}

/* ---------- Gem color schemes (only the gems change; set on <html data-gems>) ---------- */

const GEM_SCHEMES = [
    { id: 'classic',  name: 'Classic' },
    { id: 'ocean',    name: 'Ocean' },
    { id: 'teal',     name: 'Teal' },
    { id: 'forest',   name: 'Forest' },
    { id: 'violet',   name: 'Violet' },
    { id: 'rose',     name: 'Rose' },
    { id: 'amber',    name: 'Amber' },
    { id: 'contrast', name: 'High contrast' }
];
const GEM_STORAGE_KEY = 'bw-gems';

function currentScheme() {
    const id = document.documentElement.getAttribute('data-gems');
    return GEM_SCHEMES.some(s => s.id === id) ? id : 'classic';
}

/** One selectable card per scheme, each previewing a light and a dark gem in its own colors. */
function renderSchemes() {
    const hex = (cx, cy, r) => hexPoints(cx, cy, r);
    ui.schemeList.replaceChildren(...GEM_SCHEMES.map(scheme => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kt-card kt-card--selectable';
        btn.dataset.scheme = scheme.id;
        const body = document.createElement('div');
        body.className = 'kt-card__body game-scheme';
        const preview = svg('svg', { viewBox: '0 0 44 24', 'data-gems': scheme.id, 'aria-hidden': 'true', class: 'game-scheme__preview' });
        for (const [tone, cx] of [['light', 11], ['dark', 31]]) {
            svg('polygon', { class: `game-scheme__edge game-scheme__edge--${tone}`, points: hex(cx, 12.6, 9) }, preview);
            svg('polygon', { class: `game-scheme__top game-scheme__top--${tone}`, points: hex(cx, 11, 9) }, preview);
        }
        const name = document.createElement('span');
        name.className = 'game-scheme__name';
        name.textContent = scheme.name;
        body.append(preview, name);
        btn.append(body);
        return btn;
    }));
    updateSchemeButtons();
}

function updateSchemeButtons() {
    const active = currentScheme();
    ui.schemeList.querySelectorAll('[data-scheme]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.scheme === active));
    });
}

function applyScheme(id) {
    if (!GEM_SCHEMES.some(s => s.id === id)) return;
    document.documentElement.setAttribute('data-gems', id);
    try { localStorage.setItem(GEM_STORAGE_KEY, id); } catch (e) { /* storage unavailable */ }
    updateSchemeButtons();
}

/* ---------- Game flow ---------- */

/**
 * Starts the puzzle for the current level: the saved one when resuming after a
 * reload, otherwise a newly generated one.
 */
function startNewGame(resume = false) {
    const { size } = levelConfig(state.level);
    const restored = resume ? takeSavedPuzzle() : null;
    const previous = state.initialBoard.length === size ? state.initialBoard : null;
    const puzzle = restored || generatePuzzle(state.level, previous);

    clearTimeout(state.advanceTimer);
    Object.assign(state, {
        size,
        board: cloneBoard(restored ? restored.now : puzzle.board),
        initialBoard: cloneBoard(puzzle.board),
        puzzleLevel: state.level,
        par: puzzle.par,
        history: [],
        moves: restored ? restored.moves : 0,
        solved: false,
        lastMove: null,
        focus: [Math.floor(size / 2), Math.floor(size / 2)]
    });

    buildBoard();
    updateBoard(null, true);
    updateGameStats();
    saveProgress();
    announce(`Level ${state.level}. Make every hexagon the same color in ${state.par} ${state.par === 1 ? 'click' : 'clicks'}.`);
}

function restartGame() {
    if (state.solved) return;
    const changed = diffCells(state.board, state.initialBoard);
    Object.assign(state, {
        board: cloneBoard(state.initialBoard),
        history: [],
        moves: 0,
        lastMove: null
    });
    updateBoard(changed);
    updateGameStats();
    saveProgress();
    announce('Puzzle restarted.');
}

function handleCellPress(r, c) {
    if (state.solved) return;
    state.focus = [r, c];

    state.history.push(cloneBoard(state.board));
    applyMove(state.board, r, c);
    state.moves++;
    state.lastMove = [r, c];

    updateBoard(affectedCells(state.size, r, c));
    updateGameStats();
    saveProgress();

    const winner = checkWinCondition(state.board);
    if (winner) {
        state.solved = true;
        state.winner = winner;
        updateGameStats();
        completeLevel();
    }
}

function undoMove() {
    if (state.solved || state.history.length === 0) return;
    const previous = state.history.pop();
    const changed = diffCells(state.board, previous);
    state.board = previous;
    state.moves = Math.max(0, state.moves - 1);
    updateBoard(changed);
    updateGameStats();
    saveProgress();
    announce(`Move undone. ${state.moves} ${state.moves === 1 ? 'move' : 'moves'}.`);
}

function diffCells(a, b) {
    const out = [];
    for (let r = 0; r < a.length; r++) for (let c = 0; c < a.length; c++) if (a[r][c] !== b[r][c]) out.push([r, c]);
    return out;
}

/* ---------- Rendering ---------- */

function hexCenter(r, c) {
    return [HEX_PAD + HEX_W * (c + 0.5 + (r % 2) * 0.5), HEX_PAD + HEX_R + r * HEX_R * 1.5];
}

function hexCorners(cx, cy, radius) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 90);
        pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    return pts;
}

function hexPoints(cx, cy, radius) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 90);
        pts.push(`${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
}

/** Draws the board: one piece per cell, each with a shaded top face and a thick edge. */
function buildBoard() {
    const size = state.size;
    const width = HEX_PAD * 2 + HEX_W * (size + 0.5);
    const height = HEX_PAD * 2 + HEX_R * 2 + (size - 1) * HEX_R * 1.5 + TILE_EDGE;
    ui.board.setAttribute('viewBox', `0 0 ${width.toFixed(2)} ${height.toFixed(2)}`);
    ui.board.dataset.size = size;
    ui.board.classList.remove('is-solved', 'is-celebrating');
    ui.board.replaceChildren();
    ui.cells = [];

    // Soft vertical shading on the top faces (colors come from CSS)
    const defs = svg('defs', {}, ui.board);
    for (const tone of ['light', 'dark']) {
        const grad = svg('linearGradient', { id: `bw-face-${tone}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        svg('stop', { offset: 0, class: `game-stop game-stop--${tone}-top` }, grad);
        svg('stop', { offset: 1, class: `game-stop game-stop--${tone}-bottom` }, grad);
    }

    const [mr, mc] = [Math.floor(size / 2), Math.floor(size / 2)];
    for (let r = 0; r < size; r++) {
        const row = svg('g', { role: 'row' }, ui.board);
        const cellRow = [];
        for (let c = 0; c < size; c++) {
            const [cx, cy] = hexCenter(r, c);
            // A cell: the piece's edge (its thickness), then its bevelled top face
            const cell = svg('g', { class: 'game-cell', role: 'gridcell', tabindex: '-1' }, row);
            svg('polygon', { class: 'game-edge', points: hexPoints(cx, cy + TILE_EDGE, TILE_R) }, cell);
            const top = svg('g', { class: 'game-top' }, cell);
            svg('polygon', { class: 'game-face', points: hexPoints(cx, cy, TILE_R) }, top);
            const outer = hexCorners(cx, cy, TILE_R + TILE_ROUND / 2 - 0.2);
            const inner = hexCorners(cx, cy, TILE_R * TILE_BEVEL);
            for (let i = 0; i < 6; i++) {
                const j = (i + 1) % 6;
                const light = FACET_LIGHT[i];
                svg('polygon', {
                    class: `game-facet ${light > 0 ? 'game-facet--lit' : 'game-facet--shade'}`,
                    style: `--facet: ${Math.abs(light)}`,
                    points: [outer[i], outer[j], inner[j], inner[i]].map(p => p.map(v => v.toFixed(2)).join(',')).join(' ')
                }, top);
            }
            cell.dataset.row = r;
            cell.dataset.col = c;
            cell.style.setProperty('--enter', hexDistance(r, c, mr, mc));
            cellRow.push(cell);
        }
        ui.cells.push(cellRow);
    }

    // New level: the pieces drop in from the middle outwards
    ui.board.classList.remove('is-entering');
    void ui.board.getBoundingClientRect();
    ui.board.classList.add('is-entering');
    clearTimeout(buildBoard.enterTimer);
    buildBoard.enterTimer = setTimeout(() => ui.board.classList.remove('is-entering'), 900);
}

/** Syncs every cell with the board. Cells listed in `animate` play the flip. */
function updateBoard(animate, instant) {
    const [fr, fc] = state.focus;
    for (let r = 0; r < state.size; r++) {
        for (let c = 0; c < state.size; c++) {
            const cell = ui.cells[r][c];
            const black = state.board[r][c];
            cell.classList.toggle('is-black', black);
            cell.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}, ${black ? 'black' : 'white'}`);
            cell.setAttribute('tabindex', r === fr && c === fc ? '0' : '-1');
            if (instant) cell.classList.remove('flip-a', 'flip-b');
        }
    }
    if (animate) {
        for (const [r, c] of animate) {
            const cell = ui.cells[r][c];
            const useB = cell.classList.contains('flip-a');
            cell.classList.toggle('flip-a', !useB);
            cell.classList.toggle('flip-b', useB);
        }
    }
}

function updateGameStats() {
    const { size } = levelConfig(state.level);
    ui.level.textContent = state.level;
    ui.total.textContent = `${size} × ${size} board`;
    ui.moves.textContent = state.moves;
    ui.par.textContent = `solve in ${state.par}`;
    ui.undo.disabled = state.solved || state.history.length === 0;
    ui.restart.disabled = state.solved || state.moves === 0;
}

function showPreview(r, c) {
    clearPreview();
    if (state.solved) return;
    const group = affectedCells(state.size, r, c);
    for (const [y, x] of group) {
        ui.cells[y][x].classList.add(y === r && x === c ? 'is-preview-center' : 'is-preview');
    }
}

function clearPreview() {
    ui.board.querySelectorAll('.is-preview, .is-preview-center')
        .forEach(el => el.classList.remove('is-preview', 'is-preview-center'));
}

/* ---------- Completion ---------- */

/** Level solved: the pieces hop in a wave from the winning move, then the next level drops in. */
function completeLevel() {
    const solvedLevel = state.level;
    state.level = solvedLevel + 1;
    state.best = Math.max(state.best, state.level);
    saveProgress();
    if (state.runId) {
        queueCall('record_solve', { p_player: playerId(), p_run: state.runId, p_level: solvedLevel, p_moves: state.moves });
    }

    clearPreview();
    const [lr, lc] = state.lastMove || [0, 0];
    let maxWave = 0;
    for (let r = 0; r < state.size; r++) {
        for (let c = 0; c < state.size; c++) {
            const wave = hexDistance(r, c, lr, lc);
            maxWave = Math.max(maxWave, wave);
            ui.cells[r][c].style.setProperty('--wave', wave);
        }
    }
    ui.board.classList.add('is-solved', 'is-celebrating');
    announce(`Level ${solvedLevel} solved in ${state.moves} ${state.moves === 1 ? 'move' : 'moves'}.`);

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reduced ? 400 : maxWave * 45 + 420 + NEXT_LEVEL_DELAY;
    state.advanceTimer = setTimeout(startNewGame, delay);
}

/* ---------- Online: anonymous stats + global leaderboard ----------
   Each browser gets a random player id (no account, no personal data). A run is
   registered when it starts and every solved level is recorded, in order. Calls
   are queued in localStorage and retried, so playing offline loses nothing. */

const PLAYER_KEY = 'hexagems-player';
const NAME_KEY = 'hexagems-name';
const QUEUE_KEY = 'hexagems-queue';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function writeStore(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }

function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function playerId() {
    let id = readStore(PLAYER_KEY);
    if (!id || !UUID_RE.test(id)) {
        id = newId();
        writeStore(PLAYER_KEY, id);
    }
    return id;
}

/** Calls one of the functions in supabase/schema.sql. Errors carry .retry (try again later?). */
async function rpc(fn, args) {
    let res;
    try {
        res = await fetch(`${ONLINE.url}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            headers: { apikey: ONLINE.key, Authorization: `Bearer ${ONLINE.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
        });
    } catch (e) {
        throw Object.assign(new Error('network error'), { retry: true });
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(text || res.statusText), { retry: res.status >= 500 || res.status === 429 });
    }
    return res.json();
}

function loadQueue() {
    try {
        const q = JSON.parse(readStore(QUEUE_KEY) || '[]');
        return Array.isArray(q) ? q : [];
    } catch (e) { return []; }
}

function saveQueue(q) { writeStore(QUEUE_KEY, JSON.stringify(q.slice(-500))); }

function queueCall(fn, args) {
    if (!ONLINE.key) return;
    const q = loadQueue();
    q.push({ fn, args });
    saveQueue(q);
    flushQueue();
}

let flushing = null;

/** Sends queued calls in order. Stops at a network problem (retried later); drops calls the server rejects. */
function flushQueue() {
    if (!ONLINE.key) return Promise.resolve();
    if (flushing) return flushing;
    flushing = (async () => {
        for (;;) {
            const item = loadQueue()[0];
            if (!item) break;
            try {
                const result = await rpc(item.fn, item.args);
                if (item.fn === 'start_run' && typeof result === 'string') writeStore(NAME_KEY, result);
            } catch (e) {
                if (e.retry) break;   // offline or server trouble: keep it for later
            }
            const q = loadQueue();
            q.shift();
            saveQueue(q);
        }
    })().finally(() => { flushing = null; });
    return flushing;
}

/** Registers a new run and returns its id (null when the leaderboard is not set up). */
function beginRun() {
    if (!ONLINE.key) return null;
    const run = newId();
    queueCall('start_run', { p_player: playerId(), p_run: run });
    return run;
}

function initOnline() {
    if (!ONLINE.key) return;
    playerId();
    // A first visit (or anyone still on level 1) is ranked straight away. A run already
    // past level 1 from before the leaderboard existed stays unranked until a New run.
    if (!state.runId && state.level === 1) state.runId = beginRun();
    flushQueue();
    window.addEventListener('online', flushQueue);
    setInterval(() => { if (loadQueue().length) flushQueue(); }, 30000);
}

async function showLeaderboard() {
    const body = document.getElementById('leaderboard-body');
    const note = document.getElementById('leaderboard-note');
    const message = (title, text) => {
        const box = document.createElement('div');
        box.className = 'kt-empty kt-fs-base';
        const t = document.createElement('div');
        t.className = 'kt-empty__title';
        t.textContent = title;
        box.append(t);
        if (text) { const p = document.createElement('p'); p.textContent = text; box.append(p); }
        body.replaceChildren(box);
    };
    openModal(ui.leaderboard);
    note.textContent = '';

    if (!ONLINE.key) { message('Not set up yet', 'The leaderboard is coming soon.'); return; }

    const loading = document.createElement('div');
    loading.className = 'kt-loading kt-fs-base';
    loading.innerHTML = '<div class="kt-spinner"></div>Loading…';
    body.replaceChildren(loading);

    await flushQueue();
    let rows;
    try {
        rows = await rpc('get_leaderboard', { p_player: playerId(), p_limit: 20 });
    } catch (e) {
        message('Leaderboard unavailable', 'Check your connection and try again.');
        return;
    }

    if (!rows.length) {
        message('No one here yet', 'Solve a level to be the first on the board.');
    } else {
        const wrap = document.createElement('div');
        wrap.className = 'kt-table-wrap';
        const table = document.createElement('table');
        table.className = 'kt-table';
        table.innerHTML = '<thead><tr><th class="kt-num">#</th><th>Player</th><th class="kt-num">Levels</th><th class="kt-num">Moves</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const row of rows) {
            const tr = document.createElement('tr');
            if (row.is_you) tr.className = 'game-you';
            for (const [text, num] of [[row.rank, true], [row.is_you ? `${row.name} (you)` : row.name, false],
                                        [row.levels_solved, true], [row.total_moves, true]]) {
                const td = document.createElement('td');
                if (num) td.className = 'kt-num';
                td.textContent = text;
                tr.append(td);
            }
            tbody.append(tr);
        }
        table.append(tbody);
        wrap.append(table);
        body.replaceChildren(wrap);
    }

    const name = readStore(NAME_KEY);
    note.textContent = [
        name ? `You play as ${name}.` : '',
        state.runId ? '' : 'Your current run started before the leaderboard; start a New run to be ranked.'
    ].filter(Boolean).join(' ');
}

/* ---------- Modals ---------- */

let modalReturnFocus = null;

function openModal(modal) {
    modalReturnFocus = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    const focusTarget = modal.querySelector('[aria-pressed="true"]')
        || modal.querySelector('.kt-modal__footer .kt-btn--primary')
        || modal.querySelector('button');
    if (!focusTarget) return;
    // Focus right away; try again once the dialog has finished appearing, in case it didn't take
    focusTarget.focus({ preventScroll: true });
    setTimeout(() => {
        if (modal.classList.contains('is-open') && !modal.contains(document.activeElement)) focusTarget.focus({ preventScroll: true });
    }, 250);
}

function closeModal(modal, restoreFocus = true) {
    if (!modal.classList.contains('is-open')) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    if (restoreFocus) {
        const back = modalReturnFocus && document.contains(modalReturnFocus) ? modalReturnFocus : focusedCell();
        if (back) back.focus();
    }
}

/* ---------- Keyboard ---------- */

function focusedCell() {
    const [r, c] = state.focus;
    return ui.cells[r] && ui.cells[r][c];
}

function handleBoardKeydown(e) {
    const cell = e.target.closest('.game-cell');
    if (!cell) return;
    let [r, c] = [+cell.dataset.row, +cell.dataset.col];
    const last = state.size - 1;

    switch (e.key) {
        case 'ArrowUp':    r = Math.max(0, r - 1); break;
        case 'ArrowDown':  r = Math.min(last, r + 1); break;
        case 'ArrowLeft':  c = Math.max(0, c - 1); break;
        case 'ArrowRight': c = Math.min(last, c + 1); break;
        case 'Home':       c = 0; if (e.ctrlKey) r = 0; break;
        case 'End':        c = last; if (e.ctrlKey) r = last; break;
        case 'Enter':
        case ' ':
            e.preventDefault();
            handleCellPress(r, c);
            showPreview(r, c);
            return;
        default: return;
    }
    e.preventDefault();
    moveFocus(r, c);
}

function moveFocus(r, c) {
    const prev = focusedCell();
    if (prev) prev.setAttribute('tabindex', '-1');
    state.focus = [r, c];
    const next = focusedCell();
    next.setAttribute('tabindex', '0');
    next.focus();
    showPreview(r, c);
}

function handleGlobalKeydown(e) {
    const modal = document.querySelector('.kt-modal.is-open');
    if (modal) {
        if (e.key === 'Escape') closeModal(modal);
        else if (e.key === 'Tab') trapFocus(modal, e);
        return;
    }
    if (e.altKey || e.target.closest('input, select, textarea')) return;

    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoMove();
    } else if (!e.ctrlKey && !e.metaKey) {
        if (key === 'u') undoMove();
        else if (key === 'r') restartGame();
        else if (key === 'n') newRun();
    }
}

function trapFocus(modal, e) {
    const focusable = [...modal.querySelectorAll('button:not([disabled])')];
    if (focusable.length === 0) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

/* ---------- Announcements ---------- */

function announce(message) {
    ui.announcer.textContent = '';
    setTimeout(() => { ui.announcer.textContent = message; }, 30);
}

/* ---------- Boot ---------- */

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeGame);
    else initializeGame();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        levelConfig, createBoard, cloneBoard, boardsEqual, hexNeighbors, flipCell, flipNeighbors, applyMove,
        affectedCells, hexDistance, checkWinCondition, shuffleBoard, solveBoard, solveShortest, generatePuzzle
    };
}
