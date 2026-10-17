-- One charge per (tenant, order): its current state. Overwritten as it moves; the ledger keeps the history.
create table charges (
  charge_id text primary key,
  tenant_id text not null,
  order_id text not null,
  amount integer not null check (amount >= 0),
  base integer not null,
  currency text not null check (length(currency) = 3),
  state text not null check (state in ('authorized', 'captured', 'failed', 'refunded')),
  payment_ref text,
  updated_at integer not null,
  unique (tenant_id, order_id)
);
create index charges_payment_ref on charges (payment_ref);

-- Append-only: rows are inserted and never updated or deleted. A refund is a new row.
create table ledger (
  entry_id text primary key,
  tenant_id text not null,
  order_id text not null,
  kind text not null check (kind in ('authorize', 'capture', 'refund', 'fee')),
  amount integer not null,
  currency text not null,
  at integer not null,
  ref text
);
create index ledger_tenant_order on ledger (tenant_id, order_id, at);

-- What the washer actually used, from wash.completed; capture prices it.
create table wash_units (
  order_id text primary key,
  cycle_units integer not null
);

-- Pricing tier per operator, from operator.updated.
create table operators (
  operator_id text primary key,
  pricing_tier text not null
);

-- Payments webhooks already applied, by their id: a redelivery is answered as a duplicate.
create table webhooks (
  id text primary key
);
