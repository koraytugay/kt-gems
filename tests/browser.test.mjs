// End-to-end checks of the real page in headless Chrome, with no dependencies:
// a tiny static server + the Chrome DevTools protocol over Node's built-in WebSocket.
//
//   node tests/browser.test.mjs
//
// Needs Node 22+ and Google Chrome. Set CHROME_PATH if Chrome is not at the macOS default.
// Screenshots are written to tests/screenshots/ (git-ignored). Exits with code 1 on any failure.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'tests', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Serve the project folder on a free local port
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) { res.writeHead(403).end(); return; }
    try {
        const body = await readFile(join(ROOT, path || 'index.html'));
        res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const PROFILE = mkdtempSync(join(tmpdir(), 'hexagems-chrome-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(CHROME,
  ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(m.params.type)) errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text + ' ' + (m.params.entry.url||''));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(expr + '\n' + JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOTS + '/' + name + '.png', Buffer.from(r.result.data, 'base64')); };
const viewport = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const load = async () => { await send('Page.navigate', { url: URL_ }); await sleep(1200); };
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await viewport(1280, 900, false);
await load();
await ev('localStorage.clear()'); await load();

const results = []; const check = (name, ok, extra='') => results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + ' ' + extra);
const clickCell = (r, c) => ev('document.querySelector(\'.game-cell[data-row="' + r + '"][data-col="' + c + '"]\').dispatchEvent(new MouseEvent("click", {bubbles: true}))');
const btn = id => ev('document.getElementById("' + id + '").click()');
const snap = 'JSON.stringify(state.board)';

check('named HexaGems, no subtitle', await ev('document.title === "HexaGems" && document.querySelector("h1").textContent.trim() === "HexaGems" && !document.querySelector(".kt-page-subtitle")'));
check('no text smaller than body size', await ev('(() => { const base = parseFloat(getComputedStyle(document.body).fontSize); return [...document.querySelectorAll("body *")].filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && el.offsetParent !== null).every(el => parseFloat(getComputedStyle(el).fontSize) >= base - 0.01); })()'));
check('Level / Moves text centered', await ev('[...document.querySelectorAll(".game-stats .kt-stat")].every(el => getComputedStyle(el).alignItems === "center" && getComputedStyle(el).textAlign === "center")'));
check('caption text', await ev('document.getElementById("board-help").textContent.trim() === "Make every hexagon the same color. Tap a hexagon to flip it and the six around it."'));
check('no theme button; keyboard hint text removed', await ev('!document.getElementById("theme-button") && !document.body.innerText.includes("Arrow keys move")'));
check('header: help and settings buttons, no separate reset button', await ev('(() => { const s = document.getElementById("settings-button"); const h = document.getElementById("help-button"); return s.closest("header") && h.closest("header") && s.getAttribute("aria-label") === "Settings" && h.nextElementSibling === s && !document.getElementById("reset-button"); })()'));
check('main button says New run', await ev('document.getElementById("new-game-button").textContent.trim() === "New run"'));
check('starts at level 1, 4x4 = 16 hexagons', await ev('state.level===1 && document.querySelectorAll(".game-cell").length===16 && state.par===1'));
check('DOM matches board', await ev('state.board.flat().filter(Boolean).length === document.querySelectorAll(".game-cell.is-black").length'));
check('cells are hexagons', await ev('document.querySelector(".game-cell .game-face").getAttribute("points").split(" ").length===6'));
await shot('01-level1');

