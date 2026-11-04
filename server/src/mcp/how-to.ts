/**
 * Общие тексты пошаговых инструкций `etn.how_to_*` (0.9.1, ошибка
 * e05d4688-8180-41c6-bcd9-733d088c8981).
 *
 * Текст «как делать батч-запись» нужен в двух местах: как MCP-промпт
 * `etn.how_to_write_batch` (prompts.ts) и как тема справочника
 * `etn.guide { topic: "how_to_write_batch" }` (tools/ops-catalog.ts). Держим
 * его в одном модуле без зависимостей, чтобы описания инструмента, промпта и
 * гайда не расходились и не дублировали текст.
 */

/** Пошаговая инструкция батч-записи `etn.thoughts.write` для сети `networkId`. */
export function writeBatchHowToText(networkId: string): string {
  return [
    `How to write a connected graph fragment in one transaction via \`etn.thoughts.write\` in network ${networkId}.`,
    ``,
    '1. Why: one call covers the scenarios of `etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`, `etn.comments.upsert` — those operations are replaced by the batch; it is their only replacement.',
    ``,
    '2. Top-level parameter: `thoughts[]` — an array of 1 to `MCP_MAX_THOUGHTS_PER_WRITE` (= 50, lives in `@etn/shared`). Exceeding it → `VALIDATION_ERROR` before the transaction. The contract is strict: any top-level key outside `network_id`/`local_refs`/`thoughts` (for example, `links` right in the call root) → `VALIDATION_ERROR` with `details.fields`, not a silent ignore. Item boundary: one `thoughts[]` item describes ONE thought in full — its identity (`thought`/`thought_id`), `comment`, `chronicle`, `properties`, `links`, `attachments` together in one item; parts of one thought cannot be spread across items (`VALIDATION_ERROR`) — links between batch thoughts are set by `links[].target_ref`, not by extra items. One write-budget slot for the WHOLE call, one `audit_log` row (`thought_count`/`link_count`/`item_count` in details), one transaction.',
    ``,
    '3. Local `ref`: each `thoughts[]` position either addresses an existing thought (`thought_id`) or describes a new one (`thought` with `title`/`synonyms`/`type`/`active`). Exactly one of the two (XOR) — otherwise `VALIDATION_ERROR`. An existing thought is edited with item-level `title`/`synonyms`/`type`/`type_id`/`active` right in the item (without a nested `thought`): `synonyms` REPLACE the whole set, `type`/`type_id` change the type. Item-level `title`/`synonyms`/`type`/`type_id` together with the `thought` block are rejected with `VALIDATION_ERROR` — for a new thought set them inside `thought`; item-level `active` is allowed with `thought` too and takes precedence over `thought.active`. If `thought` is given, declare `ref` at the `thoughts[]` item level, next to the `thought` block (not inside it: `{ "ref": "a", "thought": { "title": "…" } }`; `ref` inside `thought` is rejected with `VALIDATION_ERROR` and a hint); the name works ONLY inside the batch and must be unique (a repeat → `VALIDATION_ERROR`). At the `thought` stage the service first looks for duplicates (`find_duplicates`), but `on_duplicate` triggers ONLY on a blocking match — an exact (normalized) match of the new thought title with the title or a LITERAL synonym of an existing thought OF THE SAME type: `fail` (default, `details.candidates`), `reuse` (attaches the rest to the existing one), `update` (edits title/synonyms/type/active). A partial match, a wildcard synonym mask and an exact match with a foreign type do NOT block: the thought is created and the matches come back in `items[].duplicate_candidates` (`matched_on`/`type_id`/`parent_title`).',
    ``,
    "4. `comment` — the permanent one (create-or-update), `chronicle[]` — appended chronological entries (append-only, never overwritten). A `chronicle[]` item — `{ title?, body_md, valid_from, valid_to?, use_time? }`: `valid_from`/`valid_to` — a full UTC ISO-8601 instant or a bare date `YYYY-MM-DD` (= the UTC day); `valid_to` not set → equals `valid_from`; `use_time: true` — show the time in the client (does not affect the date format). WARNING: a chronological entry title is `chronicle[].title`; item-level `title` (point 3) RENAMES the thought itself — do not confuse them, otherwise a report text overwrites the task title (bug 8b329dc8). Editing an existing entry — `etn.comments.update`. `properties` — a `key → value` map; the key is a name from the network registry (`NOT_FOUND` if not registered). A link property is addressed by ANY name under which it is visible on the card: the canonical registry name or the display name of the binding side (`name_forward`/`name_reverse`); the value is a real thought id OR a `ref` declared in this same batch. `ref` is resolved to an id right after all batch thoughts are created (phase 2.5), before `links[]` are written (bug 93bc46bb), so a new fragment with link properties pointing at each other is written in one call. A scalar (text/number/…) whose value equals a `ref` name is NOT treated as a ref and is written as is. `attachments[]` — thought attachments: `url` (a link) or `file_path` (an OS path), or file data — `kind=\"file\"` + `mime_type` + `data_base64` (≤10 MiB decoded): the server stores a copy in the network attachment directory (next to the DB), and the row's `file_path` points at it (parity with REST `POST …/attachments/file`). `data_base64` is not combined with `url`/`file_path`/`description`.",
    ``,
    '5. Links — `links[]`: each link addresses its target either by `target_id` (an existing thought) or by `target_ref` (a ref inside this same batch). Exactly one of the two; an unknown `target_ref` → `VALIDATION_ERROR` BEFORE the write (visible in `details.known_refs`). `target_ref` resolution works for ANY batch item — both a thought-creating one (`thought`) and an existing-thought-editing one (`thought_id`); an unresolvable ref is an explicit error, not silence (bug 2a3be0f3). Cycles `A → B → A` are valid: in phase 2 all thoughts are already created, in phase 3 `target_ref`s are resolved to real ids (link property values — in phase 2.5, before that). `direction`: `parent` — the current thought is hung UNDER the target; `child` — the current thought becomes the parent of the target. `type` (a name) XOR `type_id`.',
    ``,
    "6. Knowledge can also be written on a link in the same transaction: `links[].properties` (link property map) and `links[].comment` (the link's permanent comment). A failure inside properties rolls back the whole transaction — no half-written graphs.",
    ``,
    '7. Activity: for every actually changed entity the server emits its own `thought.created`/`thought.updated`/`comment.created`/`comment.updated`/`link.created`/`attachment.created` through the same `emitAgentActivityEvent` as before — other network members see them in real time. `warnings` are aggregated across the whole batch; each item carries `ref` or `thought_id`.',
    ``,
    '8. Call template:',
    '   Network data — type, property and link-type names, thought titles — is not localized (ADR daab6ac4 §6). The example keeps the Russian names of the ETN network, so it stays copy-pasteable there; prose around the example is English.',
    `   \`\`\``,
    `   {`,
    `     "network_id": "${networkId}",`,
    `     "thoughts": [`,
    `       { "ref": "adr", "thought": { "title": "ADR-001", "type": "ADR", "active": true },`,
    `         "comment": { "body_md": "## Context\\n..." },`,
    `         "chronicle": [ { "body_md": "согласовано", "valid_from": "2026-09-06" } ],`,
    `         "properties": { "статус": "согласовано" },`,
    `         "links": [ { "direction": "child", "target_ref": "context",`,
    `                     "type": "применяется к", "comment": { "body_md": "..." } } ] },`,
    `       { "ref": "context", "thought": { "title": "Контекст" },`,
    `         "links": [ { "direction": "child", "target_ref": "adr" } ] }`,
    `     ]`,
    `   }`,
    `   \`\`\``,
    '   The `adr → context → adr` cycle through `target_ref` is valid: both thoughts are created in phase 2, both links in phase 3.',
    ``,
    '9. Migration from the old tools:',
    '- `etn.thoughts.create` → one `thought` item in `thoughts[]`.',
    '- `etn.thoughts.update` → `thought_id` + item-level `title`/`synonyms`/`type`/`type_id`/`active` (a nested `thought` — only for a NEW thought, XOR with `thought_id`). `active: false` on HOME → `VALIDATION_ERROR`.',
    '- `etn.thoughts.set_active` → `thought_id` + item-level `active: false` (not a nested `thought`).',
    '- `etn.thoughts.upsert_bundle` → a new bundle: `ref` + `thought`; editing an existing one: `thought_id` + item-level fields; `on_duplicate` behaves the same.',
    '- `etn.links.create` → one item with `links[0]`. Properties/comment on a link are now inline, not separate calls.',
    '- `etn.properties.set` → `properties` as a map in the required `thoughts[]` item (or `links[].properties` for link properties).',
    '- `etn.comments.upsert` (permanent) → `comment`; (chronological) → `chronicle[]`.',
  ].join('\n');
}
