# Database foundation

PostgreSQL is the readable admin database for the radio project and the
foundation for the future paid Telegram question flow. The live broadcast
continues to run from the current runtime, while the database stores a clean
history of what was on air and important admin/system actions.

## Docker service

`docker-compose.yml` starts `postgres` with:

- database: `POSTGRES_DB` (`radio` by default);
- user: `POSTGRES_USER` (`radio` by default);
- password: `POSTGRES_PASSWORD`;
- persistent volume: `radio-postgres`;
- init scripts: `database/init/*.sql`.

The init scripts run only when the Postgres data volume is created for the
first time. If the volume already exists, schema changes must be applied with a
proper migration command later.

## Initial tables

- `telegram_users` - Telegram listeners and admins.
- `payment_orders` - payable orders before and after Telegram Stars, TON, or
  USDT confirmation.
- `payments` - immutable payment confirmations from the provider.
- `listener_questions` - paid or free listener questions and their lifecycle.
- `audio_assets` - generated mp3 files and their metadata.
- `broadcast_jobs` - future durable queue for voice, music, topic, and listener
  jobs.
- `broadcast_events` - compatibility table for old technical broadcast events.
  New routine broadcast events are intentionally kept in JSONL logs instead of
  this table.
- `broadcast_air_items` - clean human-readable on-air timeline. Use this table
  for admin views, reports, and "what was on air" queries.
- `ai_usage_events` - DeepSeek and ElevenLabs usage accounting.
- `system_events` - audit trail for admin, bot, listener, and important system
  actions. Routine broadcast events are intentionally not stored here.

## Broadcast event relationships

Technical broadcast steps such as voice queueing, prelude, audio start, and
segment end are stored in JSONL logs under `/cache/logs`. They are not written
as separate database rows, because the database is reserved for readable admin
history.

`broadcast_air_items` is the main table for "what was on air". It stores clean
interval rows: music tracks, host voice blocks, listener questions, and system
air items.

Optional links are already reserved:

- `listener_question_id` -> `listener_questions.id` for paid listener
  questions.
- `audio_asset_id` -> `audio_assets.id` for generated mp3 files.
- `broadcast_job_id` -> `broadcast_jobs.id` for the future durable queue.

For now, these optional IDs are usually empty because the current broadcast
runtime still uses in-memory queues and JSON files. They are reserved for the
paid-question and durable-queue migration.

Paid Telegram questions are now written into the readable database as well as
the runtime JSON store:

- `listener_questions.external_question_id` stores the runtime question id;
- `payment_orders.provider_payload` stores the invoice payload
  `question:<external_question_id>`;
- `payments.provider_charge_id` stores Telegram's successful payment charge id.

Useful query:

```sql
select started_at, ended_at, item_type, status, title, source_file
from broadcast_air_items
order by started_at desc
limit 100;
```

## Recommended next tables

Add these only when the corresponding feature is implemented:

- `tariffs` - editable prices for questions, urgent questions, and packages.
- `user_balances` - internal prepaid balance if you later sell bundles.
- `refunds` - explicit refund lifecycle for Telegram Stars and crypto payments.
- `moderation_rules` - blocked words, blocked users, and question filters.
- `topic_audio_cache` - normalized cache for topic/subtopic/host combinations
  if the JSON archive becomes too limiting.
- `admin_sessions` - database-backed admin sessions if the current cookie store
  needs to survive restarts across multiple app containers.
