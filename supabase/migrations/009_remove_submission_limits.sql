-- Allow consecutive submissions without a daily cap. Keep receipt identity and duplicate handling.
create or replace function public.reserve_submission(p_user uuid, p_id uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt private.submissions;
begin
  if not exists(select 1 from auth.users where id = p_user and email_confirmed_at is not null
    and coalesce(is_anonymous, false) = false) then raise exception 'Verified sign-in required'; end if;
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid hash'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text, 1));
  select * into receipt from private.submissions where id = p_id;
  if found and (receipt.user_id <> p_user or receipt.payload_hash <> p_hash) then
    raise exception 'Submission identifier already used';
  end if;
  select * into receipt from private.submissions where user_id = p_user and payload_hash = p_hash;
  if found and receipt.status <> 'failed' then
    return to_jsonb(receipt) || '{"fresh":false}'::jsonb;
  end if;
  if receipt.id is not null then
    update private.submissions set status = 'pending', created_at = clock_timestamp()
      where id = receipt.id returning * into receipt;
  else
    insert into private.submissions(id, user_id, payload_hash) values(p_id, p_user, p_hash)
      returning * into receipt;
  end if;
  return to_jsonb(receipt) || '{"fresh":true}'::jsonb;
end $$;

notify pgrst, 'reload schema';
