# HexaGems

A hexagonal flip puzzle: tap a gem to flip it and the six around it, and make every gem the same color.
Endless levels, from one click up.

- Play: https://koraytugay.github.io/kt-gems/
- Plain HTML, CSS and JavaScript on [kt-styles](https://github.com/koraytugay/kt-styles). No build step.

## Backend: Supabase

**This webpage uses [Supabase](https://supabase.com/)** for the global leaderboard and the play stats.

- Project: `cxtibqbukakubilrvwwu` (https://cxtibqbukakubilrvwwu.supabase.co)
- The game uses the project's **publishable** key (in `game.js` and `stats.js`). It is public by design:
  it can only call the functions below. The database tables are locked.
- Never put the database password in this repo.

| File | What it is |
|---|---|
| `supabase/schema.sql` | Tables and the game's functions: `start_run`, `record_solve`, `get_leaderboard` |
| `supabase/stats-api.sql` | The private stats functions: `get_stats`, `delete_run` (need the stats key) |
| `supabase/stats.sql` | Handy queries to run by hand |

To install or update: in Supabase, open **SQL Editor**, paste a file and click **Run**.
Run `schema.sql` first, then `stats-api.sql`. Both are safe to re-run.

```bash
pbcopy < supabase/schema.sql
```

## Stats page

https://koraytugay.github.io/kt-gems/stats.html is not linked from the game and asks for the stats key.
Only a SHA-256 hash of the key is stored in Supabase (`admin_settings`). To change the key:

```sql
insert into public.admin_settings (id, stats_key_hash)
values (1, '<sha256 hex of the new key>')
on conflict (id) do update set stats_key_hash = excluded.stats_key_hash;
```

```bash
printf '%s' 'new-key' | shasum -a 256
```

## Location lookups

When a run starts, the browser asks [GeoJS](https://www.geojs.io/) (backup: [ipwho.is](https://ipwho.is/))
for city, region, country and internet provider, and sends only that result to Supabase.
IP addresses are never stored; the server keeps a salted hash to count unique networks.

## Tests

```bash
node --test tests/logic.test.js    # rules, solver and level generation
node tests/browser.test.mjs        # the real page in headless Chrome (Node 22+, Chrome)
```

The browser tests never contact Supabase or GeoJS; they use a fake server inside the page.
