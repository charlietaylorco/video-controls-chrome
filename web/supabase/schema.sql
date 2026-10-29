-- Recent saves v1. Run once in the Supabase SQL editor, using the owner role.
-- This is a private single-owner application. Disable public account signup.
-- Browser callers never receive the service role key or direct table grants.
begin;
create table public.rs_items (
 user_id uuid not null references auth.users(id) on delete cascade,
 video_url text not null check (video_url ~ '^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{1,100}$'),
 saved_at bigint not null check (saved_at > 0),
 data jsonb not null check (jsonb_typeof(data) = 'object'),
 revision bigint not null default 1 check (revision > 0),
 local_updated_at bigint not null default 0,
 cloud_updated_at bigint not null default 0,
 content_edited boolean not null default false,
 primary key (user_id, video_url)
);
create index rs_items_recent on public.rs_items(user_id, saved_at desc, video_url desc);
create table public.rs_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '{"theme":"system","timerDefault":15}'::jsonb
);
create table public.rs_devices (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null default (now() + interval '90 days')
);
create index rs_devices_owner on public.rs_devices(user_id);
create table public.rs_tickets (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 snapshot jsonb not null,
 expires_at timestamptz not null default (now() + interval '2 minutes')
);
create index rs_tickets_owner on public.rs_tickets(user_id);
create table public.rs_budgets (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '{"blockedUntil":0}'::jsonb
);

alter table public.rs_items enable row level security;
alter table public.rs_settings enable row level security;
alter table public.rs_devices enable row level security;
alter table public.rs_tickets enable row level security;
alter table public.rs_budgets enable row level security;
create policy rs_items_owner on public.rs_items to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy rs_settings_owner on public.rs_settings to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy rs_devices_owner on public.rs_devices to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy rs_tickets_owner on public.rs_tickets to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy rs_budgets_owner on public.rs_budgets to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.rs_items, public.rs_settings, public.rs_devices, public.rs_tickets, public.rs_budgets from public, anon, authenticated;
grant select, insert, update, delete on public.rs_items, public.rs_settings, public.rs_devices, public.rs_tickets, public.rs_budgets to service_role;

create function public.rs_normalize(value text) returns text language sql immutable parallel safe set search_path = '' as $$
 select lower(regexp_replace(btrim(normalize(coalesce(value, ''), NFKC)), '\s+', ' ', 'g'));
$$;
create function public.rs_item(p_user_id uuid, p_args jsonb) returns jsonb language sql stable set search_path = '' as $$
 select data || jsonb_build_object('revision', revision) from public.rs_items where user_id = p_user_id and video_url = p_args->>'videoUrl';
$$;

-- All query values are SQL parameters. No interpolated SQL/PostgREST filters.
-- Match words across all saved fields, exact normalized channel/tag criteria.
create function public.rs_page(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare rows jsonb; shown jsonb; last_row jsonb; page_size int := case when coalesce((p_args->>'export')::boolean, false) then 4 else 12 end;
begin
 select coalesce(jsonb_agg(d order by saved_at desc, video_url desc), '[]'::jsonb) into rows from (
  select i.saved_at, i.video_url, case when coalesce((p_args->>'export')::boolean, false) then i.data || jsonb_build_object('revision', i.revision)
   else (i.data - array['description','notes']) || jsonb_build_object('revision', i.revision, 'contentPartial', true, 'summary', left(i.data->>'summary',32768), 'summaryTruncated', coalesce((i.data->>'summaryTruncated')::boolean,false) or length(coalesce(i.data->>'summary','')) > 32768) end as d
  from public.rs_items i
  where i.user_id = p_user_id
   and (p_args->'cursor' is null or p_args->'cursor' = 'null'::jsonb or (i.saved_at, i.video_url) < ((p_args->'cursor'->>0)::bigint, p_args->'cursor'->>1))
   and (coalesce((p_args->>'export')::boolean, false) or (
    i.data->>'status' <> 'deleted'
    and (case coalesce(p_args->>'filter', 'watch')
     when 'all' then true
     when 'watch' then i.data->>'status' <> 'missing' and coalesce(i.data->>'location', '') not in ('archive', 'feed')
     else i.data->>'status' = 'saved' and i.data->>'location' = p_args->>'filter' end)
    and (coalesce(p_args->>'channel', '') = '' or public.rs_normalize(i.data->>'author') = p_args->>'channel')
    and (coalesce(p_args->>'tag', '') = '' or exists (select 1 from jsonb_array_elements_text(coalesce(i.data->'tags', '[]'::jsonb)) t where public.rs_normalize(t) = p_args->>'tag'))
    and not exists (
     select 1 from jsonb_array_elements_text(coalesce(p_args->'terms', '[]'::jsonb)) term
     where position(term in public.rs_normalize(concat_ws(' ', i.data->>'title', i.data->>'author', i.data->>'description', i.data->>'notes', case when i.data->>'status' = 'saved' then i.data->>'summary' else '' end, i.data->>'tags'))) = 0
    )
   ))
  order by i.saved_at desc, i.video_url desc limit page_size + 1
 ) q;
 select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) into shown from jsonb_array_elements(rows) with ordinality q(value, ord) where ord <= page_size;
 last_row := shown->(jsonb_array_length(shown)-1);
 return jsonb_build_object('items', shown, 'hasNext', jsonb_array_length(rows) > page_size, 'nextCursor', case when jsonb_array_length(rows) > page_size then jsonb_build_array(last_row->'savedAt', last_row->'videoUrl') else null end);
