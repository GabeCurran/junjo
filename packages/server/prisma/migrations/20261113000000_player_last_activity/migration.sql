-- AlterTable
ALTER TABLE "ExternalIdentity" ADD COLUMN     "lastActivityAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "LastActivityCursor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "auditId" TEXT NOT NULL,

    CONSTRAINT "LastActivityCursor_pkey" PRIMARY KEY ("id")
);

-- "ExternalIdentity"."lastActivityAt" is the newest "AuditEntry" in the
-- identity's game that targets the identity's external id or names the
-- identity's person as actor. "AuditEntry"."createdAt" is stored as UTC
-- without a zone, so it is read AT TIME ZONE 'UTC'.

-- A new identity starts from the entries already in its game that target
-- its external id or name its person as actor. It only reads.
CREATE FUNCTION "ExternalIdentity_initial_activity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."lastActivityAt" := GREATEST(
    NEW."lastActivityAt",
    (SELECT a."createdAt" FROM "AuditEntry" a
      WHERE a."gameId" = NEW."gameId" AND a."targetId" = NEW."externalUserId"
      ORDER BY a."createdAt" DESC
      LIMIT 1) AT TIME ZONE 'UTC',
    (SELECT a."createdAt" FROM "AuditEntry" a
      WHERE a."actorUserId" = NEW."junjoUserId" AND a."gameId" = NEW."gameId"
      ORDER BY a."createdAt" DESC
      LIMIT 1) AT TIME ZONE 'UTC'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ExternalIdentity_initial_activity"
BEFORE INSERT ON "ExternalIdentity"
FOR EACH ROW
EXECUTE FUNCTION "ExternalIdentity_initial_activity"();

-- The catch-up job applies entries after this position. It is taken
-- before the backfill, so an entry committed between the two is applied
-- by both, which is harmless because both only raise values; with no
-- entries it starts at the Unix epoch, before every entry.
INSERT INTO "LastActivityCursor" ("id", "createdAt", "auditId")
SELECT 'lastActivity', coalesce(max(e."createdAt"), '1970-01-01'), coalesce(max(e.id), '')
FROM (
  SELECT "createdAt", id FROM "AuditEntry"
  ORDER BY "createdAt" DESC, id DESC
  LIMIT 1
) e;

-- Backfill.
UPDATE "ExternalIdentity" i
SET "lastActivityAt" = GREATEST(COALESCE(i."lastActivityAt", '-infinity'), v.at)
FROM (
  SELECT e.id, GREATEST(t.at, a.at) AT TIME ZONE 'UTC' AS at
  FROM "ExternalIdentity" e
  LEFT JOIN (
    SELECT "gameId", "targetId", max("createdAt") AS at
    FROM "AuditEntry"
    WHERE "targetId" IS NOT NULL
    GROUP BY "gameId", "targetId"
  ) t ON t."gameId" = e."gameId" AND t."targetId" = e."externalUserId"
  LEFT JOIN (
    SELECT "gameId", "actorUserId", max("createdAt") AS at
    FROM "AuditEntry"
    WHERE "actorUserId" IS NOT NULL
    GROUP BY "gameId", "actorUserId"
  ) a ON a."gameId" = e."gameId" AND a."actorUserId" = e."junjoUserId"
) v
WHERE v.id = i.id AND v.at IS NOT NULL;
