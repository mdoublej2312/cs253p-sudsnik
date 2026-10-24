
create trigger holds_live_needs_washer_insert before insert on holds
  when new.state = 'held' and new.live_washer_id is null
  begin select raise(abort, 'a held hold must carry live_washer_id'); end;

create trigger holds_live_needs_washer_update before update on holds
  when new.state = 'held' and new.live_washer_id is null
  begin select raise(abort, 'a held hold must carry live_washer_id'); end;