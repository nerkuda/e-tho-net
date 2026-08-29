-- session_layers: default change-layer of a client session (фаза S, задача S7;
-- docs/13-layers.md §7.1; docs/11-settings-and-state.md §1).
--
-- The session's current layer is remembered ON THE SERVER (13-layers.md §7.1),
-- not per request: hidden state is dangerous exactly because a restarted
-- client could silently write into the wrong layer. Every mutating response
-- therefore echoes the layer (`meta.layer` / `X-Etn-Layer`, task S7), and this
-- table is the echo's source of truth.
--
-- Scope of the "session" is (user_id, client_id, network_id) — the same
-- coordinates WebSocket connections use (11-settings-and-state.md §1.2).
-- `client_id` is the `Client-Id` header value, or '' when the caller (an
-- agent, a script) sent none. The table is NOT branchable (13-layers.md §3):
-- it is personal client state, not network content — same family as
-- user_focus_preferences.
--
-- No FK on layer_id: deleting a layer re-points every affected session to the
-- deleted layer's parent (13-layers.md §2.4) BEFORE the row goes away, in the
-- same transaction; a leftover dangling reference (cannot happen through the
-- API) degrades to the base layer at read time anyway.

CREATE TABLE session_layers (
  user_id    TEXT NOT NULL,
  client_id  TEXT NOT NULL DEFAULT '',      -- '' = запрос без Client-Id
  layer_id   TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