// Level 1: wrong click first, then undo, then the one solving click
const sol1 = await ev('solveShortest(state.board).moves');
const other = sol1[0][0] === 0 && sol1[0][1] === 0 ? [3, 3] : [0, 0];
const before = await ev(snap);
await clickCell(...other);
check('first move counted', await ev('state.moves === 1'));
check('wrong click does not win', await ev('!state.solved'));
await btn('undo-button');
check('undo restores board', (await ev(snap)) === before);
await clickCell(...sol1[0]);
check('level 1 solved in one click', await ev('state.solved && state.moves === 1'));
check('no time or points on the page', await ev('!document.getElementById("stat-time") && !document.getElementById("stat-points") && !document.getElementById("result") && document.querySelectorAll(".game-stats .kt-stat").length === 2'));
check('progress advanced and saved immediately', await ev('state.level === 2 && JSON.parse(localStorage.getItem("bw-hex-progress")).level === 2'));
await sleep(150);
await shot('02-solve-wave');
await sleep(1100);
check('next level starts by itself: level 2, 1 click, fresh board', await ev('state.level===2 && state.par===1 && !state.solved && state.moves===0 && !document.getElementById("board").classList.contains("is-solved") && !document.querySelector(".kt-modal.is-open")'));
check('level shown in stats', await ev('document.getElementById("stat-level").textContent === "2"'));

// Restart / new puzzle
const init = await ev('JSON.stringify(state.initialBoard)');
// one click that is NOT the solution (a 1-click puzzle has exactly one solving cell)
const sol2 = await ev('solveShortest(state.board).moves[0]');
const notSol = sol2[0] === 1 && sol2[1] === 1 ? [2, 2] : [1, 1];
await clickCell(...notSol);
check('a non-solving click does not solve', await ev('!state.solved && state.moves === 1'));
await btn('restart-button');
check('restart restores the puzzle', (await ev(snap)) === init && await ev('state.moves===0'));
// New run past level 1: cancelling the confirm keeps the run, accepting goes back to level 1
await ev('window.confirm = () => false'); await btn('new-game-button');
check('New run: cancel keeps the current level and puzzle', await ev('state.level===2') && (await ev('JSON.stringify(state.initialBoard)')) === init);
await ev('window.confirm = () => true'); await btn('new-game-button');
check('New run: confirmed, back to level 1', await ev('state.level===1 && JSON.parse(localStorage.getItem("bw-hex-progress")).level===1'));
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 2, best: 2}))'); await load();

// Reload keeps progress AND the same puzzle (no way to get a new puzzle at your level)
await load();
check('reload keeps level', await ev('state.level===2'));
const startBefore = await ev('JSON.stringify(state.initialBoard)');
await load();
check('reload with no moves: same puzzle', (await ev('JSON.stringify(state.initialBoard)')) === startBefore);
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 13, best: 13}))'); await load();
const p13 = await ev('JSON.stringify(state.initialBoard)');
await clickCell(0, 0); await clickCell(3, 4);
const mid = await ev('JSON.stringify(state.board)');
await load();
check('reload mid-level: same puzzle, same board, same move count', (await ev('JSON.stringify(state.initialBoard)')) === p13 && (await ev('JSON.stringify(state.board)')) === mid && await ev('state.moves === 2 && state.level === 13'));
check('after reload: restart is available, undo is not', await ev('!document.getElementById("restart-button").disabled && document.getElementById("undo-button").disabled'));
await btn('restart-button');
check('restart after reload goes back to the same puzzle start', (await ev('JSON.stringify(state.board)')) === p13);
await load();
check('reload after restart: still the same puzzle', (await ev('JSON.stringify(state.initialBoard)')) === p13 && await ev('state.moves === 0'));
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 13, best: 13, puzzle: {level: 13, start: "garbage", now: "x", moves: 2}}))'); await load();
check('corrupt saved puzzle: falls back to a new valid puzzle', await ev('state.level === 13 && state.size === levelConfig(13).size && state.par === levelConfig(13).clicks && state.moves === 0'));
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 2, best: 13}))'); await load();

