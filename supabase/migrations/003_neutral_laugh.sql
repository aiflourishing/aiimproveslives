-- Existing installations: run this migration once after 001_reactions.sql.
-- Preserve all stored reactions and access grants; only change ranking weights.
create or replace function public.ranked_impacts()
returns table(impact_id uuid)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else -1 end as score
      from private.reactions r
    union all
    select g.impact_id, case
      when reaction in ('-1','confused') then -1
      when reaction = 'laugh' then 0
      else 1 end
      from private.github_reactions g
  )
  select i.id from private.impacts i left join votes v on v.impact_id = i.id
    where i.active group by i.id order by coalesce(sum(v.score),0) desc, i.id;
$$;
