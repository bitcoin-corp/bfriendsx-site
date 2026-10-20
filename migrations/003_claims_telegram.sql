-- Telegram invites: allow 'telegram' as a claim network (bFriendsX now reads Telegram exports).
alter table public.bfriendsx_claims drop constraint if exists bfriendsx_claims_network_check;
alter table public.bfriendsx_claims add constraint bfriendsx_claims_network_check
  check (network in ('x','facebook','instagram','linkedin','tiktok','youtube','telegram'));
