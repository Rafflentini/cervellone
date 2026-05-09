-- Cervellone V19 — Memories storage bucket
-- Backend per Anthropic Memory API (memory_20250818).
-- Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 7

-- Crea bucket "memories" (privato, accessibile solo da service_role)
insert into storage.buckets (id, name, public)
values ('memories', 'memories', false)
on conflict (id) do nothing;

-- Policy: solo service_role può leggere/scrivere/eliminare
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'memories_service_role_full_access'
  ) then
    create policy "memories_service_role_full_access"
      on storage.objects
      for all
      using (bucket_id = 'memories' and auth.role() = 'service_role')
      with check (bucket_id = 'memories' and auth.role() = 'service_role');
  end if;
end
$$;
