-- ==========================================================================
-- HexaGems · private stats for stats.html
--
-- Paste this whole file into Supabase → SQL Editor and run it (safe to re-run).
-- Then store the SHA-256 hash of your secret stats key (never the key itself):
--
--   insert into public.admin_settings (id, stats_key_hash) values (1, '<sha256 hex of your key>')
--   on conflict (id) do update set stats_key_hash = excluded.stats_key_hash;
--
-- To change the key later, run that insert again with a new hash.
-- get_stats() answers only when given the matching key; the tables stay locked.
-- ==========================================================================

create table if not exists public.admin_settings (
    id              int primary key default 1 check (id = 1),
    stats_key_hash  text not null
);
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;

create or replace function public.get_stats(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v_max_level int;
begin
    if p_key is null or not exists (
        select 1 from public.admin_settings
         where stats_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
    ) then
        raise exception 'not allowed' using errcode = '42501';
    end if;

    select coalesce(max(level), 1) into v_max_level from public.runs;

    return jsonb_build_object(
        'generated_at', now(),

        'totals', jsonb_build_object(
            'players',        (select count(*) from public.players),
            'runs',           (select count(*) from public.runs),
            'levels_solved',  (select count(*) from public.solves),
            'best_run',       (select coalesce(max(level) - 1, 0) from public.runs),
            'active_today',   (select count(distinct r.player_id) from public.runs r
                                where r.started_at > now() - interval '1 day'
                                   or r.last_solved_at > now() - interval '1 day'),
            'active_7_days',  (select count(distinct r.player_id) from public.runs r
                                where r.started_at > now() - interval '7 days'
                                   or r.last_solved_at > now() - interval '7 days')
        ),

        -- Last 30 days (UTC): players who started a run or solved a level that day
        'daily', (
            select coalesce(jsonb_agg(d order by d.day desc), '[]'::jsonb) from (
                select a.day,
                       count(distinct a.player_id)                     as active_players,
                       count(distinct a.run_id) filter (where a.kind = 'start') as runs_started,
                       count(*) filter (where a.kind = 'solve')        as levels_solved
                  from (
                        select date_trunc('day', r.started_at)::date as day, r.player_id, r.id as run_id, 'start' as kind
                          from public.runs r
                        union all
                        select date_trunc('day', s.solved_at)::date, r.player_id, r.id, 'solve'
                          from public.solves s join public.runs r on r.id = s.run_id
                       ) a
                 where a.day > (now() - interval '30 days')::date
                 group by a.day
            ) d
        ),

        -- How far runs get: runs that reached each level
        'reached', (
            select coalesce(jsonb_agg(jsonb_build_object('level', l, 'runs', n) order by l), '[]'::jsonb) from (
                select l, (select count(*) from public.runs r where r.level >= l) as n
                  from generate_series(1, v_max_level) as l
            ) x
        ),

        -- Where runs are now (the level each run is on)
        'current', (
            select coalesce(jsonb_agg(jsonb_build_object('level', level, 'runs', n) order by level), '[]'::jsonb) from (
                select level, count(*) as n from public.runs group by level
            ) x
        ),

        -- How hard each level feels: average moves vs. the fewest possible
        'per_level', (
            select coalesce(jsonb_agg(jsonb_build_object(
                       'level', level, 'solves', n, 'avg_moves', avg_moves,
                       'fewest', public.level_clicks(level)) order by level), '[]'::jsonb) from (
                select level, count(*) as n, round(avg(moves), 1) as avg_moves
                  from public.solves group by level
            ) x
        ),

        -- Most recently active runs
        'recent', (
            select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                select p.name, r.started_at, r.level - 1 as levels_solved, r.total_moves,
                       coalesce(r.last_solved_at, r.started_at) as last_active
                  from public.runs r join public.players p on p.id = r.player_id
                 order by coalesce(r.last_solved_at, r.started_at) desc
                 limit 25
            ) x
        )
    );
end
$$;

revoke all on function public.get_stats(text) from public;
grant execute on function public.get_stats(text) to anon, authenticated;
