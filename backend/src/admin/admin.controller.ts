import { Body, Controller, Get, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common'
import { IsString, MinLength } from 'class-validator'
import { AdminService } from './admin.service'
import { DepositsService } from '../deposits/deposits.service'
import { WithdrawalsService } from '../withdrawals/withdrawals.service'
import { KycService } from '../kyc/kyc.service'
import { ReconciliationService } from '../ledger/reconciliation.service'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { PermissionsGuard } from '../common/guards/permissions.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { RequirePermissions } from '../common/decorators/require-permissions.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../common/types/authenticated-user'
import { FinancialAdjustmentDto } from './dto/financial-adjustment.dto'
import { UpdateUserStatusDto } from './dto/update-user-status.dto'
import { UpdateAccountStatusDto } from './dto/update-account-status.dto'
import { UpdateUserRoleDto } from './dto/update-user-role.dto'
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto'
import { UpdateMarketConfigDto } from './dto/update-market-config.dto'
import { GrantPermissionDto } from './dto/grant-permission.dto'
import { GrantAllAdminPermissionsDto } from './dto/grant-all-admin-permissions.dto'
import { ApproveWithdrawalDto } from './dto/approve-withdrawal.dto'
import { CreateAdminDto } from './dto/create-admin.dto'
import { ResetAdminPasswordDto } from './dto/reset-admin-password.dto'
import type { PermissionKey } from '../common/permissions'

class ReasonDto {
  @IsString()
  @MinLength(3)
  reason!: string
}

class RevokePermissionDto {
  @IsString()
  @MinLength(3)
  reason!: string

  @IsString()
  confirmPassword!: string
}

/**
 * Every route requires an authenticated session AND an ADMIN or
 * SUPER_ADMIN role (RolesGuard) AND, per-route, a specific fine-grained
 * permission (PermissionsGuard, @RequirePermissions(...)) — SUPER_ADMIN
 * bypasses the permission check (full platform control); a fresh ADMIN has
 * NO permissions granted by default and sees 403 on everything until a
 * SUPER_ADMIN explicitly grants each one. Role changes and permission
 * grants are SUPER_ADMIN-only regardless of any permission grant — an
 * ADMIN can never escalate itself or anyone else.
 */
@Controller('admin')
@UseGuards(SessionAuthGuard, RolesGuard, PermissionsGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly depositsService: DepositsService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly kycService: KycService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  // Read-only (Phase 5, Part 8) — see ReconciliationService's header comment
  // for the hard rule that nothing here ever repairs a discrepancy
  // automatically. Reuses ledger.read rather than a new permission — this
  // is exactly the same trust level as viewing ledger transactions, just a
  // computed report instead of a raw list.
  @Get('reconciliation')
  @RequirePermissions('ledger.read')
  runReconciliation() {
    return this.reconciliationService.run()
  }

  // Phase 6F Checkpoint E — provider-vs-TRUST order reconciliation,
  // distinct from the internal-ledger-only check above. `trading.read`
  // (previously unused dormant permission, seeded since Phase 3) rather
  // than `ledger.read` — this inspects order/execution state specifically,
  // not raw ledger entries. POST (not GET) because it actively queries the
  // execution provider for every non-terminal order, not a cheap DB read.
  @Post('reconciliation/run')
  @RequirePermissions('trading.read')
  runOrderReconciliation(@CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.runOrderReconciliation(admin.id)
  }

  // Checkpoint I.1, Part 4 — same permission tier as the reconciliation run
  // above (read-only, no financial effect, no live provider query).
  @Get('orders/unresolved')
  @RequirePermissions('trading.read')
  listUnresolvedOrders() {
    return this.adminService.listUnresolvedOrders()
  }

  @Get('overview')
  @RequirePermissions('platform.read')
  getOverview() {
    return this.adminService.getOverview()
  }

  // Phase 6F Checkpoint F, Part 15 — same permission tier as the general
  // overview above (read-only, no financial effect); exposure/open-orders/
  // positions/violations, not covered by getOverview().
  @Get('risk/overview')
  @RequirePermissions('platform.read')
  getRiskOverview() {
    return this.adminService.getRiskOverview()
  }

  @Get('users')
  @RequirePermissions('users.read')
  listUsers(@Query('q') q?: string) {
    return this.adminService.listUsers(q)
  }

  @Get('users/:id')
  @RequirePermissions('users.read')
  getUserDetail(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.getUserDetail(id, admin.role)
  }

  @Patch('users/:id/status')
  @RequirePermissions('users.write')
  updateUserStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.updateUserStatus(id, dto, admin.id, admin.role)
  }

  // Phase 6F Checkpoint F, Part 14/15 — distinct from user status above;
  // see UpdateAccountStatusDto's comment. Same permission as user status
  // (both are "restrict this customer's ability to act," same severity).
  @Patch('accounts/:id/status')
  @RequirePermissions('users.write')
  updateAccountStatus(@Param('id') id: string, @Body() dto: UpdateAccountStatusDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.updateAccountStatus(id, dto, admin.id)
  }

  // SUPER_ADMIN only — an ADMIN cannot grant themselves or anyone else a
  // higher role, even with every permission granted. This is also how
  // "creating"/"deleting" an administrator works (promote/demote).
  @Patch('users/:id/role')
  @Roles('SUPER_ADMIN')
  updateUserRole(@Param('id') id: string, @Body() dto: UpdateUserRoleDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.updateUserRole(id, dto, admin.id)
  }

  @Post('financial-adjustment')
  @RequirePermissions('ledger.adjust')
  financialAdjustment(@Body() dto: FinancialAdjustmentDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.financialAdjustment(dto, admin.id)
  }

  @Get('deposits')
  @RequirePermissions('deposits.read')
  listDeposits(@Query('status') status?: string, @Query('userId') userId?: string) {
    return this.depositsService.listAll(status, userId)
  }

  @Post('deposits/:id/confirm')
  @RequirePermissions('deposits.review')
  confirmDeposit(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.depositsService.confirm(id, admin.id, dto.reason)
  }

  @Post('deposits/:id/reject')
  @RequirePermissions('deposits.review')
  rejectDeposit(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.depositsService.reject(id, admin.id, dto.reason)
  }

  // Checkpoint K, Part 27 — admin review of an uploaded crypto-deposit
  // proof. Same ownership-or-permission gate as the customer-facing route
  // (getProofFile's second argument marks this caller as privileged),
  // never a public URL.
  @Get('deposits/:id/proof')
  @RequirePermissions('deposits.read')
  async getDepositProof(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    const file = await this.depositsService.getProofFile(admin.id, true, id)
    return new StreamableFile(file.stream, { type: file.mimeType, disposition: `attachment; filename="${encodeURIComponent(file.filename)}"` })
  }

  @Get('withdrawals')
  @RequirePermissions('withdrawals.read')
  listWithdrawals(@Query('status') status?: string, @Query('userId') userId?: string) {
    return this.withdrawalsService.listAll(status, userId)
  }

  // Withdrawal approval is one of the explicitly listed step-up-required
  // actions — the acting admin's current password, not just the
  // withdrawals.review permission.
  @Post('withdrawals/:id/approve')
  @RequirePermissions('withdrawals.review')
  approveWithdrawal(@Param('id') id: string, @Body() dto: ApproveWithdrawalDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveWithdrawalWithStepUp(id, dto.confirmPassword, admin.id, dto.reason)
  }

  @Post('withdrawals/:id/reject')
  @RequirePermissions('withdrawals.review')
  rejectWithdrawal(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.withdrawalsService.reject(id, admin.id, dto.reason)
  }

  @Get('kyc/pending')
  @RequirePermissions('kyc.read')
  listPendingKyc() {
    return this.kycService.listPending()
  }

  // Full dashboard (Part 15) — every status, idNumber masked. Reuses
  // kyc.read, same trust tier as the pending list above.
  @Get('kyc/submissions')
  @RequirePermissions('kyc.read')
  listAllKyc() {
    return this.kycService.adminListAll()
  }

  @Get('kyc/submissions/:id')
  @RequirePermissions('kyc.read')
  getKycSubmission(@Param('id') id: string) {
    return this.kycService.adminGetSubmission(id)
  }

  // Streams the actual uploaded document (Part 12/16-18) — never a public
  // URL; ownership isn't relevant here (an admin isn't the document owner),
  // so this is gated purely by kyc.read + RolesGuard, matching the deposits
  // proof precedent's permission tier, and every view is audited.
  @Get('kyc/documents/:id')
  @RequirePermissions('kyc.read')
  async getKycDocument(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    const file = await this.kycService.adminGetDocumentFile(admin.id, id)
    return new StreamableFile(file.stream, { type: file.mimeType, disposition: `inline; filename="${encodeURIComponent(file.filename)}"` })
  }

  @Post('kyc/:id/approve')
  @RequirePermissions('kyc.review')
  approveKyc(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.kycService.approve(id, admin.id)
  }

  @Post('kyc/:id/reject')
  @RequirePermissions('kyc.review')
  rejectKyc(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.kycService.reject(id, admin.id, dto.reason)
  }

  // "Changing platform-wide trading controls" / "disabling security
  // controls" — both map to this one step-up-gated endpoint, the only
  // place platform-wide kill switches live.
  @Patch('platform-settings')
  @RequirePermissions('platform.control')
  updatePlatformSettings(@Body() dto: UpdatePlatformSettingsDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.updatePlatformSettings(dto, admin.id)
  }

  @Patch('markets/:symbol')
  @RequirePermissions('markets.control')
  updateMarketConfig(@Param('symbol') symbol: string, @Body() dto: UpdateMarketConfigDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.updateMarketConfig(decodeURIComponent(symbol), dto, admin.id)
  }

  @Get('audit-logs')
  @RequirePermissions('audit.read')
  listAuditLogs(@Query('limit') limit?: string) {
    return this.adminService.listAuditLogs(limit ? Number(limit) : undefined)
  }

  @Get('admins')
  @RequirePermissions('admins.read')
  listAdmins(@CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.listAdmins(admin.id)
  }

  // SUPER_ADMIN only + step-up — creating a new administrator account is the
  // same sensitivity tier as granting a permission or changing a role.
  @Post('admins')
  @Roles('SUPER_ADMIN')
  createAdmin(@Body() dto: CreateAdminDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.createAdmin(dto, admin.id)
  }

  // "Create Super Admin" — SUPER_ADMIN only, no @RequirePermissions escape
  // hatch, same as updateUserRole below: standing up another platform-owner-
  // level account is a role-tier action, never a grantable permission. See
  // AdminService.createSuperAdmin for what this actually composes.
  @Post('admins/super-admin')
  @Roles('SUPER_ADMIN')
  createSuperAdmin(@Body() dto: CreateAdminDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.createSuperAdmin(dto, admin.id)
  }

  @Patch('admins/:id/reset-password')
  @Roles('SUPER_ADMIN')
  resetAdminPassword(@Param('id') id: string, @Body() dto: ResetAdminPasswordDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.resetAdminPassword(id, dto, admin.id)
  }

  // SUPER_ADMIN only + step-up — granting/revoking permissions is itself
  // one of the explicitly listed sensitive operations.
  @Patch('admins/:id/permissions/:permission/grant')
  @Roles('SUPER_ADMIN')
  grantPermission(@Param('id') id: string, @Param('permission') permission: string, @Body() dto: GrantPermissionDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.grantPermission(id, permission as PermissionKey, dto, admin.id)
  }

  @Patch('admins/:id/permissions/:permission/revoke')
  @Roles('SUPER_ADMIN')
  revokePermission(@Param('id') id: string, @Param('permission') permission: string, @Body() dto: RevokePermissionDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.revokePermission(id, permission as PermissionKey, admin.id, dto)
  }

  // "Grant All ADMIN Permissions" — SUPER_ADMIN only, no @RequirePermissions
  // escape hatch, same tier as every other admin-management action above.
  // Target is identified by email in the body, not a URL id — Administrator
  // Accounts (GET /admin/admins) no longer lists other administrators to
  // click into, so this is invoked from its own small form instead.
  @Patch('admins/permissions/grant-all')
  @Roles('SUPER_ADMIN')
  grantAllAdminPermissions(@Body() dto: GrantAllAdminPermissionsDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.grantAllAdminPermissions(dto, admin.id)
  }
}
