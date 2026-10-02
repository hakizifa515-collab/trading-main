import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import type { Prisma, Role } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import * as argon2 from 'argon2'
import { generateReferralCode } from '../auth/referral-code.util'
import { PrismaService } from '../prisma/prisma.service'
import { LedgerService } from '../ledger/ledger.service'
import { AccountsService } from '../accounts/accounts.service'
import { AuditService } from '../audit/audit.service'
import { AuditEvent } from '../audit/audit-events'
import { PlatformSettingsService } from '../platform-settings/platform-settings.service'
import { MarketsService } from '../markets/markets.service'
import { WithdrawalsService } from '../withdrawals/withdrawals.service'
import { StepUpService } from '../common/security/step-up.service'
import { OrderReconciliationService } from '../orders/order-reconciliation.service'
import { OPEN_ORDER_STATUSES } from '../orders/order-risk-math'
import { RISK_REASON_CODES } from '../orders/risk-engine.types'
import { toPublicUser } from '../users/public-user'
import type { PermissionKey } from '../common/permissions'
import type { FinancialAdjustmentDto } from './dto/financial-adjustment.dto'
import type { UpdateUserStatusDto } from './dto/update-user-status.dto'
import type { UpdateAccountStatusDto } from './dto/update-account-status.dto'
import type { UpdateUserRoleDto } from './dto/update-user-role.dto'
import type { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto'
import type { UpdateMarketConfigDto } from './dto/update-market-config.dto'
import type { GrantPermissionDto } from './dto/grant-permission.dto'
import type { CreateAdminDto } from './dto/create-admin.dto'
import type { ResetAdminPasswordDto } from './dto/reset-admin-password.dto'

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly markets: MarketsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly stepUp: StepUpService,
    private readonly orderReconciliation: OrderReconciliationService,
  ) {}

  // Phase 6F Checkpoint E, Part 15 — admin-only, read-only. No step-up: the
  // existing internal-ledger reconciliation endpoint (GET /admin/reconciliation,
  // ReconciliationService.run()) sets the precedent that a PURE READ report
  // — nothing here ever repairs a discrepancy — sits at the same trust tier
  // as viewing ledger/order data, not the money-moving tier that requires
  // step-up (withdrawal approval, platform kill switches, permission
  // grants — see admin.controller.ts's step-up-gated routes). The run
  // itself is still audited (who, when, summary counts) even though it has
  // no financial effect.
  async runOrderReconciliation(adminId: string) {
    const summary = await this.orderReconciliation.runReconciliation()
    await this.audit.record({
      actorId: adminId,
      action: AuditEvent.RECONCILIATION_RUN,
      targetType: 'RECONCILIATION',
      newState: { ordersChecked: summary.ordersChecked, reconciled: summary.reconciled, warnings: summary.warnings, critical: summary.critical },
    })
    return summary
  }

  // Checkpoint I.1, Part 4 — cheap, pure-DB-read visibility into orders
  // TRUST has ALREADY given up on resolving itself (via flagUnresolved —
  // see orders.service.ts), distinct from runOrderReconciliation() above,
  // which actively re-queries the live execution provider for every
  // non-terminal order (expensive, catches NEW problems). This just
  // answers "what does TRUST already know needs a human," instantly.
  //
  // `SUBMITTED` is the correct, and only, marker: no code path in
  // OrdersService sets an order to SUBMITTED except handleSubmissionFailure's
  // ambiguous-outcome branch and flagUnresolved's default target status —
  // see orders.service.ts. There is no separate FAILED/UNKNOWN OrderStatus
  // value (deliberately not introduced this checkpoint — see the
  // Checkpoint I.1 report's Part 4 section); this is the safest existing
  // signal for "requires reconciliation," not a new one invented here.
  async listUnresolvedOrders() {
    const orders = await this.prisma.order.findMany({
      where: { status: 'SUBMITTED' },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        userId: true,
        accountId: true,
        symbol: true,
        side: true,
        orderType: true,
        quantity: true,
        clientOrderId: true,
        externalOrderId: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return { count: orders.length, orders }
  }

  // ---- Platform overview ---------------------------------------------------

  async getOverview() {
    const [
      totalUsers,
      activeUsers,
      pendingKyc,
      pendingDeposits,
      pendingWithdrawals,
      openPositions,
      filledOrders,
      platformSettings,
      marketConfigs,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.kycVerification.count({ where: { status: 'PENDING' } }),
      this.prisma.deposit.count({ where: { status: 'PENDING' } }),
      this.prisma.withdrawal.count({ where: { status: { in: ['PENDING', 'REVIEW'] } } }),
      this.prisma.position.count({ where: { status: 'OPEN' } }),
      this.prisma.order.findMany({ where: { status: 'FILLED' }, select: { symbol: true, filledQuantity: true, executedPrice: true } }),
      this.platformSettings.get(),
      this.markets.listMarketConfigs(),
    ])

    // Notional (filledQuantity × executedPrice) grouped by each market's own
    // quote currency — never summed across currencies or across raw base-asset
    // quantities. A BTC/USDT fill and an XAU/USD fill are not the same unit;
    // blindly adding their quantities/notionals together would be financially
    // meaningless (Phase F currency audit).
    const quoteAssetBySymbol = new Map(marketConfigs.map((m) => [m.symbol, m.quoteAsset]))
    const tradingVolume: Record<string, string> = {}
    for (const o of filledOrders) {
      if (!o.executedPrice) continue
      const currency = quoteAssetBySymbol.get(o.symbol) ?? 'USD'
      const notional = new Decimal(o.filledQuantity).times(o.executedPrice)
      tradingVolume[currency] = new Decimal(tradingVolume[currency] ?? '0').plus(notional).toString()
    }
    const totalCustomerAssets = await this.getTotalCustomerAssets()

    return {
      totalUsers,
      activeUsers,
      pendingKyc,
      pendingDeposits,
      pendingWithdrawals,
      openPositions,
      tradingVolume, // per-currency notional from FILLED orders; empty until fills exist — that's correct, not a bug
      totalCustomerAssets,
      platform: platformSettings,
      markets: marketConfigs,
    }
  }

  // Phase 6F Checkpoint F, Part 15 — admin-visible risk surface beyond
  // what getOverview() already exposes (global/market trading status,
  // configured limits — both already flow through platformSettings.get()
  // and markets.listMarketConfigs() above once the risk-limit columns are
  // populated). This adds the three things getOverview() does not cover:
  // current exposure (total RESERVED across all users, by currency),
  // active open orders (by status), and recent risk violations (grouped by
  // reason code, read directly off Order.rejectionReason — never a new
  // table, since createRiskRejectedOrder already encodes the code there).
  async getRiskOverview() {
    const [openOrdersByStatus, reservedByCurrency, recentRejections, currentPositions] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { status: { in: OPEN_ORDER_STATUSES } }, _count: { _all: true } }),
      this.prisma.ledgerEntry.groupBy({
        by: ['currency', 'direction'],
        where: { ledgerAccount: { ownerType: 'USER', type: 'RESERVED' } },
        _sum: { amount: true },
      }),
      this.prisma.order.findMany({
        where: { status: 'REJECTED', rejectionReason: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { rejectionReason: true },
      }),
      this.prisma.position.count({ where: { status: 'OPEN' } }),
    ])

    const exposureByCurrency: Record<string, string> = {}
    for (const row of reservedByCurrency) {
      const amount = new Decimal(row._sum.amount ?? 0)
      exposureByCurrency[row.currency] = (new Decimal(exposureByCurrency[row.currency] ?? 0)[row.direction === 'CREDIT' ? 'plus' : 'minus'](amount)).toString()
    }

    const violationsByReasonCode: Record<string, number> = {}
    for (const { rejectionReason } of recentRejections) {
      const code = rejectionReason?.split(':')[0]?.trim()
      if (!code || !RISK_REASON_CODES.includes(code as any)) continue
      violationsByReasonCode[code] = (violationsByReasonCode[code] ?? 0) + 1
    }

    return {
      openOrdersByStatus: Object.fromEntries(openOrdersByStatus.map((r) => [r.status, r._count._all])),
      totalOpenOrders: openOrdersByStatus.reduce((sum, r) => sum + r._count._all, 0),
      exposureByCurrency,
      currentOpenPositions: currentPositions,
      recentRiskViolationsByReasonCode: violationsByReasonCode,
    }
  }

  // Per-currency, never a single blindly-summed total — a USD cash balance
  // and a USDT cash balance are not the same unit (Phase F currency audit).
  private async getTotalCustomerAssets(): Promise<Record<string, string>> {
    const [cashSum, reservedSum] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['direction', 'currency'],
        where: { ledgerAccount: { ownerType: 'USER', type: 'CASH' } },
        _sum: { amount: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['direction', 'currency'],
        where: { ledgerAccount: { ownerType: 'USER', type: 'RESERVED' } },
        _sum: { amount: true },
      }),
    ])
    const totals = new Map<string, Decimal>()
    for (const rows of [cashSum, reservedSum]) {
      for (const r of rows) {
        const amount = r._sum.amount ?? new Decimal(0)
        const delta = r.direction === 'CREDIT' ? amount : amount.negated()
        totals.set(r.currency, (totals.get(r.currency) ?? new Decimal(0)).plus(delta))
      }
    }
    return Object.fromEntries([...totals.entries()].map(([currency, amount]) => [currency, amount.toString()]))
  }

  // ---- User management -------------------------------------------------------

  // `q` matches email or full name (case-insensitive substring) or an exact
  // user id — there is no separate human-readable member-id/phone field on
  // User today (Admin Panel redesign gap analysis), so search is scoped to
  // what actually exists on the model rather than inventing fields.
  async listUsers(q?: string) {
    const search = q?.trim()
    const users = await this.prisma.user.findMany({
      where: {
        // Never surface a SUPER_ADMIN account on this general list — it's
        // reachable by any ADMIN holding users.read, and this view was never
        // meant to reveal that the platform-owner account exists (that's
        // what the dedicated, SUPER_ADMIN-only Admin Management list —
        // listAdmins() below — is for). A plain ADMIN row is unaffected and
        // still shows normally.
        role: { not: 'SUPER_ADMIN' },
        ...(search
          ? { OR: [{ email: { contains: search, mode: 'insensitive' as const } }, { fullName: { contains: search, mode: 'insensitive' as const } }, { id: search }] }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    // Primary spot/crypto balance (USDT) per user, for the list view — same
    // "USDT is the primary funding currency" convention used everywhere else
    // in this codebase (Dashboard/Assets Spot Balance). A best-effort batch
    // read; a user with no USDT ledger account yet just shows 0, not an error.
    const balances = await Promise.all(
      users.map(async (u) => {
        const account = await this.prisma.account.findFirst({ where: { userId: u.id } })
        if (!account) return '0'
        const { cash } = await this.ledger.getAccountBalances(account.id, 'USDT')
        return cash.toString()
      }),
    )
    return users.map((u, i) => ({ ...toPublicUser(u), usdtBalance: balances[i] }))
  }

  // Aggregated detail view for one user — profile, non-zero balances across
  // every currency they hold, and recent deposit/withdrawal history. Trade
  // history is deliberately NOT folded in here (keeps this response bounded
  // and reuses the dedicated Trade Management list/filter instead of
  // duplicating it) — Admin Panel redesign.
  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const account = await this.prisma.account.findFirst({ where: { userId } })
    const balances = account ? await this.accounts.listNonZeroAssetBalances(userId) : []
    const [deposits, withdrawals] = await Promise.all([
      this.prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 25 }),
      this.prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    ])
    return {
      user: toPublicUser(user),
      accountId: account?.id ?? null,
      balances,
      recentDeposits: deposits,
      recentWithdrawals: withdrawals,
    }
  }

  async updateUserStatus(targetUserId: string, dto: UpdateUserStatusDto, adminId: string, actorRole: Role) {
    // Admin Panel redesign — the Admin Management UI's "Delete" action
    // reuses this same suspend mechanism (see class doc comment on
    // AdminsTab/AdminManagement); block an admin from suspending their OWN
    // account, which would otherwise lock them out with no way back in.
    if (targetUserId === adminId && dto.status === 'SUSPENDED') {
      throw new BadRequestException('You cannot suspend your own account.')
    }
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id: targetUserId } })
    // Role Separation — this route is only gated by users.write, a
    // grantable ADMIN permission, so unlike updateUserRole below it has no
    // @Roles('SUPER_ADMIN') at the controller to fall back on. Re-check here:
    // a plain ADMIN must never be able to suspend/reactivate a SUPER_ADMIN
    // account, no matter which permissions it holds. A SUPER_ADMIN acting on
    // another SUPER_ADMIN is unaffected.
    if (target.role === 'SUPER_ADMIN' && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a Super Admin can change another Super Admin\'s status.')
    }
    const updated = await this.prisma.user.update({ where: { id: targetUserId }, data: { status: dto.status } })

    await this.recordAdminAction(adminId, dto.status === 'SUSPENDED' ? AuditEvent.USER_SUSPENDED : dto.status === 'ACTIVE' ? AuditEvent.USER_REACTIVATED : AuditEvent.USER_STATUS_CHANGED, targetUserId, dto.reason, { status: target.status }, { status: dto.status })

    return toPublicUser(updated)
  }

  // Phase 6F Checkpoint F, Part 14/15 — the minimum required admin control
  // for RiskEngineService's ACCOUNT_TRADING_DISABLED check (Account.status
  // was a schema field with no reader or writer anywhere before this
  // checkpoint — see the Checkpoint F report's architecture audit).
  // Distinct from updateUserStatus above: this suspends ONE trading
  // account, not the user's ability to log in at all.
  async updateAccountStatus(accountId: string, dto: UpdateAccountStatusDto, adminId: string) {
    const target = await this.prisma.account.findUniqueOrThrow({ where: { id: accountId } })
    const updated = await this.prisma.account.update({ where: { id: accountId }, data: { status: dto.status } })

    await this.recordAdminAction(
      adminId,
      dto.status === 'SUSPENDED' ? AuditEvent.USER_SUSPENDED : dto.status === 'ACTIVE' ? AuditEvent.USER_REACTIVATED : AuditEvent.USER_STATUS_CHANGED,
      target.userId,
      dto.reason,
      { accountId, status: target.status },
      { accountId, status: dto.status },
    )

    return updated
  }

  // Role changes are the most sensitive user-management action available —
  // restricted to SUPER_ADMIN at the controller level (@Roles(SUPER_ADMIN))
  // in addition to step-up (password re-authentication) here. This is also how
  // "creating"/"deleting" an administrator works in this design — promoting
  // a USER to ADMIN, or demoting an ADMIN back to USER — there is no
  // separate endpoint, so both are covered by this same guard.
  async updateUserRole(targetUserId: string, dto: UpdateUserRoleDto, adminId: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, dto.confirmPassword)
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id: targetUserId } })

    // Refuse to demote the LAST SUPER_ADMIN, whether that's a self-demotion or
    // one SUPER_ADMIN demoting another — the platform must never be left with
    // zero accounts able to manage roles/permissions. Not a self-lockout
    // check specifically (an account is never special-cased by its own id);
    // it only fires when this WOULD be the last one, so a platform with
    // several SUPER_ADMINs is unaffected.
    if (target.role === 'SUPER_ADMIN' && dto.role !== 'SUPER_ADMIN') {
      const otherSuperAdmins = await this.prisma.user.count({ where: { role: 'SUPER_ADMIN', id: { not: targetUserId } } })
      if (otherSuperAdmins === 0) {
        throw new BadRequestException('Cannot change the role of the last Super Admin — promote another account to Super Admin first.')
      }
    }

    const updated = await this.prisma.user.update({ where: { id: targetUserId }, data: { role: dto.role } })

    await this.recordAdminAction(adminId, AuditEvent.ROLE_CHANGED, targetUserId, dto.reason, { role: target.role }, { role: dto.role })

    return toPublicUser(updated)
  }

  // ---- Financial adjustment ---------------------------------------------------

  async financialAdjustment(dto: FinancialAdjustmentDto, adminId: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, dto.confirmPassword)

    const amount = new Decimal(dto.amount)
    if (amount.lte(0)) throw new BadRequestException('Adjustment amount must be positive; use direction to credit or debit.')

    const currency = dto.currency ?? 'USD'
    const account = await this.accounts.getPrimaryAccount(dto.userId)
    const { cash } = await this.ledger.getOrCreateUserLedgerAccounts(account.id, currency)
    const revenue = await this.ledger.getSystemLedgerAccount('REVENUE', currency)

    const entries = dto.direction === 'CREDIT'
      ? [
          { ledgerAccountId: revenue.id, direction: 'DEBIT' as const, amount, currency, entryType: 'ADJUSTMENT' as const },
          { ledgerAccountId: cash.id, direction: 'CREDIT' as const, amount, currency, entryType: 'ADJUSTMENT' as const },
        ]
      : [
          { ledgerAccountId: cash.id, direction: 'DEBIT' as const, amount, currency, entryType: 'ADJUSTMENT' as const },
          { ledgerAccountId: revenue.id, direction: 'CREDIT' as const, amount, currency, entryType: 'ADJUSTMENT' as const },
        ]

    // DEBIT can drive a balance negative without a lock+precondition — same
    // race a withdrawal request guards against (Admin Panel redesign fix:
    // this previously used plain postTransaction() with no balance check at
    // all). CREDIT can never overdraw, so it keeps the simpler, lock-free
    // path — consistent with how every other credit-only ledger write in
    // this codebase is posted.
    const txn = dto.direction === 'DEBIT'
      ? await this.ledger.postTransactionWithAccountLock(
          cash.id,
          {
            description: `Admin financial adjustment: ${dto.reason}`,
            relatedType: 'ADMIN_ADJUSTMENT',
            relatedId: dto.userId,
            idempotencyKey: dto.idempotencyKey,
            entries,
          },
          async (tx) => {
            const balance = await this.ledger.getLedgerAccountBalanceLocked(tx, cash.id)
            if (balance.lt(amount)) throw new BadRequestException('Insufficient balance for this debit adjustment.')
          },
        )
      : await this.ledger.postTransaction({
          description: `Admin financial adjustment: ${dto.reason}`,
          relatedType: 'ADMIN_ADJUSTMENT',
          relatedId: dto.userId,
          idempotencyKey: dto.idempotencyKey,
          entries,
        })

    await this.recordAdminAction(adminId, AuditEvent.FINANCIAL_ADJUSTMENT, dto.userId, dto.reason, undefined, { direction: dto.direction, amount: dto.amount, currency }, txn.id)

    return { ledgerTransactionId: txn.id, balances: await this.ledger.getAccountBalances(account.id, currency) }
  }

  // ---- Platform-wide controls -------------------------------------------------

  async updatePlatformSettings(dto: UpdatePlatformSettingsDto, adminId: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, dto.confirmPassword)

    // Support auto-greeting must always be authored by a real, current
    // staff account — never a fabricated/bot sender — so the chosen
    // sender is validated here, at write time, against real ADMIN/
    // SUPER_ADMIN accounts (the DTO only checks that it's a string).
    if (dto.supportAutoGreetingSenderId !== undefined) {
      const sender = await this.prisma.user.findUnique({ where: { id: dto.supportAutoGreetingSenderId }, select: { role: true } })
      if (!sender || (sender.role !== 'ADMIN' && sender.role !== 'SUPER_ADMIN')) {
        throw new BadRequestException('supportAutoGreetingSenderId must be an existing admin account.')
      }
    }

    const before = await this.platformSettings.get()
    const { reason, confirmPassword: _cp, ...patch } = dto
    const updated = await this.platformSettings.update(patch, adminId)

    for (const [key, event] of [
      ['tradingEnabled', ['TRADING_RESUMED', 'TRADING_PAUSED']],
      ['depositsEnabled', ['DEPOSITS_RESUMED', 'DEPOSITS_PAUSED']],
      ['withdrawalsEnabled', ['WITHDRAWALS_RESUMED', 'WITHDRAWALS_PAUSED']],
      ['registrationsEnabled', ['REGISTRATIONS_RESUMED', 'REGISTRATIONS_PAUSED']],
    ] as const) {
      const newVal = (patch as any)[key]
      if (newVal !== undefined && newVal !== (before as any)[key]) {
        await this.recordAdminAction(adminId, newVal ? event[0] : event[1], undefined, reason, { [key]: (before as any)[key] }, { [key]: newVal })
      }
    }

    // Phase 6F Checkpoint F, Part 15/16 — the boolean-toggle loop above
    // doesn't cover a pure numeric risk-limit change (e.g. maxOpenOrdersPerUser
    // going from unset to 10), which would otherwise be a silent,
    // unaudited platform-wide risk-config change.
    if (patch.maxOpenOrdersPerUser !== undefined && patch.maxOpenOrdersPerUser !== before.maxOpenOrdersPerUser) {
      await this.recordAdminAction(
        adminId,
        AuditEvent.SECURITY_SETTING_CHANGED,
        undefined,
        reason,
        { maxOpenOrdersPerUser: before.maxOpenOrdersPerUser },
        { maxOpenOrdersPerUser: patch.maxOpenOrdersPerUser },
      )
    }

    const greetingChanged = ['supportAutoGreetingEnabled', 'supportAutoGreetingMessage', 'supportAutoGreetingSenderId'].some(
      (key) => (patch as any)[key] !== undefined && (patch as any)[key] !== (before as any)[key],
    )
    if (greetingChanged) {
      await this.recordAdminAction(
        adminId,
        AuditEvent.SUPPORT_AUTO_GREETING_CHANGED,
        undefined,
        reason,
        { supportAutoGreetingEnabled: before.supportAutoGreetingEnabled, supportAutoGreetingSenderId: before.supportAutoGreetingSenderId },
        { supportAutoGreetingEnabled: updated.supportAutoGreetingEnabled, supportAutoGreetingSenderId: updated.supportAutoGreetingSenderId },
      )
    }

    // ADMIN NOTIFICATIONS — the recipient address is where "New Support
    // Ticket" / "Customer Reply" emails go (support.service.ts), so
    // changing it is audited the same way as every other platform-wide
    // setting above, not silently applied.
    if (patch.supportNotificationEmail !== undefined && patch.supportNotificationEmail !== before.supportNotificationEmail) {
      await this.recordAdminAction(
        adminId,
        AuditEvent.SUPPORT_NOTIFICATION_EMAIL_CHANGED,
        undefined,
        reason,
        { supportNotificationEmail: before.supportNotificationEmail },
        { supportNotificationEmail: updated.supportNotificationEmail },
      )
    }

    return updated
  }

  async updateMarketConfig(symbol: string, dto: UpdateMarketConfigDto, adminId: string) {
    const before = await this.markets.getMarketConfig(symbol)
    const { reason, ...patch } = dto
    const updated = await this.markets.setMarketConfig(symbol, patch)

    if (patch.tradingEnabled !== undefined && patch.tradingEnabled !== before.tradingEnabled) {
      await this.recordAdminAction(
        adminId,
        patch.tradingEnabled ? AuditEvent.MARKET_ENABLED : AuditEvent.MARKET_DISABLED,
        undefined,
        reason,
        { symbol, tradingEnabled: before.tradingEnabled },
        { symbol, tradingEnabled: patch.tradingEnabled },
      )
    }

    // Phase 6F Checkpoint F, Part 6/15/16 — per-market risk-limit changes,
    // audited as a single event covering whichever of the four fields
    // actually changed (avoids four near-identical audit rows for one
    // admin action).
    const riskFields = ['minimumQuantity', 'maximumQuantity', 'maxOrderNotional', 'maxPositionQuantity'] as const
    const riskBefore: Record<string, string | null> = {}
    const riskAfter: Record<string, string | null> = {}
    for (const field of riskFields) {
      const newVal = (patch as any)[field]
      if (newVal !== undefined && newVal !== (before as any)[field]?.toString()) {
        riskBefore[field] = (before as any)[field]?.toString() ?? null
        riskAfter[field] = newVal
      }
    }
    if (Object.keys(riskAfter).length > 0) {
      await this.recordAdminAction(adminId, AuditEvent.SECURITY_SETTING_CHANGED, undefined, reason, { symbol, ...riskBefore }, { symbol, ...riskAfter })
    }

    return updated
  }

  // ---- Admin management (permissions) --------------------------------------

  // ADMIN accounts only — deliberately unconditional, for EVERY viewer
  // including a SUPER_ADMIN one. This is the "Administrator Accounts" list
  // (Admin Management); a SUPER_ADMIN account must never appear in it, full
  // stop — not even to another SUPER_ADMIN. Role promotion/demotion still
  // happens via updateUserRole above, and a second Super Admin is still
  // created via createSuperAdmin below; this list just never displays one.
  async listAdmins() {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      include: { userPermissions: { include: { permission: true } } },
    })
    return admins.map((a) => ({
      ...toPublicUser(a),
      permissions: a.userPermissions.map((p) => p.permission.key),
    }))
  }

  // Creates a brand-new ADMIN account directly (never SUPER_ADMIN — reaching
  // that role still requires the existing role-promotion path, which is
  // itself SUPER_ADMIN + step-up gated). SUPER_ADMIN-only + step-up at the
  // controller/here, same tier as grantPermission/updateUserRole.
  async createAdmin(dto: CreateAdminDto, adminId: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, dto.confirmPassword)

    const email = dto.email.toLowerCase()
    const existing = await this.prisma.user.findUnique({ where: { email } })
    if (existing) throw new BadRequestException('An account with this email already exists.')

    const passwordHash = await argon2.hash(dto.password)
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: dto.fullName?.trim() || email,
          role: 'ADMIN',
          status: 'ACTIVE',
          kycStatus: 'VERIFIED',
          referralCode: generateReferralCode(),
        },
      })
      await tx.account.create({ data: { userId: created.id } })
      return created
    })

    await this.recordAdminAction(adminId, AuditEvent.USER_CREATED, user.id, dto.reason, undefined, { email: user.email, role: 'ADMIN' })
    return toPublicUser(user)
  }

  // "Create Super Admin" — a SUPER_ADMIN-only UI action for standing up a
  // second, fully independent Super Admin account without hand-driving the
  // role-change API. Deliberately just composes the two existing,
  // independently step-up-gated and independently audited actions above
  // (create a brand-new ADMIN, then promote that exact account to
  // SUPER_ADMIN) rather than reimplementing any validation, hashing, or
  // audit logic — USER_CREATED then ROLE_CHANGED are recorded exactly as
  // they would be for the equivalent two-step flow through the panel.
  async createSuperAdmin(dto: CreateAdminDto, adminId: string) {
    const created = await this.createAdmin(dto, adminId)
    return this.updateUserRole(created.id, { role: 'SUPER_ADMIN', reason: dto.reason, confirmPassword: dto.confirmPassword }, adminId)
  }

  // Admin-set password reset for ANOTHER admin (not self-service password
  // change) — SUPER_ADMIN-only + step-up. Revokes every existing session for
  // the target account so a reset password can't coexist with an
  // already-open session using the OLD one.
  async resetAdminPassword(targetAdminId: string, dto: ResetAdminPasswordDto, adminId: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, dto.confirmPassword)

    const target = await this.prisma.user.findUniqueOrThrow({ where: { id: targetAdminId } })
    if (target.role !== 'ADMIN' && target.role !== 'SUPER_ADMIN') {
      throw new BadRequestException('That account is not an administrator.')
    }

    const passwordHash = await argon2.hash(dto.newPassword)
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetAdminId }, data: { passwordHash } }),
      this.prisma.session.updateMany({ where: { userId: targetAdminId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])

    await this.recordAdminAction(adminId, AuditEvent.ADMIN_ACCOUNT_PASSWORD_RESET, targetAdminId, dto.reason, undefined, undefined)
    return { ok: true }
  }

  // Step-up required — this is "changing admin permissions" from the spec's
  // MFA list. SUPER_ADMIN-only at the controller level: an ADMIN can never
  // grant permissions, including to themselves, matching "SUPER_ADMIN
  // should remain the highest authority."
  async grantPermission(targetAdminId: string, permissionKey: PermissionKey, dto: GrantPermissionDto, superAdminId: string) {
    await this.stepUp.assertStepUpAuthorized(superAdminId, dto.confirmPassword)
    const permission = await this.prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } })

    await this.prisma.userPermission.upsert({
      where: { userId_permissionId: { userId: targetAdminId, permissionId: permission.id } },
      create: { userId: targetAdminId, permissionId: permission.id },
      update: {},
    })

    await this.recordAdminAction(superAdminId, AuditEvent.PERMISSION_CHANGED, targetAdminId, dto.reason, { granted: false }, { granted: true, permission: permissionKey })
    return this.listAdmins()
  }

  async revokePermission(targetAdminId: string, permissionKey: PermissionKey, superAdminId: string, dto: { reason: string; confirmPassword: string }) {
    await this.stepUp.assertStepUpAuthorized(superAdminId, dto.confirmPassword)
    const permission = await this.prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } })

    await this.prisma.userPermission.deleteMany({ where: { userId: targetAdminId, permissionId: permission.id } })

    await this.recordAdminAction(superAdminId, AuditEvent.PERMISSION_CHANGED, targetAdminId, dto.reason, { granted: true, permission: permissionKey }, { granted: false })
    return this.listAdmins()
  }

  // Withdrawal approval requires step-up too (explicitly listed as
  // sensitive) — kept here (rather than in WithdrawalsService, which has no
  // reason to know about password/TOTP re-authentication) so all
  // step-up-gated actions are visible in one place.
  async approveWithdrawalWithStepUp(withdrawalId: string, confirmPassword: string, adminId: string, reason?: string) {
    await this.stepUp.assertStepUpAuthorized(adminId, confirmPassword)
    return this.withdrawals.approve(withdrawalId, adminId, reason)
  }

  // ---- Audit trail -------------------------------------------------------------

  async listAuditLogs(limit?: number) {
    return this.audit.listRecent(limit)
  }

  private async recordAdminAction(
    adminId: string,
    action: string,
    targetUserId: string | undefined,
    reason: string | undefined,
    previousState: Prisma.InputJsonValue | undefined,
    newState: Prisma.InputJsonValue | undefined,
    ledgerTransactionId?: string,
  ) {
    await this.prisma.adminAction.create({
      data: { adminId, action, targetUserId, reason, previousState, newState, ledgerTransactionId },
    })
    await this.audit.record({
      actorId: adminId,
      action,
      targetType: targetUserId ? 'USER' : 'PLATFORM',
      targetId: targetUserId,
      previousState,
      newState,
      reason,
    })
  }
}
