-- Preserve legacy Issue receipts; new submissions link directly to a PR.
alter table private.submissions add column pr_number bigint;

create function public.finish_pr_submission(p_user uuid, p_id uuid, p_pr bigint)
returns void language sql security definer set search_path = '' as $$
  update private.submissions set status = case when p_pr is null then 'failed' else 'submitted' end,
    pr_number = p_pr where id = p_id and user_id = p_user and status = 'pending';
$$;
revoke all on function public.finish_pr_submission(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.finish_pr_submission(uuid, uuid, bigint) to service_role;
notify pgrst, 'reload schema';
