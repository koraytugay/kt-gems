-- ==========================================================================
-- HexaGems · anonymous runs, solved levels and a global leaderboard
--
-- Paste this whole file into Supabase → SQL Editor and run it. Safe to re-run.
--
-- Security model: the browser only holds the public (anon / publishable) key.
-- Tables have row level security ON with NO policies, so that key cannot read
-- or write them directly. It can only call the three functions at the bottom,
-- which validate everything:
--   start_run(player, run)                 → registers a run, returns the player's name
--   record_solve(player, run, level, moves) → the next level in order, with a possible move count
--   get_leaderboard(player, limit)          → best run per player, plus your own row
-- Names are generated here from the player id, so no user-typed text is stored.
-- No IP addresses are stored by these tables.
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
revoke all on public.players, public.runs, public.solves from anon, authenticated;

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

create or replace function public.start_run(p_player uuid, p_run uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
    v_name text := public.player_name(p_player);
begin
    insert into public.players (id, name) values (p_player, v_name)
        on conflict (id) do nothing;
    insert into public.runs (id, player_id) values (p_run, p_player)
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
revoke all on function public.start_run(uuid, uuid)                 from public;
revoke all on function public.record_solve(uuid, uuid, int, int)    from public;
revoke all on function public.get_leaderboard(uuid, int)            from public;
grant execute on function public.start_run(uuid, uuid)              to anon, authenticated;
grant execute on function public.record_solve(uuid, uuid, int, int) to anon, authenticated;
grant execute on function public.get_leaderboard(uuid, int)         to anon, authenticated;
