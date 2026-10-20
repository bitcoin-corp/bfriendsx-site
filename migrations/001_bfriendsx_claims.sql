-- bFriendsX: who accepted whose invite. One row per claimed invite.
-- Invites themselves aren't stored (they're sealed into the link); a row appears only when the friend
-- connects bWalletX on /i/<token>. Names are what the inviter's export called them, and only the
-- inviter and invitee should see them, so the table is closed to anon/authenticated (RLS on, no policies);
-- the bfriendsx API reads and writes it server-side.
create table if not exists public.bfriendsx_claims (
  id            bigint generated always as identity primary key,
  inviter_key   text        not null check (inviter_key ~ '^0[23][0-9a-f]{64}$'),
  invitee_key   text        not null check (invitee_key ~ '^0[23][0-9a-f]{64}$'),
  network       text        not null check (network in ('x','facebook','instagram','linkedin','tiktok','youtube')),
  name          text        not null check (length(name) between 1 and 80),
  invited_at    timestamptz not null,
  claimed_at    timestamptz not null default now(),
  constraint bfriendsx_claims_not_self check (inviter_key <> invitee_key),
  constraint bfriendsx_claims_once unique (inviter_key, invitee_key, network)
);
create index if not exists bfriendsx_claims_inviter on public.bfriendsx_claims (inviter_key, claimed_at desc);
create index if not exists bfriendsx_claims_invitee on public.bfriendsx_claims (invitee_key);
alter table public.bfriendsx_claims enable row level security;
revoke all on public.bfriendsx_claims from anon, authenticated;