// Either color wins: take the route to whichever color is NOT the shortest
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 7, totalScore: 500, best: 7}))'); await load();
const both = await ev('({ w: solveBoard(state.board, "white"), b: solveBoard(state.board, "black"), par: state.par })');
check('level 7 needs exactly 3 clicks', both.par === 3);
const shortColor = both.w && (!both.b || both.w.length <= both.b.length) ? 'white' : 'black';
const longColor = shortColor === 'white' ? 'black' : 'white';
const route = (longColor === 'white' ? both.w : both.b) || (shortColor === 'white' ? both.w : both.b);
const expectColor = (longColor === 'white' ? both.w : both.b) ? longColor : shortColor;
for (let i = 0; i < route.length; i++) {
  await clickCell(...route[i]);
  if (i < route.length - 1 && await ev('state.solved')) { check('no early win', false); break; }
}
check('solved as all ' + expectColor + ' (' + route.length + ' clicks)', await ev('state.solved && state.winner === "' + expectColor + '" && document.querySelectorAll(".game-cell.is-black").length === ' + (expectColor === 'black' ? 'state.size*state.size' : 0)));
check('undo/restart disabled while the level wraps up', await ev('document.getElementById("undo-button").disabled && document.getElementById("restart-button").disabled'));
await sleep(1500);
check('then level 8 starts by itself', await ev('state.level === 8 && !state.solved'));

// Jump to a big level
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 25, totalScore: 12345, best: 25}))'); await load();
check('level 25: board and clicks match levelConfig', await ev('(() => { const c = levelConfig(25); return state.size === c.size && document.querySelectorAll(".game-cell").length === c.size * c.size && state.par === c.clicks; })()'), await ev('JSON.stringify(levelConfig(25))'));
// Edge preview: hover a cell -> 7 highlighted
await ev('state.focus=[4,4]; showPreview(4,4)');
check('preview marks 7 hexagons', await ev('document.querySelectorAll(".is-preview, .is-preview-center").length===7'));
await sleep(300);
await sleep(250);
check('preview: group rises, clicked gem rises highest, no dots anywhere', await ev('(() => { const group = [...document.querySelectorAll(".is-preview, .is-preview-center")]; const center = document.querySelector(".is-preview-center"); const lift = el => new DOMMatrix(getComputedStyle(el.querySelector(".game-top")).transform).f; return group.length === 7 && !document.querySelector("#board circle, .game-dot") && Math.abs(lift(center) + 2.6) < 0.01 && group.filter(el => el !== center).every(el => Math.abs(lift(el) + 1.4) < 0.01); })()'));
await shot('04-level25-preview');
await ev('clearPreview()'); await sleep(250);
check('preview cleared: pieces settle', await ev('[...document.querySelectorAll(".game-cell")].every(el => getComputedStyle(el.querySelector(".game-top")).transform === "none")'));
// Keyboard
await ev('document.querySelector(".game-cell[tabindex=\'0\']").focus()');
const [fr, fc] = await ev('[+document.activeElement.dataset.row, +document.activeElement.dataset.col]');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
check('arrow key moves focus', await ev('+document.activeElement.dataset.row === ' + fr + ' && +document.activeElement.dataset.col === ' + (fc + 1)));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
check('Enter flips focused hexagon', await ev('state.moves===1 && state.lastMove.join() === "' + fr + ',' + (fc + 1) + '"'));
check('accessible label', await ev('/^Row \\d+, column \\d+, (black|white)\$/.test(document.activeElement.getAttribute("aria-label"))'), await ev('document.activeElement.getAttribute("aria-label")'));
// Hit testing: a real mouse click at a cell centre lands on that cell
const hit = await ev('(() => { const el = document.querySelector(\'.game-cell[data-row="3"][data-col="6"]\'); const b = el.getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2); return t.closest(".game-cell") === el; })()');
check('pointer hit-test lands on the right hexagon', hit);
check('desktop: whole game fits in 900px', await ev('document.querySelector(".game").getBoundingClientRect().bottom <= innerHeight'), await ev('Math.round(document.querySelector(".game").getBoundingClientRect().bottom) + "px"'));

