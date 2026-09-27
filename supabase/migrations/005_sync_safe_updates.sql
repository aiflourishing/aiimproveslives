-- Keep sync compatible with Supabase safe-update checks. Website votes are preserved.
create or replace function public.sync_github_reactions(p_impacts uuid[], p_reactions jsonb, p_submitted_at jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.impacts set active = false where active;
  insert into private.impacts(id, active, submitted_at)
    select id, true, (p_submitted_at ->> id::text)::timestamptz from unnest(p_impacts) as ids(id)
    on conflict(id) do update set active = true,
      submitted_at = coalesce(excluded.submitted_at, private.impacts.submitted_at);
  delete from private.github_reactions where reaction_id is not null;
  insert into private.github_reactions(reaction_id, impact_id, github_user_id, reaction, created_at)
    select x.reaction_id, x.impact_id, x.github_user_id, x.reaction, x.created_at
    from jsonb_to_recordset(p_reactions) as x(
      reaction_id bigint, impact_id uuid, github_user_id bigint, reaction text, created_at timestamptz
    );
end $$;
