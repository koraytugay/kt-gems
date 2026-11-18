-- ==========================================================================
-- HexaGems · anonymous runs, solved levels and a global leaderboard
--
-- Paste this whole file into Supabase → SQL Editor and run it. Safe to re-run.
--
-- Security model: the browser only holds the public (anon / publishable) key.
-- Tables have row level security ON with NO policies, so that key cannot read
-- or write them directly. It can only call the three functions at the bottom,
-- which validate everything:
--   start_run(player, run, info)           → registers a run, returns the player's name
--   record_solve(player, run, level, moves) → the next level in order, with a possible move count
--   get_leaderboard(player, limit)          → best run per player, plus your own row
-- Names are generated here from the player id, so no user-typed text is stored.
-- No IP addresses are stored. Each run keeps a coarse, privacy-friendly snapshot:
--   country   from the request (Cloudflare's country header, when present)
--   net_hash  a salted one-way hash of the IP: counts unique networks, can't be reversed
--   timezone, language, device  sent by the browser (e.g. Europe/Istanbul, tr-TR, mobile)
--   city, region, isp           looked up by the browser from a free IP-geolocation service
--                                (GeoJS / ipwho.is); only the result is sent, not the IP
-- ==========================================================================

create table if not exists public.players (
    id          uuid primary key,
    name        text not null,
    created_at  timestamptz not null default now()
);

create table if not exists public.runs (
    id              uuid primary key,
    player_id       uuid not null references public.players (id) on delete cascade,
    started_at      timestamptz not null default now(),
    level           int  not null default 1,      -- the level being played; levels solved = level - 1
    total_moves     int  not null default 0,
    last_solved_at  timestamptz
);
create index if not exists runs_player_idx on public.runs (player_id);
create index if not exists runs_rank_idx on public.runs (level desc, total_moves asc);

-- Coarse visitor info per run (added later; safe to re-run)
alter table public.runs
    add column if not exists country   text,
    add column if not exists net_hash  text,
    add column if not exists timezone  text,
    add column if not exists language  text,
    add column if not exists device    text,
    add column if not exists city      text,
    add column if not exists region    text,
    add column if not exists isp       text;

-- Server-only secrets: the random salt that makes net_hash irreversible
create table if not exists public.server_settings (
    id       int primary key default 1 check (id = 1),
    ip_salt  text not null default (gen_random_uuid()::text || gen_random_uuid()::text)
);
insert into public.server_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.solves (
    id         bigint generated always as identity primary key,
    run_id     uuid not null references public.runs (id) on delete cascade,
    level      int  not null,
    moves      int  not null,
    solved_at  timestamptz not null default now()
);
create index if not exists solves_run_idx on public.solves (run_id);

-- Lock the tables: no direct access with the public key
alter table public.players enable row level security;
alter table public.runs    enable row level security;
alter table public.solves  enable row level security;
alter table public.server_settings enable row level security;
revoke all on public.players, public.runs, public.solves, public.server_settings from anon, authenticated;

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

-- Fewest clicks a level can need. Mirrors levelConfig() in game.js:
-- levels 10-13 are the eased-in 4-click levels, later levels shift by 4.
create or replace function public.level_clicks(p_level int)
returns int language sql immutable as $$
    select least(40, 1 + ((case
        when p_level between 10 and 13 then 10
        when p_level >= 14 then p_level - 4
        else p_level end) - 1) / 3)
$$;

-- A friendly, fixed name for a player id, e.g. "Amber Fox #4F2A"
create or replace function public.player_name(p_player uuid)
returns text language sql immutable as $$
    with h as (select decode(md5(p_player::text), 'hex') as b)
    select (array['Amber','Azure','Brave','Calm','Clever','Coral','Crimson','Daring','Gentle','Golden',
                  'Happy','Indigo','Jade','Lucky','Mellow','Misty','Nimble','Quiet','Rapid','Silver',
                  'Sunny','Swift','Teal','Velvet','Wild','Witty','Bold','Cosmic','Frosty','Noble'])[1 + get_byte(b, 0) % 30]
        || ' ' ||
           (array['Badger','Bear','Crane','Dolphin','Eagle','Falcon','Fox','Gecko','Hare','Heron',
                  'Lynx','Marten','Moose','Otter','Owl','Panda','Puffin','Raven','Seal','Sparrow',
                  'Stag','Swan','Tiger','Turtle','Wolf','Yak','Koala','Lemur','Orca','Wren'])[1 + get_byte(b, 1) % 30]
        || ' #' || upper(substr(replace(p_player::text, '-', ''), 1, 4))
    from h
$$;

-- --------------------------------------------------------------------------
-- The public API (the only things the public key can call)
-- --------------------------------------------------------------------------

drop function if exists public.start_run(uuid, uuid);   -- replaced by the version with p_info

create or replace function public.start_run(p_player uuid, p_run uuid, p_info jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
    v_name     text := public.player_name(p_player);
    v_headers  json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
    v_ip       text;
    v_country  text;
    v_tz       text := p_info ->> 'timezone';
    v_lang     text := p_info ->> 'language';
    v_device   text := p_info ->> 'device';
    v_city     text := p_info ->> 'city';
    v_region   text := p_info ->> 'region';
    v_isp      text := p_info ->> 'isp';
    v_cc       text := upper(p_info ->> 'country');
begin
    -- Network: hash the caller's IP with a secret salt; the IP itself is never stored
    v_ip := coalesce(v_headers ->> 'cf-connecting-ip', v_headers ->> 'x-real-ip',
                     nullif(trim(split_part(v_headers ->> 'x-forwarded-for', ',', 1)), ''));
    v_country := upper(v_headers ->> 'cf-ipcountry');
    if v_country !~ '^[A-Z]{2}$' or v_country in ('XX', 'T1') then v_country := null; end if;

    -- Only accept well-formed browser info
    if v_tz is not null and (length(v_tz) > 64 or v_tz !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$') then v_tz := null; end if;
    if v_lang is not null and v_lang !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$' then v_lang := null; end if;
    if v_device is not null and v_device not in ('mobile', 'tablet', 'desktop') then v_device := null; end if;
    -- Place names: plain text only, short, no control characters or markup
    if v_city   is not null and v_city   !~ '^[^[:cntrl:]<>]{1,80}$' then v_city   := null; end if;
    if v_region is not null and v_region !~ '^[^[:cntrl:]<>]{1,80}$' then v_region := null; end if;
    if v_isp    is not null and v_isp    !~ '^[^[:cntrl:]<>]{1,80}$' then v_isp    := null; end if;
    if v_cc     is not null and v_cc     !~ '^[A-Z]{2}$'             then v_cc     := null; end if;
    v_country := coalesce(v_country, v_cc);   -- the request's own country wins; else the lookup's

    insert into public.players (id, name) values (p_player, v_name)
        on conflict (id) do nothing;
    insert into public.runs (id, player_id, country, net_hash, timezone, language, device, city, region, isp)
    values (p_run, p_player, v_country,
            case when v_ip is null then null else
                left(encode(digest(v_ip || (select ip_salt from public.server_settings where id = 1), 'sha256'), 'hex'), 16) end,
            v_tz, v_lang, v_device, v_city, v_region, v_isp)
        on conflict (id) do nothing;
    if not exists (select 1 from public.runs where id = p_run and player_id = p_player) then
        raise exception 'run belongs to another player' using errcode = 'P0001';
    end if;
    return v_name;
end
$$;

create or replace function public.record_solve(p_player uuid, p_run uuid, p_level int, p_moves int)
returns int language plpgsql security definer set search_path = public as $$
declare
    v_run public.runs;
begin
    select * into v_run from public.runs where id = p_run and player_id = p_player for update;
    if not found then
        raise exception 'unknown run' using errcode = 'P0001';
    end if;
    if p_level is distinct from v_run.level then
        raise exception 'level out of order: run is on level %, got %', v_run.level, p_level using errcode = 'P0001';
    end if;
    if p_moves is null or p_moves < public.level_clicks(p_level) or p_moves > 10000 then
        raise exception 'impossible move count' using errcode = 'P0001';
    end if;

    insert into public.solves (run_id, level, moves) values (p_run, p_level, p_moves);
    update public.runs
       set level = level + 1,
           total_moves = total_moves + p_moves,
           last_solved_at = now()
     where id = p_run;
    return p_level + 1;
end
$$;

-- Best run per player, ranked by levels solved (more is better), then total moves (fewer is better).
-- Returns the top p_limit rows, plus the caller's own row if it is further down.
create or replace function public.get_leaderboard(p_player uuid, p_limit int default 20)
returns table (rank bigint, name text, levels_solved int, total_moves int, is_you boolean)
language sql stable security definer set search_path = public as $$
    with best as (
        select distinct on (r.player_id)
               r.player_id, r.level - 1 as levels_solved, r.total_moves, r.last_solved_at
          from public.runs r
         where r.level > 1
         order by r.player_id, r.level desc, r.total_moves asc, r.last_solved_at asc
    ), ranked as (
        select rank() over (order by b.levels_solved desc, b.total_moves asc) as rank,
               b.player_id, b.levels_solved, b.total_moves, b.last_solved_at
          from best b
    )
    select k.rank, p.name, k.levels_solved, k.total_moves, (k.player_id = p_player) as is_you
      from ranked k
      join public.players p on p.id = k.player_id
     where k.rank <= least(greatest(coalesce(p_limit, 20), 1), 100)
        or k.player_id = p_player
     order by k.rank, k.last_solved_at
$$;

-- Only the API functions are callable with the public key
revoke all on function public.start_run(uuid, uuid, jsonb)          from public;
revoke all on function public.record_solve(uuid, uuid, int, int)    from public;
revoke all on function public.get_leaderboard(uuid, int)            from public;
grant execute on function public.start_run(uuid, uuid, jsonb)       to anon, authenticated;
grant execute on function public.record_solve(uuid, uuid, int, int) to anon, authenticated;
grant execute on function public.get_leaderboard(uuid, int)         to anon, authenticated;