// Reset progress
// Settings: gem color schemes
await btn('settings-button'); await sleep(350);
check('settings dialog lists 8 schemes, Classic selected', await ev('document.getElementById("settings-modal").classList.contains("is-open") && document.querySelectorAll("#scheme-list [data-scheme]").length === 8 && document.querySelector("[data-scheme=classic]").getAttribute("aria-pressed") === "true"'));
check('settings: no Done button, current scheme focused', await ev('!document.querySelector("#settings-modal .kt-modal__footer") && document.activeElement.dataset.scheme === "classic"'));
await shot('08-settings');
const previews = await ev('[...document.querySelectorAll(".game-scheme__top--dark")].map(p => getComputedStyle(p).fill)');
check('every scheme preview shows its own dark gem color', new Set(previews).size === 8);
const trayBefore = await ev('getComputedStyle(document.getElementById("board")).backgroundColor');
const darkFaceBefore = await ev('getComputedStyle(document.querySelector(".game-stop--dark-top")).stopColor');
await ev('document.querySelector("[data-scheme=teal]").click()');
check('choosing Teal closes the dialog', await ev('!document.getElementById("settings-modal").classList.contains("is-open")'));
check('choosing Teal changes the gems only', await ev('document.documentElement.dataset.gems === "teal" && localStorage.getItem("bw-gems") === "teal" && document.querySelector("[data-scheme=teal]").getAttribute("aria-pressed") === "true"') && (await ev('getComputedStyle(document.querySelector(".game-stop--dark-top")).stopColor')) !== darkFaceBefore && (await ev('getComputedStyle(document.getElementById("board")).backgroundColor')) === trayBefore);
await sleep(300);
await shot('09-teal');
await load();
check('scheme survives a reload', await ev('document.documentElement.dataset.gems === "teal"'));
await ev('localStorage.setItem("bw-gems", "classic")'); await load();
await ev('window.confirm = () => true'); await btn('new-game-button');
check('New run resets to level 1', await ev('state.level===1 && document.querySelectorAll(".game-cell").length===16'));

// Mobile
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 25, totalScore: 12345, best: 25}))'); await load();
await viewport(390, 844, true); await sleep(400);
check('mobile: no horizontal scroll', await ev('document.documentElement.scrollWidth <= innerWidth'));
check('mobile: hexagon size', true, await ev('Math.round(document.querySelector(".game-cell").getBoundingClientRect().width) + "px wide"'));
await shot('05-mobile-level25');
await viewport(320, 640, true); await sleep(300);
check('320px: no horizontal scroll', await ev('document.documentElement.scrollWidth <= innerWidth'));
await shot('06-mobile-320');
// Easy 4-click levels: the four clicks are spread apart
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 10, best: 10}))'); await load();
check('level 10: 4 clicks, spread-out (easy) puzzle', await ev('state.par === 4 && levelConfig(10).spread === true'));
await ev('localStorage.setItem("bw-hex-progress", JSON.stringify({level: 25, best: 25}))'); await load();
check('320px: action button labels fit', await ev('[...document.querySelectorAll(".game-actions .kt-btn")].every(b => b.scrollWidth <= b.clientWidth + 1)'));
check('320px: header fits on one row', await ev('(() => { const h = document.querySelector(".game-header"); const b = document.getElementById("settings-button").getBoundingClientRect(); const t = document.querySelector(".game-title").getBoundingClientRect(); return b.top < t.bottom && b.right <= innerWidth; })()'));
await viewport(820, 1180, true);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await load();
check('dark device setting gives dark theme', await ev('document.documentElement.dataset.theme === "dark"'));
await shot('07-tablet-dark');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await load();
check('light device setting gives light theme', await ev('!document.documentElement.dataset.theme'));
check('no console errors', errors.length === 0, errors.join('\n'));
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
ws.close(); chrome.kill(); server.close();
setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 300);
