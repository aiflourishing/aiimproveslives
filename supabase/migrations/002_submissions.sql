-- Private receipts prevent double submission and enforce limits across function instances.
create table private.submissions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'failed')),
  issue_number bigint,
  unique(user_id, payload_hash)
);
alter table private.submissions enable row level security;
revoke all on private.submissions from public, anon, authenticated;

create function public.reserve_submission(p_user uuid, p_id uuid, p_hash text)
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
  if exists(select 1 from private.submissions where user_id = p_user
    and created_at > clock_timestamp() - interval '60 seconds') or
    (select count(*) from private.submissions where user_id = p_user
      and created_at > clock_timestamp() - interval '1 day') >= 10 then
    raise exception 'Submission limit reached';
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

create function public.finish_submission(p_user uuid, p_id uuid, p_issue bigint)
returns void language sql security definer set search_path = '' as $$
  update private.submissions set status = case when p_issue is null then 'failed' else 'submitted' end,
    issue_number = p_issue where id = p_id and user_id = p_user and status = 'pending';
$$;
create function public.submission_receipt(p_user uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) from private.submissions s where id = p_id and user_id = p_user;
$$;
revoke all on function public.reserve_submission(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_submission(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.submission_receipt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_submission(uuid, uuid, text) to service_role;
grant execute on function public.finish_submission(uuid, uuid, bigint) to service_role;
grant execute on function public.submission_receipt(uuid, uuid) to service_role;
