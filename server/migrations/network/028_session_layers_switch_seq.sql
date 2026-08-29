-- session_layers.switched_at_seq: real-time seq at the moment a session's
-- current layer last changed (фаза S, задача S9; docs/13-layers.md §12;
-- docs/04-realtime.md §11).
--
-- `last_seq` (WebSocket `resume`) and `since_seq` (`etn.changes.list`) are
-- global per network — filtering by layer happens per event at delivery time,
-- not by a layer-scoped sequence. A client that switched layers therefore
-- cannot safely resume a delta from before the switch: its local cache was
-- built from events filtered for the OLD layer, and a delta computed for the
-- NEW layer assumes a baseline that never existed client-side (13-layers.md
-- §12 "переключение слоя — полный ресинк"). `switched_at_seq` records the
-- network's `max_seq` at the moment of the switch (or of a layer-delete
-- cascade re-pointing the session, §2.4); the gateway's `resume` handler and
-- `etn.changes.list` force `truncated: true` whenever the caller's position
-- predates it, exactly like the retained-window check.
--
-- 0 (the default) means "never switched" — a fresh session on the base layer
-- needs no forced resync.

ALTER TABLE session_layers ADD COLUMN switched_at_seq INTEGER NOT NULL DEFAULT 0;
