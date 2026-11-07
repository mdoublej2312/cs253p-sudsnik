# Runbook: relay_delivery_degraded / relay_callback_refused (dispatch)

## 1. What you saw

An alert from dispatch:

- `relay_delivery_degraded`: more than 15% of relay callbacks in the last 10 minutes were repeats.
- `relay_callback_refused`: a callback failed its checksum and was set aside.

The relay is misbehaving. The question is whether orders are still moving.

## 2. What to check, in order

**a. Are orders still progressing?** This is the symptom that matters.

```sh
sqlite3 data/dispatch.sqlite "select state, count(*) from orders group by state"
```

Run it twice, a few minutes apart. Counts should shift toward `returned`.

**b. Which callbacks were refused, and why?**

```sh
sqlite3 data/dispatch.sqlite "select reason, count(*) from rejected_callbacks group by reason"
```

**c. Is anything in the dead-letter store?**

```sh
sqlite3 data/bus.sqlite "select consumer, topic, last_error from dead_letters"
```

**d. How bad is the relay right now?** Compare sent vs received:

```sh
sqlite3 data/mocks/relay.sqlite "select count(*) from deliveries where dest_id='dispatch'"
grep '"scope":"dispatch"' results/<run>/otel/trace.jsonl | grep -c 'POST /callbacks/relay'
```

## 3. What to do

- **Only duplicates or reordering, orders moving:** nothing. The ingest absorbs both. Note the time and keep watching (a).
- **Refused callbacks (checksum):** the relay retries a refused forward for 5 minutes, so a clean copy usually follows. If that order has not progressed after a full orbit, find it from the `rejected_callbacks` row and escalate it for reconciliation.
- **Dead letters with a quota error:** the provider quota resets at the orbit boundary. Wait one orbit, then confirm the backlog drains.

## 4. What NOT to do

- **Do not clear the `relay_callbacks` table or restart dispatch on an empty data directory.** Every repeat would then look new, and pods would be held and washed twice.
- **Do not replay bodies from `rejected_callbacks` into `/callbacks/relay`.** Their checksums are wrong because their contents may be wrong.
- **Do not switch back to the naive variant or turn off checksum checking** to "unstick" things. That is exactly how orders got stuck the first time.
- **Do not raise the threshold in the middle of an incident** to make the alert stop. Fix the threshold afterwards, with numbers.
- **Do not kill dispatch mid-ingest.** Stop it gracefully so in-flight callbacks finish.
