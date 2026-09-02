-- Persist the most recent successful OTP verification timestamp so the
-- UI can render "Last verified X ago" without querying EmailChallenge.
ALTER TABLE "Channel" ADD COLUMN "credentialsVerifiedAt" TIMESTAMP(3);
