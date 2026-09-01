-- Enforce globally-unique display names across all Channel rows so no
-- two inboxes can share a label regardless of channel type.
CREATE UNIQUE INDEX "Channel_displayName_key" ON "Channel"("displayName");
