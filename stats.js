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

async function callApi(fn, args) {
    const res = await fetch(`${STATS_API.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: STATS_API.key, Authorization: `Bearer ${STATS_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('bad key'), { badKey: true });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text.includes(fn) ? `The ${fn} function is not installed yet (run supabase/stats-api.sql).` : `Server error ${res.status}`);
    }
    return res.json();
}

const fetchStats = key => callApi('get_stats', { p_key: key });

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
        ['Best run', t.best_run], ['Networks', t.networks], ['Countries', t.countries],
        ['Active today', t.active_today], ['Active 7 days', t.active_7_days]
    ];
    $('totals').replaceChildren(...tiles.map(([label, value]) => {
        const tile = el('div', 'kt-stat');
        tile.append(el('div', 'kt-stat__value', number(value)), el('div', 'kt-stat__label kt-fs-base', label));
        return tile;
    }));
}

/** A bar per row: label · bar scaled to the largest value · value. */
function renderBars(target, rows, emptyText, label = r => `Level ${r.level}`, value = r => r.runs) {
    const list = $(target);
    if (!rows.length) { list.replaceChildren(el('p', 'kt-text-secondary', emptyText)); return; }
    const max = Math.max(...rows.map(value), 1);
    list.replaceChildren(...rows.map(r => {
        const row = el('div', 'kt-bar-list__row');
        const track = el('div', 'kt-progress kt-progress--lg');
        const bar = el('div', 'kt-progress__bar');
        bar.style.width = `${(value(r) / max) * 100}%`;
        track.append(bar);
        row.append(el('span', 'kt-bar-list__label', label(r)), track, el('span', 'kt-bar-list__value', number(value(r))));
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
        cells.forEach((value, i) => {
            const td = el('td', headers[i][1] ? 'kt-num' : '');
            if (value instanceof Node) td.append(value); else td.textContent = String(value);
            tr.append(td);
        });
        tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
}

function render(stats) {
    renderTotals(stats.totals);
    renderBars('reached', stats.reached.filter(r => r.runs > 0), 'No runs yet.');
    renderBars('current', stats.current, 'No runs yet.');
    for (const [target, key] of [['by-city', 'by_city'], ['by-country', 'by_country'], ['by-isp', 'by_isp'],
                                 ['by-timezone', 'by_timezone'], ['by-device', 'by_device'], ['by-language', 'by_language']]) {
        renderBars(target, stats[key] || [], 'No data yet.', r => r.value, r => r.players);
    }
    renderTable('daily', [['Day (UTC)'], ['Active players', true], ['Runs started', true], ['Levels solved', true]],
        stats.daily.map(d => [day(d.day), number(d.active_players), number(d.runs_started), number(d.levels_solved)]),
        'No activity in the last 30 days.');
    renderTable('per-level', [['Level'], ['Solves', true], ['Average moves', true], ['Fewest possible', true]],
        stats.per_level.map(l => [l.level, number(l.solves), l.avg_moves, l.fewest]),
        'No levels solved yet.');
    const place = r => [r.city, r.region, r.country].filter(Boolean).join(', ') || '–';
    const deleteButton = r => {
        const btn = el('button', 'kt-btn kt-btn--danger', 'Delete');
        btn.type = 'button';
        btn.dataset.run = r.id;
        btn.dataset.label = `${r.name}, ${number(r.levels_solved)} levels solved`;
        btn.setAttribute('aria-label', `Delete run of ${r.name}`);
        return btn;
    };
    renderTable('recent', [['Player'], ['Place'], ['Provider'], ['Device'], ['Network'], ['Levels solved', true], ['Moves', true], ['Last active'], ['']],
        stats.recent.map(r => [r.name, place(r), r.isp || '–', r.device || '–', r.network || '–',
                               number(r.levels_solved), number(r.total_moves), dateTime(r.last_active),
                               r.id ? deleteButton(r) : '']),
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
$('recent').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-run]');
    if (!btn) return;
    if (!window.confirm(`Delete this run (${btn.dataset.label})? Its solved levels are deleted too. This can't be undone.`)) return;
    btn.disabled = true;
    try {
        await callApi('delete_run', { p_key: storedKey(), p_run: btn.dataset.run });
        load(storedKey());
    } catch (err) {
        btn.disabled = false;
        if (err.badKey) { storeKey(null); show('locked'); return; }
        window.alert(err.message);
    }
});
$('lock-button').addEventListener('click', () => {
    storeKey(null);
    $('key-input').value = '';
    show('locked');
});

const saved = storedKey();
if (saved) load(saved);
else { show('locked'); $('key-input').focus(); }
