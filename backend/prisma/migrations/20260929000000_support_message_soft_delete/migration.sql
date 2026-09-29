-- Support Audit — message deletion. Two new nullable columns on the
-- existing SupportMessage table (soft delete: mirrors editedAt's own
-- nullable-timestamp shape, added by the original support migration). No
-- existing column, row, constraint, or enum value is altered or dropped, no
-- table is dropped, and SupportMessage already has its GRANT from its
-- original migration, so no new GRANT is needed here (same reasoning as the
-- auto-greeting/notification-email migrations immediately before this one).

-- AlterTable
ALTER TABLE "SupportMessage" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByAdminId" TEXT;

-- CreateIndex
CREATE INDEX "SupportMessage_deletedAt_idx" ON "SupportMessage"("deletedAt");
