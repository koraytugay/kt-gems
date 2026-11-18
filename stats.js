/* ==========================================================================
   HexaGems · private stats page (stats.html, not linked from the game).
   Calls get_stats(key) from supabase/stats-api.sql. The key is typed once and
   remembered on this device only; without it the server returns nothing.
   ========================================================================== */
'use strict';

const STATS_API = {
    url: 'https://cxtibqbukakubilrvwwu.supabase.co',
    key: 'sb_publishable_T8Ety6sOh2Cer-w1-pALcg_gAarJL8t'   // public key, same as game.js
};
const STATS_KEY_STORE = 'hexagems-stats-key';

const $ = id => document.getElementById(id);

function storedKey() { try { return localStorage.getItem(STATS_KEY_STORE); } catch (e) { return null; } }
function storeKey(key) {
    try { key ? localStorage.setItem(STATS_KEY_STORE, key) : localStorage.removeItem(STATS_KEY_STORE); } catch (e) { /* ignore */ }
}

async function fetchStats(key) {
    const res = await fetch(`${STATS_API.url}/rest/v1/rpc/get_stats`, {
        method: 'POST',
        headers: { apikey: STATS_API.key, Authorization: `Bearer ${STATS_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key: key })
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('bad key'), { badKey: true });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text.includes('get_stats') ? 'The stats function is not installed yet (run supabase/stats-api.sql).' : `Server error ${res.status}`);
    }
    return res.json();
}

/* ---------- Rendering ---------- */

const number = n => Number(n || 0).toLocaleString();
const dateTime = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderTotals(t) {
    const tiles = [
        ['Players', t.players], ['Runs', t.runs], ['Levels solved', t.levels_solved],
        ['Best run', t.best_run], ['Active today', t.active_today], ['Active 7 days', t.active_7_days]
    ];
    $('totals').replaceChildren(...tiles.map(([label, value]) => {
        const tile = el('div', 'kt-stat');
        tile.append(el('div', 'kt-stat__value', number(value)), el('div', 'kt-stat__label kt-fs-base', label));
        return tile;
    }));
}

function renderBars(target, rows, emptyText) {
    const list = $(target);
    if (!rows.length) { list.replaceChildren(el('p', 'kt-text-secondary', emptyText)); return; }
    const max = Math.max(...rows.map(r => r.runs), 1);
    list.replaceChildren(...rows.map(r => {
        const row = el('div', 'kt-bar-list__row');
        const track = el('div', 'kt-progress kt-progress--lg');
        const bar = el('div', 'kt-progress__bar');
        bar.style.width = `${(r.runs / max) * 100}%`;
        track.append(bar);
        row.append(el('span', 'kt-bar-list__label', `Level ${r.level}`), track, el('span', 'kt-bar-list__value', number(r.runs)));
        return row;
    }));
}

function renderTable(target, headers, rows, emptyText) {
    const table = $(target);
    const thead = el('thead');
    const headRow = el('tr');
    for (const [label, numeric] of headers) headRow.append(el('th', numeric ? 'kt-num' : '', label));
    thead.append(headRow);
    const tbody = el('tbody');
    if (!rows.length) {
        const tr = el('tr');
        const td = el('td', 'kt-text-secondary', emptyText);
        td.colSpan = headers.length;
        tr.append(td);
        tbody.append(tr);
    }
    for (const cells of rows) {
        const tr = el('tr');
        cells.forEach((value, i) => tr.append(el('td', headers[i][1] ? 'kt-num' : '', String(value))));
        tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
}

function render(stats) {
    renderTotals(stats.totals);
    renderBars('reached', stats.reached.filter(r => r.runs > 0), 'No runs yet.');
    renderBars('current', stats.current, 'No runs yet.');
    renderTable('daily', [['Day (UTC)'], ['Active players', true], ['Runs started', true], ['Levels solved', true]],
        stats.daily.map(d => [day(d.day), number(d.active_players), number(d.runs_started), number(d.levels_solved)]),
        'No activity in the last 30 days.');
    renderTable('per-level', [['Level'], ['Solves', true], ['Average moves', true], ['Fewest possible', true]],
        stats.per_level.map(l => [l.level, number(l.solves), l.avg_moves, l.fewest]),
        'No levels solved yet.');
    renderTable('recent', [['Player'], ['Started'], ['Levels solved', true], ['Moves', true], ['Last active']],
        stats.recent.map(r => [r.name, dateTime(r.started_at), number(r.levels_solved), number(r.total_moves), dateTime(r.last_active)]),
        'No runs yet.');
    $('generated-at').textContent = `Updated ${dateTime(stats.generated_at)}.`;
}

/* ---------- Flow ---------- */

function show(state, message) {
    $('key-form').hidden = state !== 'locked';
    $('stats-loading').hidden = state !== 'loading';
    $('stats').hidden = state !== 'ready';
    $('stats-actions').hidden = state !== 'ready';
    $('stats-error').hidden = state !== 'error';
    if (state === 'error') $('stats-error').textContent = message;
}

async function load(key) {
    show('loading');
    try {
        const stats = await fetchStats(key);
        storeKey(key);
        render(stats);
        show('ready');
    } catch (e) {
        if (e.badKey) {
            storeKey(null);
            show('locked');
            $('key-error').hidden = false;
            $('key-input').focus();
        } else {
            show('error', e.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection.' : e.message);
        }
    }
}

$('key-form').addEventListener('submit', e => {
    e.preventDefault();
    $('key-error').hidden = true;
    load($('key-input').value.trim());
});
$('refresh-button').addEventListener('click', () => load(storedKey()));
$('lock-button').addEventListener('click', () => {
    storeKey(null);
    $('key-input').value = '';
    show('locked');
});

const saved = storedKey();
if (saved) load(saved);
else { show('locked'); $('key-input').focus(); }
