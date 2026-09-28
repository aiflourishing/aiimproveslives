-- Positive-only voting. Preserve historical reactions for possible future use.
begin;
create or replace function public.set_reaction(p_impact uuid, p_reaction text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  last_vote timestamptz;
begin
  if actor is null or not exists (
    select 1 from auth.users where id = actor and email_confirmed_at is not null
      and coalesce(is_anonymous, false) = false
  ) then raise exception 'Verified sign-in required'; end if;
  if p_reaction is not null and p_reaction not in ('improved', 'heart') then
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

create or replace function public.ranked_impacts()
returns table(impact_id uuid)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else 0 end as score
      from private.reactions r
    union all
    select g.impact_id, case when reaction in ('+1','heart','hooray','rocket','eyes') then 1 else 0 end
      from private.github_reactions g
  )
  select i.id from private.impacts i left join votes v on v.impact_id = i.id
    where i.active group by i.id
    order by coalesce(sum(v.score),0) desc, i.submitted_at desc nulls last, i.id;
$$;

create or replace function public.impact_scores()
returns table(impact_id uuid, score bigint)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else 0 end as score
      from private.reactions r
    union all
    select g.impact_id, case when reaction in ('+1','heart','hooray','rocket','eyes') then 1 else 0 end
      from private.github_reactions g
  ), totals as (
    select i.id, i.submitted_at, coalesce(sum(v.score), 0)::bigint as total
      from private.impacts i left join votes v on v.impact_id = i.id
      where i.active group by i.id, i.submitted_at
  )
  select id, case when total > 5 then total else null::bigint end
    from totals order by total desc, submitted_at desc nulls last, id;
$$;
notify pgrst, 'reload schema';
commit;
