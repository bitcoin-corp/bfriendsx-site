-- Verified handles: "this bWalletX identity proved it owns @handle on <network>".
-- Written only after the person signs in to that network (OAuth) while connected with bWalletX, and only when
-- they choose to be findable. Read by the family sites' servers to light up imported friends who are already
-- on b (bFriendsX, the bWalletX messenger). Closed to anon/authenticated; servers use the service key.
create table if not exists public.bx_handles (
  id            bigint generated always as identity primary key,
  identity_key  text        not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  network       text        not null check (network in ('x','instagram','tiktok','facebook','linkedin','youtube','telegram')),
  account_id    text        not null check (length(account_id) between 1 and 64),
  handle        text        check (handle is null or length(handle) between 1 and 64),
  verified_at   timestamptz not null default now(),
  constraint bx_handles_one_owner unique (network, account_id),       -- an account belongs to one wallet
  constraint bx_handles_one_per_wallet unique (identity_key, network) -- a wallet links one account per network
);
create index if not exists bx_handles_handle on public.bx_handles (network, lower(handle));
alter table public.bx_handles enable row level security;
revoke all on public.bx_handles from anon, authenticated;
