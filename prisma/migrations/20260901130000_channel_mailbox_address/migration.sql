-- Non-secret display copy of the connected mailbox address, populated
-- on setCredentials for EMAIL channels. Lets the UI render a "Connected
-- as X" summary without decrypting `credentialsEncrypted`.
ALTER TABLE "Channel" ADD COLUMN "mailboxAddress" TEXT;
