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
-- get_stats() and delete_run() answer only when given the matching key; the tables stay locked.
-- ==========================================================================

create table if not exists public.admin_settings (
    id              int primary key default 1 check (id = 1),
    stats_key_hash  text not null
);
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;

-- True when p_key is the owner's stats key (only its SHA-256 hash is stored)
create or replace function public.is_stats_key(p_key text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
    select p_key is not null and exists (
        select 1 from public.admin_settings
         where stats_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex'))
$$;
revoke all on function public.is_stats_key(text) from public, anon, authenticated;

-- Distinct players per value of one visitor-info column, most common first (top 20)
create or replace function public.stats_breakdown(p_column text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
    v jsonb;
begin
    if p_column not in ('country', 'timezone', 'device', 'language', 'isp', 'city') then
        raise exception 'unknown column';
    end if;
    -- A fixed list of allowed expressions (never user text in the query)
    execute format($q$
        select coalesce(jsonb_agg(jsonb_build_object('value', value, 'players', players) order by players desc, value), '[]'::jsonb)
          from (select coalesce(%s, 'unknown') as value, count(distinct player_id) as players
                  from public.runs group by 1 order by 2 desc, 1 limit 20) x
    $q$, case p_column
            when 'country'  then 'country'
            when 'timezone' then 'timezone'
            when 'device'   then 'device'
            when 'language' then 'language'
            when 'isp'      then 'isp'
            when 'city'     then $e$nullif(concat_ws(', ', city, region, country), '')$e$
            else null end) into v;
    return v;
end
$$;
revoke all on function public.stats_breakdown(text) from public, anon, authenticated;

create or replace function public.get_stats(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v_max_level int;
begin
    if not public.is_stats_key(p_key) then
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
            'networks',       (select count(distinct net_hash) from public.runs),
            'countries',      (select count(distinct country) from public.runs),
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

        -- Where players are and what they use (distinct players per value)
        'by_city',     public.stats_breakdown('city'),
        'by_country',  public.stats_breakdown('country'),
        'by_isp',      public.stats_breakdown('isp'),
        'by_timezone', public.stats_breakdown('timezone'),
        'by_device',   public.stats_breakdown('device'),
        'by_language', public.stats_breakdown('language'),

        -- Most recently active runs
        'recent', (
            select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                select r.id, p.name, r.started_at, r.level - 1 as levels_solved, r.total_moves,
                       coalesce(r.last_solved_at, r.started_at) as last_active,
                       r.country, r.region, r.city, r.isp, r.timezone, r.device, left(r.net_hash, 6) as network
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

-- Delete one run (and its solved levels). If it was the player's last run, the player goes too.
create or replace function public.delete_run(p_key text, p_run uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
    v_player uuid;
begin
    if not public.is_stats_key(p_key) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    delete from public.runs where id = p_run returning player_id into v_player;
    if v_player is null then
        return false;
    end if;
    delete from public.players p
     where p.id = v_player
       and not exists (select 1 from public.runs r where r.player_id = v_player);
    return true;
end
$$;

revoke all on function public.delete_run(text, uuid) from public;
grant execute on function public.delete_run(text, uuid) to anon, authenticated;
