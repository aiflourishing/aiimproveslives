-- Publish only aggregate scores above five; keep voter rows and lower scores private.
begin;
create or replace function public.impact_scores()
returns table(impact_id uuid, score bigint)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else -1 end as score
      from private.reactions r
    union all
    select g.impact_id, case when reaction in ('-1','confused') then -1
      when reaction = 'laugh' then 0 else 1 end
      from private.github_reactions g
  ), totals as (
    select i.id, i.submitted_at, coalesce(sum(v.score), 0)::bigint as total
      from private.impacts i left join votes v on v.impact_id = i.id
      where i.active group by i.id, i.submitted_at
  )
  select id, case when total > 5 then total else null::bigint end
    from totals order by total desc, submitted_at desc nulls last, id;
$$;
revoke all on function public.impact_scores() from public, anon, authenticated;
grant execute on function public.impact_scores() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
