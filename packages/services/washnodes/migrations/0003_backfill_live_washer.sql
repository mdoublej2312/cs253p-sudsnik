
update holds
  set state = 'expired', version = version + 1, ended_at = expires_at,
      reason = 'migration: duplicate live hold on one washer'
  where state = 'held'
    and washer_id in (select washer_id from holds where state = 'held' group by washer_id having count(*) > 1)
    and hold_id is not (select w.hold_id from washers w where w.washer_id = holds.washer_id);

update holds set live_washer_id = washer_id where state = 'held' and live_washer_id is null;