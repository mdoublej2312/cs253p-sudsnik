-- Money is written once and never edited: a wrong row is fixed by another row.
create trigger ledger_no_update before update on ledger
begin select raise(abort, 'ledger is append-only'); end;

create trigger ledger_no_delete before delete on ledger
begin select raise(abort, 'ledger is append-only'); end;

-- Second line of defence behind the webhook dedupe: one movement of each kind per order.
create unique index ledger_one_movement on ledger (tenant_id, order_id, kind)
  where kind in ('authorize', 'capture', 'refund');