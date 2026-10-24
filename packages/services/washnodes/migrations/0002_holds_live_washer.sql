
alter table holds add column live_washer_id text;
create unique index holds_live_washer on holds (live_washer_id);