end;
$$;

create function public.rs_import(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare item jsonb; old public.rs_items; merged jsonb; accepted jsonb := '[]'::jsonb; incoming bigint; fresh_save boolean;
begin
 if jsonb_typeof(p_args->'items') <> 'array' or jsonb_array_length(p_args->'items') > 25 then raise exception 'invalid import'; end if;
 for item in select value from jsonb_array_elements(p_args->'items') loop
  -- API validates individual fields. SQL bounds batch size and canonical keys too.
  incoming := (item->>'updatedAt')::bigint;
  insert into public.rs_items(user_id, video_url, saved_at, data, local_updated_at)
   values (p_user_id, item->>'videoUrl', (item->>'savedAt')::bigint, item - 'updatedAt' || jsonb_build_object('description', coalesce(item->>'description', ''), 'notes', coalesce(item->>'notes', '')), incoming)
   on conflict do nothing;
  select * into old from public.rs_items where user_id = p_user_id and video_url = item->>'videoUrl' for update;
  merged := old.data;
  -- Only a genuinely new Reader identity saved after cloud deletion can restore
  -- a tombstone. A queued migration of the old ID never resurrects it.
  fresh_save := item->>'status' = 'saved' and coalesce(item->>'readerId','') ~ '^[A-Za-z0-9_-]{1,100}$' and item->>'readerId' is distinct from old.data->>'readerId' and (item->>'savedAt')::bigint > case when old.data->>'status' = 'deleted' then greatest(old.cloud_updated_at,old.saved_at,coalesce((old.data->>'checkedAt')::bigint,0)) else old.saved_at end;
  if fresh_save or (incoming > old.local_updated_at and old.data->>'status' <> 'deleted' and (item->>'checkedAt')::bigint >= coalesce((old.data->>'checkedAt')::bigint, 0)) then
   merged := old.data || (item - array['updatedAt', 'description', 'notes', 'summary', 'summaryCheckedAt', 'summaryTruncated']);
   merged := merged || jsonb_build_object('firstSavedAt', least((old.data->>'firstSavedAt')::bigint, (item->>'firstSavedAt')::bigint), 'savedAt', greatest(old.saved_at,(item->>'savedAt')::bigint));
   if coalesce((item->>'durationIsLive')::boolean,false) then merged := merged || jsonb_build_object('durationSeconds',null,'durationIsLive',true);
   elsif item->>'durationSeconds' is null then merged := merged || jsonb_build_object('durationSeconds',old.data->'durationSeconds','durationIsLive',coalesce(old.data->'durationIsLive','false'::jsonb)); end if;
   if fresh_save then merged := merged || jsonb_build_object('summary',item->'summary','summaryCheckedAt',item->'summaryCheckedAt','summaryTruncated',item->'summaryTruncated'); end if;
  end if;
  if merged->>'status' = 'saved' and item->>'readerId' = merged->>'readerId' and jsonb_typeof(item->'summary') = 'string'
    and (item->>'summaryCheckedAt')::bigint > coalesce((old.data->>'summaryCheckedAt')::bigint, 0) then
   merged := merged || jsonb_build_object('summary', item->'summary', 'summaryCheckedAt', item->'summaryCheckedAt', 'summaryTruncated', item->'summaryTruncated');
  end if;
  if not old.content_edited and coalesce(merged->>'description','') = '' and coalesce(item->>'description','') <> '' then
   merged := merged || jsonb_build_object('description',item->>'description');
  end if;
  if merged is distinct from old.data then
   update public.rs_items set data = merged, saved_at = (merged->>'savedAt')::bigint, revision = revision + 1, local_updated_at = greatest(local_updated_at, incoming) where user_id = p_user_id and video_url = item->>'videoUrl';
  else
   update public.rs_items set local_updated_at = greatest(local_updated_at, incoming) where user_id = p_user_id and video_url = item->>'videoUrl';
  end if;
  accepted := accepted || jsonb_build_array(item->>'videoUrl');
 end loop;
 return accepted;
end;
$$;

create function public.rs_edit(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare row public.rs_items;
begin
 select * into row from public.rs_items where user_id = p_user_id and video_url = p_args->>'videoUrl' for update;
 if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
 if row.revision <> (p_args->>'revision')::bigint then return jsonb_build_object('ok', false, 'code', 'document_changed', 'item', row.data || jsonb_build_object('revision', row.revision)); end if;
 update public.rs_items set data = data || jsonb_build_object('description', p_args->>'description', 'notes', p_args->>'notes'), revision = revision + 1, content_edited = true, cloud_updated_at = floor(extract(epoch from clock_timestamp())*1000)::bigint
  where user_id = p_user_id and video_url = p_args->>'videoUrl';
 return jsonb_build_object('ok', true, 'item', public.rs_item(p_user_id, p_args));
end;
$$;
create function public.rs_verify(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare doc jsonb := p_args->'doc'; at bigint := (p_args->>'now')::bigint; result jsonb;
begin
 -- Description/personal note belong to the website. Reader notes are deliberately
 -- excluded; they are read fresh solely for destructive-action conflict checks.
 update public.rs_items set data = data || jsonb_build_object('readerId', doc->>'id', 'title', case when coalesce(doc->>'title','') = '' then data->>'title' else doc->>'title' end, 'author', case when coalesce(doc->>'author','') = '' then data->>'author' else doc->>'author' end, 'location', doc->>'location', 'tags', case when doc->'tags' is null or doc->'tags' = 'null'::jsonb then data->'tags' else doc->'tags' end, 'summary', doc->>'summary', 'summaryTruncated', doc->'summaryTruncated', 'summaryCheckedAt', at, 'checkedAt', at, 'status', 'saved'), revision = revision + 1, cloud_updated_at = at
 where user_id = p_user_id and video_url = doc->>'videoUrl' and data->>'readerId' = doc->>'id' and data->>'status' <> 'deleted'
 returning data || jsonb_build_object('revision', revision) into result;
 return result;
end;
$$;
create function public.rs_mark(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
begin
 if p_args->>'status' not in ('deleted', 'missing') then raise exception 'invalid status'; end if;
 update public.rs_items set data = data || jsonb_build_object('status', p_args->>'status', 'checkedAt', (p_args->>'now')::bigint), cloud_updated_at = (p_args->>'now')::bigint, revision = revision + 1
 where user_id = p_user_id and video_url = p_args->>'videoUrl' and data->>'readerId' = p_args->>'id' and not (data->>'status' = 'deleted' and p_args->>'status' = 'missing');
 return '{}'::jsonb;
end;
$$;

create function public.rs_device(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
begin
 if p_args->>'action' = 'create' then
  delete from public.rs_devices where user_id = p_user_id and expires_at <= now();
  insert into public.rs_devices(user_id, token_hash) values (p_user_id, p_args->>'hash');
  return '{"ok":true}'::jsonb;
 elsif p_args->>'action' = 'revoke' then
  delete from public.rs_devices where user_id = p_user_id;
  return '{"ok":true}'::jsonb;
 elsif p_args->>'action' = 'get' then
  return jsonb_build_object('valid', exists(select 1 from public.rs_devices where user_id = p_user_id and token_hash = p_args->>'hash' and expires_at > now()));
 end if;
 raise exception 'invalid action';
end;
$$;
create function public.rs_ticket(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb;
begin
 if p_args->>'action' = 'create' then
  delete from public.rs_tickets where user_id = p_user_id and expires_at <= now();
  insert into public.rs_tickets(token_hash, user_id, snapshot) values (p_args->>'hash', p_user_id, p_args->'snapshot');
  return '{"ok":true}'::jsonb;
 elsif p_args->>'action' = 'take' then
  delete from public.rs_tickets where user_id = p_user_id and token_hash = p_args->>'hash' and expires_at > now() returning snapshot into result;
  return result;
 end if;
 raise exception 'invalid action';
end;
$$;

-- Locking one owner budget makes quotas/cooldowns survive concurrency and restarts.
-- Reserve the complete operation before its first network request, including
-- readback capacity; a confirmation dialog itself reserves no future quota.
create function public.rs_rate(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare budget jsonb; at bigint := floor(extract(epoch from clock_timestamp())*1000)::bigint; group_name text; times jsonb; needs int; maximum int; retry_at bigint := 0; earliest bigint;
begin
 insert into public.rs_budgets(user_id) values (p_user_id) on conflict do nothing;
 select data into budget from public.rs_budgets where user_id = p_user_id for update;
 if p_args->>'action' = 'block' then
  update public.rs_budgets set data = budget || jsonb_build_object('blockedUntil', greatest(coalesce((budget->>'blockedUntil')::bigint, 0), (p_args->>'until')::bigint)) where user_id = p_user_id;
  return '{"ok":true}'::jsonb;
 end if;
 if p_args->>'action' <> 'reserve' then raise exception 'invalid action'; end if;
 if coalesce((budget->>'blockedUntil')::bigint, 0) > at then return jsonb_build_object('ok', false, 'source', 'reader', 'retryAt', budget->'blockedUntil'); end if;
 foreach group_name in array array['list','update','delete'] loop
  select coalesce(jsonb_agg(value order by value::bigint), '[]'::jsonb), min(value::bigint) into times, earliest from jsonb_array_elements_text(coalesce(budget->group_name, '[]'::jsonb)) where value::bigint > at - 60000;
  budget := jsonb_set(budget, array[group_name], times);
  needs := coalesce((p_args->'needs'->>group_name)::int, 0); maximum := case when group_name = 'update' then 45 else 18 end;
  if needs < 0 or needs > maximum then raise exception 'invalid budget'; end if;
  if jsonb_array_length(times) + needs > maximum then retry_at := greatest(retry_at, coalesce(earliest, at) + 60000); end if;
 end loop;
 if retry_at > 0 then return jsonb_build_object('ok', false, 'source', 'local', 'retryAt', retry_at); end if;
 foreach group_name in array array['list','update','delete'] loop
  needs := coalesce((p_args->'needs'->>group_name)::int, 0);
  for n in 1..needs loop budget := jsonb_set(budget, array[group_name], (budget->group_name) || jsonb_build_array(at)); end loop;
 end loop;
 update public.rs_budgets set data = budget where user_id = p_user_id;
 return '{"ok":true}'::jsonb;
end;
$$;

create function public.rs_settings(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb;
begin
 insert into public.rs_settings(user_id) values (p_user_id) on conflict do nothing;
 if p_args->>'action' = 'set' then
  if p_args->>'theme' not in ('system','light','dark') or (p_args->>'timerDefault')::int not between 1 and 180 then raise exception 'invalid settings'; end if;
  update public.rs_settings set data = data || jsonb_build_object('theme', p_args->>'theme', 'timerDefault', (p_args->>'timerDefault')::int) where user_id = p_user_id;
 end if;
 select data - 'timer' into result from public.rs_settings where user_id = p_user_id;
 return result;
end;
$$;
create function public.rs_timer(p_user_id uuid, p_args jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare settings jsonb; previous jsonb; state jsonb; action text := p_args->>'action'; at bigint := (p_args->>'now')::bigint; idle jsonb := '{"phase":"idle","id":null,"revision":0,"durationMinutes":15,"remainingMs":0,"deadline":null,"dismissed":false}'::jsonb;
begin
 insert into public.rs_settings(user_id) values (p_user_id) on conflict do nothing;
 select data into settings from public.rs_settings where user_id = p_user_id for update;
 previous := coalesce(settings->'timer', idle); state := previous;
 if state->>'phase' = 'running' and (state->>'deadline')::bigint <= at then state := state || '{"phase":"expired","remainingMs":0}'::jsonb; end if;
 if action = 'start' and state->>'phase' not in ('running','paused') then
  if (p_args->>'revision')::bigint <> (previous->>'revision')::bigint then return jsonb_build_object('ok',false,'code','timer_changed','state',state,'defaultMinutes',settings->'timerDefault'); end if;
  state := idle || jsonb_build_object('phase','running','id',p_args->>'newId','durationMinutes',(p_args->>'minutes')::int,'deadline',at+(p_args->>'minutes')::bigint*60000);
 elsif action in ('pause','resume','reset','dismiss') and p_args->>'id' = state->>'id' then
  if (p_args->>'revision')::bigint <> (previous->>'revision')::bigint then return jsonb_build_object('ok',false,'code','timer_changed','state',state,'defaultMinutes',settings->'timerDefault'); end if;
  if action = 'pause' and state->>'phase' = 'running' then state := state || jsonb_build_object('phase','paused','remainingMs',greatest(0,(state->>'deadline')::bigint-at),'deadline',null);
  elsif action = 'resume' and state->>'phase' = 'paused' then state := state || jsonb_build_object('phase','running','deadline',at+(state->>'remainingMs')::bigint,'remainingMs',0);
  elsif action = 'reset' then state := idle || jsonb_build_object('durationMinutes',state->'durationMinutes');
  elsif action = 'dismiss' and state->>'phase' = 'expired' then state := state || '{"dismissed":true}'::jsonb;
  end if;
 end if;
 if state is distinct from previous then
  state := state || jsonb_build_object('revision',(previous->>'revision')::bigint+1);
  update public.rs_settings set data = jsonb_set(data,'{timer}',state) where user_id = p_user_id;
 end if;
 return jsonb_build_object('ok',true,'state',state,'defaultMinutes',settings->'timerDefault');
end;
$$;

-- Service-only functions deliberately use invoker rights, not SECURITY DEFINER.
-- Revoke PostgreSQL's default PUBLIC execute privilege for every app function.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname like 'rs\_%' escape '\' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
