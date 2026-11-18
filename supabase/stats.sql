-- ==========================================================================
-- HexaGems · stats for the owner. Run any of these in Supabase → SQL Editor.
-- (These tables are not readable with the public key; only you see this.)
-- ==========================================================================

-- Totals
select (select count(*) from players)                    as players,
       (select count(*) from runs)                       as runs,
       (select count(*) from solves)                     as levels_solved,
       (select max(level) - 1 from runs)                 as best_run_levels;

-- Players and runs per day
select date_trunc('day', r.started_at)::date as day,
       count(distinct r.player_id)           as players,
       count(*)                              as runs_started
  from runs r
 group by 1
 order by 1 desc;

-- How far runs get: how many runs reached each level
select l as level,
       count(*) filter (where r.level >= l) as runs_reaching_it
  from generate_series(1, (select coalesce(max(level), 1) from runs)) as l
 cross join runs r
 group by l
 order by l;

-- Where people stop: the level each run is stuck on (most common first)
select level as stopped_on_level, count(*) as runs
  from runs
 group by level
 order by runs desc, level;

-- Average moves vs. the fewest possible, per level (how hard each level feels)
select s.level,
       count(*)                          as solves,
       round(avg(s.moves), 1)            as avg_moves,
       public.level_clicks(s.level)      as fewest_possible
  from solves s
 group by s.level
 order by s.level;

-- Most active players
select p.name, count(distinct r.id) as runs, max(r.level) - 1 as best_levels_solved, max(r.last_solved_at) as last_seen
  from players p
  join runs r on r.player_id = p.id
 group by p.name
 order by runs desc
 limit 50;
