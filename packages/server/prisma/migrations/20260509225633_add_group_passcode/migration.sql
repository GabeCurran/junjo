-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "passcodeHash" TEXT,
ADD COLUMN     "passcodeSetAt" TIMESTAMP(3);
