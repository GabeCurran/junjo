-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "RolePermission" ADD COLUMN     "value" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "RoleParent" (
    "roleId" TEXT NOT NULL,
    "parentRoleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleParent_pkey" PRIMARY KEY ("roleId","parentRoleId"),
    -- Not modeled in Prisma; a backstop for the application-level cycle check.
    CONSTRAINT "RoleParent_not_self" CHECK ("roleId" <> "parentRoleId")
);

-- CreateIndex
CREATE INDEX "RoleParent_parentRoleId_idx" ON "RoleParent"("parentRoleId");

-- AddForeignKey
ALTER TABLE "RoleParent" ADD CONSTRAINT "RoleParent_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleParent" ADD CONSTRAINT "RoleParent_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
