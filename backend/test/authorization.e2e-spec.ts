import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import * as argon2 from 'argon2'
import { Decimal } from '@prisma/client/runtime/library'
import { createTestApp, uniqueEmail, extractSessionCookie, createUserDirect, enableTotpDirect, currentTotpCode } from './helpers/test-app'
import type { PrismaService } from '../src/prisma/prisma.service'

// Handles both plain login and (if the user has 2FA enabled) the full
// login -> 2fa/login-verify flow, returning a real session cookie either way.
async function loginCookie(server: any, email: string, password: string, totpSecret?: string): Promise<string> {
  const res = await request(server).post('/auth/login').send({ email, password }).expect(200)
  if (res.body.needsTwoFactor) {
    if (!totpSecret) throw new Error('User requires 2FA but no TOTP secret was provided to loginCookie().')
    const verified = await request(server)
      .post('/auth/2fa/login-verify')
      .send({ pendingToken: res.body.pendingToken, code: currentTotpCode(totpSecret) })
      .expect(200)
    return extractSessionCookie(verified)
  }
  return extractSessionCookie(res)
}

describe('Authorization: roles + fine-grained permissions (real PostgreSQL)', () => {
  let app: INestApplication
  let prisma: PrismaService
  let server: any

  beforeAll(async () => {
    const t = await createTestApp()
    app = t.app
    prisma = t.prisma
    server = app.getHttpServer()
    // Seed permission definitions (normally done by prisma/seed.ts).
    const { PERMISSIONS } = await import('../src/common/permissions')
    for (const key of PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, create: { key, description: key }, update: {} })
    }
  })

  afterAll(async () => {
    await app.close()
  })

  it('a plain USER cannot access any /admin endpoint', async () => {
    const email = uniqueEmail('plainuser')
    const password = 'correct-horse-battery'
    await createUserDirect(prisma, { email, password, role: 'USER' })
    const cookie = await loginCookie(server, email, password)

    await request(server).get('/admin/overview').set('Cookie', cookie).expect(403)
  })

  // Admin Panel redesign — one representative endpoint per Admin frontend
  // section (Trading, Users, Deposits, Withdrawals, KYC, Settings, Admin
  // Management, Deposit Wallet, Contacts, Wallet Adjustment). Proves the
  // backend rejects a normal, authenticated customer from every one of
  // them — this is the real security boundary; the frontend nav item and
  // AdminOnly route wrapper are only a UX convenience on top of this.
  it('a plain USER is rejected (401/403) from every Admin frontend section\'s backing endpoint', async () => {
    const email = uniqueEmail('customerdashboard')
    const password = 'correct-horse-battery'
    await createUserDirect(prisma, { email, password, role: 'USER' })
    const cookie = await loginCookie(server, email, password)

    const protectedRoutes: { method: 'get' | 'patch' | 'post'; path: string }[] = [
      { method: 'get', path: '/admin/overview' },                              // Dashboard stats
      { method: 'get', path: '/admin/options/settings' },                      // Trading
      { method: 'get', path: '/admin/users' },                                 // Users
      { method: 'get', path: '/admin/deposits' },                              // Deposit Management
      { method: 'get', path: '/admin/withdrawals' },                           // Withdrawal Management
      { method: 'get', path: '/admin/kyc/submissions' },                       // KYC Verification
      { method: 'patch', path: '/admin/platform-settings' },                   // Settings (kill switches)
      { method: 'get', path: '/admin/admins' },                                // Admin Management
      { method: 'get', path: '/admin/crypto-deposits/assets' },                // Deposit Wallet
      { method: 'get', path: '/admin/contacts' },                              // Admin Contact
      { method: 'post', path: '/admin/financial-adjustment' },                 // Manual Wallet Adjustment
      { method: 'get', path: '/admin/audit-logs' },                            // Audit Logs
    ]

    for (const route of protectedRoutes) {
      const res = await request(server)[route.method](route.path).set('Cookie', cookie).send({})
      expect([401, 403]).toContain(res.status)
    }
  })

  it('an unauthenticated request (no session cookie at all) gets 401, not a redirect or a 200', async () => {
    await request(server).get('/admin/overview').expect(401)
    await request(server).get('/admin/users').expect(401)
  })

  it('an ADMIN with no granted permissions is rejected from a permission-gated route', async () => {
    const email = uniqueEmail('freshadmin')
    const password = 'correct-horse-battery'
    await createUserDirect(prisma, { email, password, role: 'ADMIN' })
    const cookie = await loginCookie(server, email, password)

    // ADMIN role passes RolesGuard, but PermissionsGuard should still reject
    // — a fresh ADMIN has zero permissions granted by default.
    await request(server).get('/admin/overview').set('Cookie', cookie).expect(403)
    await request(server).get('/admin/users').set('Cookie', cookie).expect(403)
  })

  it('granting a permission to that ADMIN allows exactly that route and no others', async () => {
    const superEmail = uniqueEmail('super')
    const superPassword = 'correct-horse-battery'
    const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
    const superSecret = await enableTotpDirect(prisma, superUser.id)
    const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

    const adminEmail = uniqueEmail('scopedadmin')
    const adminPassword = 'correct-horse-battery'
    const { user: adminUser } = await createUserDirect(prisma, { email: adminEmail, password: adminPassword, role: 'ADMIN' })
    const adminCookie = await loginCookie(server, adminEmail, adminPassword)

    // SUPER_ADMIN grants only platform.read to this ADMIN.
    await request(server)
      .patch(`/admin/admins/${adminUser.id}/permissions/platform.read/grant`)
      .set('Cookie', superCookie)
      .send({ reason: 'test grant', confirmPassword: superPassword })
      .expect(200)

    // Now allowed:
    await request(server).get('/admin/overview').set('Cookie', adminCookie).expect(200)
    // Still forbidden — users.read was never granted:
    await request(server).get('/admin/users').set('Cookie', adminCookie).expect(403)
  })

  it('an ADMIN can never grant permissions or change roles, even to themselves — SUPER_ADMIN only', async () => {
    const adminEmail = uniqueEmail('poweruser')
    const adminPassword = 'correct-horse-battery'
    const { user: adminUser } = await createUserDirect(prisma, { email: adminEmail, password: adminPassword, role: 'ADMIN' })
    const adminSecret = await enableTotpDirect(prisma, adminUser.id)
    const adminCookie = await loginCookie(server, adminEmail, adminPassword, adminSecret)

    await request(server)
      .patch(`/admin/admins/${adminUser.id}/permissions/admins.manage/grant`)
      .set('Cookie', adminCookie)
      .send({ reason: 'self-grant attempt', confirmPassword: adminPassword })
      .expect(403) // RolesGuard rejects before PermissionsGuard or StepUp even run — @Roles('SUPER_ADMIN')

    await request(server)
      .patch(`/admin/users/${adminUser.id}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'SUPER_ADMIN', reason: 'self-promote attempt', confirmPassword: adminPassword })
      .expect(403)
  })

  // Role-separation hardening — the last SUPER_ADMIN can never be demoted,
  // whether that's a self-demotion or one SUPER_ADMIN demoting another. The
  // platform must never be left with zero accounts able to manage roles and
  // permissions. See AdminService.updateUserRole().
  it('the last SUPER_ADMIN cannot be demoted (by itself or by another actor), but demoting succeeds once a second SUPER_ADMIN exists', async () => {
    // The guard counts SUPER_ADMIN rows GLOBALLY (correct for a real,
    // single-tenant production database) — this shared, never-truncated e2e
    // database already has many SUPER_ADMIN fixtures left behind by other
    // tests/files, so "the last one" has to be engineered here: snapshot and
    // temporarily demote every OTHER existing SUPER_ADMIN (direct Prisma
    // write, bypassing the very guard under test), then restore them
    // afterward no matter how the test finishes.
    const others = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } })
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: 'ADMIN' } })

    try {
      const email = uniqueEmail('lastsuper')
      const password = 'correct-horse-battery'
      const { user } = await createUserDirect(prisma, { email, password, role: 'SUPER_ADMIN' })
      const cookie = await loginCookie(server, email, password)

      // A distinct SUPER_ADMIN account performs the (rejected) demotion —
      // this is not merely a self-lockout check, it fires for ANY actor if
      // the TARGET would become the last one gone.
      const otherEmail = uniqueEmail('wouldbelast')
      const otherPassword = 'correct-horse-battery'
      const { user: otherUser } = await createUserDirect(prisma, { email: otherEmail, password: otherPassword, role: 'SUPER_ADMIN' })
      const otherCookie = await loginCookie(server, otherEmail, otherPassword)

      // Demote `user` from the OTHER account while `user` is still not the
      // last one (otherUser exists) — this must succeed...
      await request(server).patch(`/admin/users/${user.id}/role`).set('Cookie', otherCookie)
        .send({ role: 'ADMIN', reason: 'demote while not last', confirmPassword: otherPassword }).expect(200)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('ADMIN')

      // ...now `otherUser` IS the only SUPER_ADMIN left. Demoting it — even by
      // itself — must be refused.
      const res = await request(server).patch(`/admin/users/${otherUser.id}/role`).set('Cookie', otherCookie)
        .send({ role: 'ADMIN', reason: 'self-demote as the last one', confirmPassword: otherPassword })
      expect(res.status).toBe(400)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } })).role).toBe('SUPER_ADMIN')

      // Promoting `user` back to SUPER_ADMIN, then demoting `otherUser`, works —
      // there are two again at the moment of the call.
      await request(server).patch(`/admin/users/${user.id}/role`).set('Cookie', otherCookie)
        .send({ role: 'SUPER_ADMIN', reason: 're-promote', confirmPassword: otherPassword }).expect(200)
      await request(server).patch(`/admin/users/${otherUser.id}/role`).set('Cookie', cookie)
        .send({ role: 'ADMIN', reason: 'demote now that a second one exists', confirmPassword: password }).expect(200)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } })).role).toBe('ADMIN')
    } finally {
      await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: 'SUPER_ADMIN' } })
    }
  })

  // Support Audit — same "SUPER_ADMIN by default, grantable to an ADMIN"
  // shape as every other permission (see support.e2e-spec.ts's "31"/"32"/"33"
  // for the full moderation-feed behavior); this just confirms it follows
  // the exact same grant mechanism proven above for platform.read.
  it('Support Audit follows the same grant model: SUPER_ADMIN has it for free, a plain ADMIN needs an explicit support.audit grant', async () => {
    const superEmail = uniqueEmail('auditsuper')
    const superPassword = 'correct-horse-battery'
    const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
    const superSecret = await enableTotpDirect(prisma, superUser.id)
    const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)
    await request(server).get('/admin/support/audit').set('Cookie', superCookie).expect(200)

    const adminEmail = uniqueEmail('auditscopedadmin')
    const adminPassword = 'correct-horse-battery'
    const { user: adminUser } = await createUserDirect(prisma, { email: adminEmail, password: adminPassword, role: 'ADMIN' })
    const adminCookie = await loginCookie(server, adminEmail, adminPassword)
    await request(server).get('/admin/support/audit').set('Cookie', adminCookie).expect(403)

    await request(server).patch(`/admin/admins/${adminUser.id}/permissions/support.audit/grant`).set('Cookie', superCookie)
      .send({ reason: 'test grant', confirmPassword: superPassword }).expect(200)
    await request(server).get('/admin/support/audit').set('Cookie', adminCookie).expect(200)
  })

  it('SUPER_ADMIN passes every permission check without any explicit grant', async () => {
    const email = uniqueEmail('superoverview')
    const password = 'correct-horse-battery'
    await createUserDirect(prisma, { email, password, role: 'SUPER_ADMIN' })
    const cookie = await loginCookie(server, email, password)

    await request(server).get('/admin/overview').set('Cookie', cookie).expect(200)
    await request(server).get('/admin/users').set('Cookie', cookie).expect(200)
    await request(server).get('/admin/audit-logs').set('Cookie', cookie).expect(200)
  })

  // Phase F currency audit — /admin/overview's totalCustomerAssets used to
  // blindly sum every currency's CASH+RESERVED balance into one Decimal
  // (a USD balance and a USDT balance are not the same unit). Proves the
  // fix: a user holding both currencies shows up as a real per-currency
  // breakdown, never a single combined number.
  it('reports total customer assets per currency, never as one blindly-summed figure across currencies', async () => {
    const { LedgerService } = await import('../src/ledger/ledger.service')
    const ledger = app.get(LedgerService)

    const { account } = await createUserDirect(prisma, { email: uniqueEmail('multicurrencyholder'), password: 'correct-horse-battery' })
    const revenue = await ledger.getSystemLedgerAccount('REVENUE')

    const { cash: usdCash } = await ledger.getOrCreateUserLedgerAccounts(account.id, 'USD')
    await ledger.postTransaction({
      description: 'test fixture: USD credit',
      relatedType: 'ADMIN_ADJUSTMENT',
      relatedId: account.id,
      entries: [
        { ledgerAccountId: revenue.id, direction: 'DEBIT', amount: new Decimal('100'), entryType: 'ADJUSTMENT', currency: 'USD' },
        { ledgerAccountId: usdCash.id, direction: 'CREDIT', amount: new Decimal('100'), entryType: 'ADJUSTMENT', currency: 'USD' },
      ],
    })

    const { cash: usdtCash } = await ledger.getOrCreateUserLedgerAccounts(account.id, 'USDT')
    const revenueUsdt = await ledger.getSystemLedgerAccount('REVENUE', 'USDT')
    await ledger.postTransaction({
      description: 'test fixture: USDT credit',
      relatedType: 'ADMIN_ADJUSTMENT',
      relatedId: account.id,
      entries: [
        { ledgerAccountId: revenueUsdt.id, direction: 'DEBIT', amount: new Decimal('50'), entryType: 'ADJUSTMENT', currency: 'USDT' },
        { ledgerAccountId: usdtCash.id, direction: 'CREDIT', amount: new Decimal('50'), entryType: 'ADJUSTMENT', currency: 'USDT' },
      ],
    })

    const email = uniqueEmail('overviewreader')
    const password = 'correct-horse-battery'
    await createUserDirect(prisma, { email, password, role: 'SUPER_ADMIN' })
    const cookie = await loginCookie(server, email, password)

    const res = await request(server).get('/admin/overview').set('Cookie', cookie).expect(200)
    expect(typeof res.body.totalCustomerAssets).toBe('object')
    expect(Number(res.body.totalCustomerAssets.USD)).toBeGreaterThanOrEqual(100)
    expect(Number(res.body.totalCustomerAssets.USDT)).toBeGreaterThanOrEqual(50)
  })
})
