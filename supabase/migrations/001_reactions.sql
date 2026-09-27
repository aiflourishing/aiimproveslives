-- Run once in Supabase SQL Editor. Only the narrow RPCs below are public.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.impacts (
  id uuid primary key,
  active boolean not null default true
);
create table private.reactions (
  user_id uuid not null references auth.users(id) on delete cascade,
  impact_id uuid not null references private.impacts(id),
  reaction text not null check (reaction in ('improved', 'heart', 'confused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, impact_id)
);
create index reactions_impact_idx on private.reactions(impact_id);
create table private.vote_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_vote_at timestamptz not null
);
alter table private.impacts enable row level security;
alter table private.reactions enable row level security;
alter table private.vote_limits enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

create function public.set_reaction(p_impact uuid, p_reaction text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  last_vote timestamptz;
begin
  if actor is null or not exists (
    select 1 from auth.users where id = actor and email_confirmed_at is not null
      and coalesce(is_anonymous, false) = false
  ) then raise exception 'Verified sign-in required'; end if;
  if p_reaction is not null and p_reaction not in ('improved', 'heart', 'confused') then
    raise exception 'Invalid reaction';
  end if;
  if not exists(select 1 from private.impacts where id = p_impact and active) then
    raise exception 'Unknown impact';
  end if;
  -- Serialize writes per account so parallel requests cannot bypass the limit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text, 0));
  select last_vote_at into last_vote from private.vote_limits where user_id = actor;
  if last_vote > clock_timestamp() - interval '1 second' then
    raise exception 'Please wait a moment before reacting again';
  end if;
  insert into private.vote_limits values(actor, clock_timestamp())
    on conflict (user_id) do update set last_vote_at = excluded.last_vote_at;
  if p_reaction is null then
    delete from private.reactions where user_id = actor and impact_id = p_impact;
  else
    insert into private.reactions(user_id, impact_id, reaction) values(actor, p_impact, p_reaction)
      on conflict (user_id, impact_id) do update
        set reaction = excluded.reaction, updated_at = clock_timestamp();
  end if;
end $$;

create function public.my_reactions()
returns table(impact_id uuid, reaction text)
language sql stable security definer set search_path = '' as $$
  select r.impact_id, r.reaction from private.reactions r
    join private.impacts i on i.id = r.impact_id and i.active
    where r.user_id = auth.uid();
$$;

-- Snapshot of reactions on each impact's canonical original merged PR.
create table private.github_reactions (
  reaction_id bigint not null,
  impact_id uuid not null references private.impacts(id),
  github_user_id bigint not null,
  reaction text not null check (reaction in ('+1','-1','laugh','confused','heart','hooray','rocket','eyes')),
  created_at timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (impact_id, reaction_id)
);
create index github_reactions_impact_idx on private.github_reactions(impact_id);
alter table private.github_reactions enable row level security;
revoke all on private.github_reactions from public, anon, authenticated;

-- Expose ordering only, never voters or scores. UUID breaks ties reproducibly.
create function public.ranked_impacts()
returns table(impact_id uuid)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else -1 end as score
      from private.reactions r
    union all
    select g.impact_id, case when reaction in ('-1','laugh','confused') then -1 else 1 end
      from private.github_reactions g
  )
  select i.id from private.impacts i left join votes v on v.impact_id = i.id
    where i.active group by i.id order by coalesce(sum(v.score),0) desc, i.id;
$$;

-- Callable only by the scheduled server job. The snapshot is replaced atomically:
-- removed GitHub reactions stop counting; deleted impacts become inactive.
create function public.sync_github_reactions(p_impacts uuid[], p_reactions jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.impacts set active = false;
  insert into private.impacts(id, active) select unnest(p_impacts), true
    on conflict(id) do update set active = true;
  delete from private.github_reactions;
  insert into private.github_reactions(reaction_id, impact_id, github_user_id, reaction, created_at)
    select x.reaction_id, x.impact_id, x.github_user_id, x.reaction, x.created_at
    from jsonb_to_recordset(p_reactions) as x(
      reaction_id bigint, impact_id uuid, github_user_id bigint, reaction text, created_at timestamptz
    );
end $$;
revoke all on function public.sync_github_reactions(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.sync_github_reactions(uuid[], jsonb) to service_role;
revoke all on function public.set_reaction(uuid,text) from public, anon, authenticated;
revoke all on function public.my_reactions() from public, anon, authenticated;
revoke all on function public.ranked_impacts() from public, anon, authenticated;
grant execute on function public.set_reaction(uuid,text) to authenticated;
grant execute on function public.my_reactions() to authenticated;
grant execute on function public.ranked_impacts() to anon, authenticated, service_role;
