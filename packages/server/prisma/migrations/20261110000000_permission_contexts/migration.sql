-- Contexts on permission entries. Existing rows backfill to the global
-- context (contextKey = '') through the column default, and each primary
-- key is dropped and re-added in the same statement to include it.

-- AlterTable
ALTER TABLE "MemberPermissionOverride" DROP CONSTRAINT "MemberPermissionOverride_pkey",
ADD COLUMN     "context" JSONB,
ADD COLUMN     "contextKey" TEXT NOT NULL DEFAULT '',
ADD CONSTRAINT "MemberPermissionOverride_pkey" PRIMARY KEY ("groupMemberId", "permissionKey", "contextKey");

-- AlterTable
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_pkey",
ADD COLUMN     "context" JSONB,
ADD COLUMN     "contextKey" TEXT NOT NULL DEFAULT '',
ADD CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionKey", "contextKey");

