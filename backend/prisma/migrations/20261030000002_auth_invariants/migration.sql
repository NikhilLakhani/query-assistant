ALTER TABLE "Session" ADD CONSTRAINT "Session_csrf_hash"
  CHECK ("csrfTokenHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "Session" ADD CONSTRAINT "Session_valid_expiry"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_username_normalized"
  CHECK ("username" ~ '^[a-z0-9_]{3,32}$');
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_activation_state"
  CHECK (("status" = 'approved' AND "activationCodeHash" IS NOT NULL
      AND "activationCodeHash" ~ '^[a-f0-9]{64}$' AND "activationExpiresAt" IS NOT NULL)
    OR ("status" <> 'approved' AND "activationCodeHash" IS NULL AND "activationExpiresAt" IS NULL));
