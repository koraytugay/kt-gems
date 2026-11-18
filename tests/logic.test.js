// Run with: node --test tests/logic.test.js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const G = require('../game.js');

function changedCells(a, b) {
    const out = [];
    a.forEach((row, r) => row.forEach((v, c) => { if (v !== b[r][c]) out.push(`${r},${c}`); }));
    return out.sort();
}

function moveAndDiff(size, r, c) {
    const board = G.createBoard(size, false);
    const before = G.cloneBoard(board);
    G.applyMove(board, r, c);
    return changedCells(before, board);
}

test('interior click flips the hexagon and all 6 neighbours (even row)', () => {
    assert.deepEqual(moveAndDiff(10, 4, 4), ['3,3', '3,4', '4,3', '4,4', '4,5', '5,3', '5,4'].sort());
});

test('interior click flips the hexagon and all 6 neighbours (odd row)', () => {
    assert.deepEqual(moveAndDiff(10, 5, 4), ['4,4', '4,5', '5,3', '5,4', '5,5', '6,4', '6,5'].sort());
});

test('every interior cell flips exactly 7', () => {
    for (let r = 1; r < 9; r++) for (let c = 1; c < 9; c++) assert.equal(moveAndDiff(10, r, c).length, 7, `${r},${c}`);
});

test('corners and edges flip only cells that exist', () => {
    assert.equal(moveAndDiff(10, 0, 0).length, 3);  // top-left: right, below
    assert.equal(moveAndDiff(10, 0, 9).length, 4);  // top-right: left, two below
    assert.equal(moveAndDiff(10, 9, 0).length, 4);  // bottom-left (odd row): two above, right
    assert.equal(moveAndDiff(10, 9, 9).length, 3);  // bottom-right (odd row)
    assert.equal(moveAndDiff(10, 0, 5).length, 5);  // top edge
    assert.equal(moveAndDiff(10, 4, 0).length, 4);  // left edge, even row (shifted left)
    assert.equal(moveAndDiff(10, 5, 0).length, 6);  // left edge, odd row (shifted right)
});

test('only touching hexagons change: every flipped neighbour is 1 step away', () => {
    for (const [r, c] of [[4, 4], [5, 4], [0, 0], [9, 9]]) {
        for (const key of moveAndDiff(10, r, c)) {
            const [y, x] = key.split(',').map(Number);
            assert.ok(G.hexDistance(r, c, y, x) <= 1, `${key} from ${r},${c}`);
        }
    }
});

test('adjacency is symmetric (needed by the solver)', () => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        for (const [y, x] of G.hexNeighbors(7, r, c)) {
            assert.ok(G.hexNeighbors(7, y, x).some(([a, b]) => a === r && b === c), `${r},${c} <-> ${y},${x}`);
        }
    }
});

test('a move is its own inverse', () => {
    const board = G.createBoard(7, false);
    G.shuffleBoard(board, 20);
    const snapshot = G.cloneBoard(board);
    G.applyMove(board, 3, 2);
    G.applyMove(board, 3, 2);
    assert.ok(G.boardsEqual(board, snapshot));
});

test('shuffle never picks the same cell twice', () => {
    for (let i = 0; i < 50; i++) {
        const picked = G.shuffleBoard(G.createBoard(10, false), 60).map(p => p.join(','));
        assert.equal(new Set(picked).size, 60);
    }
});

test('the board is solved only when every cell has the same color (either color)', () => {
    const white = G.createBoard(5, false);
    assert.equal(G.checkWinCondition(white), 'white');
    white[4][4] = true;
    assert.equal(G.checkWinCondition(white), null);
    const black = G.createBoard(5, true);
    assert.equal(G.checkWinCondition(black), 'black');
    black[0][0] = false;   // the first cell differs from all the others
    assert.equal(G.checkWinCondition(black), null);
});

test('gentle curve: one more click every 3 levels, board grows slowly', () => {
    const clicks = [];
    for (let level = 1; level <= 12; level++) clicks.push(G.levelConfig(level).clicks);
    assert.deepEqual(clicks, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    assert.deepEqual(G.levelConfig(1), { size: 4, clicks: 1 });
    assert.equal(G.levelConfig(6).size, 4);          // 2 clicks, still 4x4
    assert.equal(G.levelConfig(55).size, 10);        // 19 clicks
    assert.deepEqual(G.levelConfig(5000), { size: 10, clicks: 40 });  // endless, capped
});

test('each level needs exactly its click count to reach EITHER color, and is solvable', () => {
    for (let level = 1; level <= 120; level += 1) {
        const { size, clicks } = G.levelConfig(level);
        for (let i = 0; i < 3; i++) {
            const p = G.generatePuzzle(level);
            assert.equal(p.board.length, size);
            assert.equal(p.par, clicks, `level ${level}: shortest ${p.par}, wanted ${clicks}`);
            assert.equal(G.checkWinCondition(p.board), null, 'not already solved');
            // No shortcut to the other color either
            for (const color of ['white', 'black']) {
                const s = G.solveBoard(p.board, color);
                if (s) assert.ok(s.length >= clicks, `${color} shortcut on level ${level}`);
            }
            const replay = G.cloneBoard(p.board);
            p.shuffleMoves.forEach(([r, c]) => G.applyMove(replay, r, c));
            assert.ok(G.checkWinCondition(replay), 'shuffle replay solves');
            const solved = G.cloneBoard(p.board);
            p.solution.forEach(([r, c]) => G.applyMove(solved, r, c));
            assert.equal(G.checkWinCondition(solved), p.solutionColor, 'solver solution solves');
        }
    }
});

test('level 1 really is a single click', () => {
    for (let i = 0; i < 30; i++) {
        const p = G.generatePuzzle(1);
        const board = G.cloneBoard(p.board);
        G.applyMove(board, ...p.solution[0]);
        assert.ok(G.checkWinCondition(board));
    }
});

test('new puzzles differ from the previous one', () => {
    const first = G.generatePuzzle(7);
    for (let i = 0; i < 50; i++) {
        assert.equal(G.boardsEqual(G.generatePuzzle(7, first.board).board, first.board), false);
    }
});

test('score rewards higher levels, fewer moves and faster times', () => {
    const perfect = G.calculateScore(10, 10, 20_000, 10);
    assert.equal(perfect, 1000);
    assert.ok(G.calculateScore(10, 20, 20_000, 10) < perfect);
    assert.ok(G.calculateScore(10, 10, 600_000, 10) < perfect);
    assert.ok(G.calculateScore(11, 11, 20_000, 11) > perfect);
});

test('time formatting', () => {
    assert.equal(G.formatTime(0), '0:00');
    assert.equal(G.formatTime(65_000), '1:05');
    assert.equal(G.formatTime(3_725_000), '1:02:05');
});
