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

  // The general Users list (GET /admin/users) is reachable by any ADMIN
  // holding users.read — a routine grant for support/ops staff. It was never
  // meant to reveal that a SUPER_ADMIN (the platform-owner account) exists:
  // that's what the separate, SUPER_ADMIN-only Admin Management list
  // (GET /admin/admins) is for. A plain ADMIN account is unaffected and
  // still appears normally.
  it('the Users list never includes a SUPER_ADMIN row, even when searched for by exact email — a plain ADMIN row still appears', async () => {
    const superEmail = uniqueEmail('hiddensuper')
    const superPassword = 'correct-horse-battery'
    const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })

    const viewerEmail = uniqueEmail('viewer')
    const viewerPassword = 'correct-horse-battery'
    const { user: viewerAdmin } = await createUserDirect(prisma, { email: viewerEmail, password: viewerPassword, role: 'ADMIN' })

    const grantorSecret = await enableTotpDirect(prisma, superUser.id)
    const grantorCookie = await loginCookie(server, superEmail, superPassword, grantorSecret)
    await request(server)
      .patch(`/admin/admins/${viewerAdmin.id}/permissions/users.read/grant`)
      .set('Cookie', grantorCookie)
      .send({ reason: 'test grant', confirmPassword: superPassword })
      .expect(200)

    const viewerCookie = await loginCookie(server, viewerEmail, viewerPassword)

    const unfiltered = await request(server).get('/admin/users').set('Cookie', viewerCookie).expect(200)
    expect((unfiltered.body as { id: string }[]).some((u) => u.id === superUser.id)).toBe(false)
    expect((unfiltered.body as { id: string }[]).some((u) => u.id === viewerAdmin.id)).toBe(true)

    // Searching by the Super Admin's own exact email must not surface them either.
    const searched = await request(server).get(`/admin/users?q=${encodeURIComponent(superEmail)}`).set('Cookie', viewerCookie).expect(200)
    expect((searched.body as { id: string }[]).some((u) => u.id === superUser.id)).toBe(false)
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

  // PATCH /admin/users/:id/status is gated only by the grantable users.write
  // permission (unlike .../role, which has @Roles('SUPER_ADMIN') with no
  // permission escape hatch) — so a plain ADMIN holding that one routine
  // permission must still never be able to suspend/reactivate a SUPER_ADMIN
  // account. A SUPER_ADMIN acting on another SUPER_ADMIN is unaffected.
  it('a plain ADMIN holding users.write cannot suspend a SUPER_ADMIN, even directly via the API; a SUPER_ADMIN acting on another SUPER_ADMIN still can', async () => {
    const superEmail = uniqueEmail('protectedsuper')
    const superPassword = 'correct-horse-battery'
    const { user: targetSuper } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })

    // A second, distinct SUPER_ADMIN as the grantor/actor, so targetSuper's
    // own status is never touched just to set up the permission grant.
    const grantorEmail = uniqueEmail('grantor')
    const grantorPassword = 'correct-horse-battery'
    const { user: grantor } = await createUserDirect(prisma, { email: grantorEmail, password: grantorPassword, role: 'SUPER_ADMIN' })
    const grantorSecret = await enableTotpDirect(prisma, grantor.id)
    const grantorCookie = await loginCookie(server, grantorEmail, grantorPassword, grantorSecret)

    const weakAdminEmail = uniqueEmail('weakadmin')
    const weakAdminPassword = 'correct-horse-battery'
    const { user: weakAdmin } = await createUserDirect(prisma, { email: weakAdminEmail, password: weakAdminPassword, role: 'ADMIN' })
    await request(server)
      .patch(`/admin/admins/${weakAdmin.id}/permissions/users.write/grant`)
      .set('Cookie', grantorCookie)
      .send({ reason: 'test grant', confirmPassword: grantorPassword })
      .expect(200)
    const weakAdminCookie = await loginCookie(server, weakAdminEmail, weakAdminPassword)

    // Direct API attempt by the plain ADMIN — rejected, and the target's
    // status is left exactly as it was.
    const res = await request(server)
      .patch(`/admin/users/${targetSuper.id}/status`)
      .set('Cookie', weakAdminCookie)
      .send({ status: 'SUSPENDED', reason: 'attempted suspension' })
    expect(res.status).toBe(403)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: targetSuper.id } })).status).toBe('ACTIVE')

    // A genuine SUPER_ADMIN performing the same action on another SUPER_ADMIN succeeds.
    await request(server)
      .patch(`/admin/users/${targetSuper.id}/status`)
      .set('Cookie', grantorCookie)
      .send({ status: 'SUSPENDED', reason: 'legitimate super admin action' })
      .expect(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: targetSuper.id } })).status).toBe('SUSPENDED')
  })

  // "Create Super Admin" (POST /admin/admins/super-admin) — composes the
  // existing createAdmin + role-change actions into one call. This block
  // covers the full checklist for that feature: access control, the happy
  // path, non-interference with the existing Super Admin, visibility, and
  // every direct-API escalation attempt a plain ADMIN might try.
  describe('Create Super Admin (POST /admin/admins/super-admin)', () => {
    it('a plain ADMIN gets 403 attempting to create a Super Admin directly via the API — even holding admins.read and admins.manage', async () => {
      const superEmail = uniqueEmail('csasuper')
      const superPassword = 'correct-horse-battery'
      const { user: grantor } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const grantorSecret = await enableTotpDirect(prisma, grantor.id)
      const grantorCookie = await loginCookie(server, superEmail, superPassword, grantorSecret)

      const weakAdminEmail = uniqueEmail('csaweak')
      const weakAdminPassword = 'correct-horse-battery'
      const { user: weakAdmin } = await createUserDirect(prisma, { email: weakAdminEmail, password: weakAdminPassword, role: 'ADMIN' })
      for (const perm of ['admins.read', 'admins.manage']) {
        await request(server)
          .patch(`/admin/admins/${weakAdmin.id}/permissions/${perm}/grant`)
          .set('Cookie', grantorCookie)
          .send({ reason: 'test grant', confirmPassword: superPassword })
          .expect(200)
      }
      const weakAdminCookie = await loginCookie(server, weakAdminEmail, weakAdminPassword)

      const targetEmail = uniqueEmail('csanope')
      const res = await request(server)
        .post('/admin/admins/super-admin')
        .set('Cookie', weakAdminCookie)
        .send({ email: targetEmail, password: 'a-strong-password-12', reason: 'attempted self-escalation', confirmPassword: weakAdminPassword })
      expect(res.status).toBe(403)
      expect(await prisma.user.findUnique({ where: { email: targetEmail } })).toBeNull()
    })

    it('a customer (role USER) and an unauthenticated caller both get rejected', async () => {
      const customerPassword = 'correct-horse-battery'
      const { user: customer } = await createUserDirect(prisma, { email: uniqueEmail('csacust'), password: customerPassword, role: 'USER' })
      const customerCookie = await loginCookie(server, customer.email, customerPassword)
      await request(server).post('/admin/admins/super-admin').set('Cookie', customerCookie)
        .send({ email: uniqueEmail('x'), password: 'a-strong-password-12', reason: 'nope', confirmPassword: customerPassword }).expect(403)
      await request(server).post('/admin/admins/super-admin')
        .send({ email: uniqueEmail('x'), password: 'a-strong-password-12', reason: 'nope', confirmPassword: 'irrelevant' }).expect(401)
    })

    it('a SUPER_ADMIN can create a second Super Admin; the existing Super Admin is left completely unchanged; both are audited', async () => {
      const existingEmail = uniqueEmail('csaexisting')
      const existingPassword = 'correct-horse-battery'
      const { user: existingSuper } = await createUserDirect(prisma, { email: existingEmail, password: existingPassword, role: 'SUPER_ADMIN' })
      const existingSecret = await enableTotpDirect(prisma, existingSuper.id)
      const existingCookie = await loginCookie(server, existingEmail, existingPassword, existingSecret)
      const existingSnapshotBefore = await prisma.user.findUniqueOrThrow({ where: { id: existingSuper.id } })

      const newEmail = uniqueEmail('csanew')
      const res = await request(server)
        .post('/admin/admins/super-admin')
        .set('Cookie', existingCookie)
        .send({ email: newEmail, fullName: 'Second Super Admin', password: 'a-strong-password-12', reason: 'onboarding second super admin', confirmPassword: existingPassword })
        .expect(201)
      expect(res.body.role).toBe('SUPER_ADMIN')
      expect(res.body.email).toBe(newEmail)
      expect(res.body.passwordHash).toBeUndefined()

      const newUser = await prisma.user.findUniqueOrThrow({ where: { email: newEmail } })
      expect(newUser.role).toBe('SUPER_ADMIN')
      expect(newUser.status).toBe('ACTIVE')

      // The pre-existing Super Admin was never touched by this call.
      const existingSnapshotAfter = await prisma.user.findUniqueOrThrow({ where: { id: existingSuper.id } })
      expect(existingSnapshotAfter).toEqual(existingSnapshotBefore)

      // The new account can actually sign in as SUPER_ADMIN.
      const newCookie = await loginCookie(server, newEmail, 'a-strong-password-12')
      await request(server).get('/admin/admins').set('Cookie', newCookie).expect(200)

      // Audited: a USER_CREATED (from createAdmin) and a ROLE_CHANGED (from
      // the promotion) both exist for the new account, actor = existingSuper.
      const logs = await prisma.adminAction.findMany({ where: { targetUserId: newUser.id }, orderBy: { createdAt: 'asc' } })
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['USER_CREATED', 'ROLE_CHANGED']))
      expect(logs.every((l) => l.adminId === existingSuper.id)).toBe(true)
      expect(JSON.stringify(logs)).not.toMatch(/a-strong-password-12/) // the plaintext password is never persisted into the audit trail
    })

    it('step-up is still enforced: the wrong confirmPassword is rejected and no account is created', async () => {
      const password = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: uniqueEmail('csastepup'), password, role: 'SUPER_ADMIN' })
      const secret = await enableTotpDirect(prisma, superUser.id)
      const cookie = await loginCookie(server, superUser.email, password, secret)

      const targetEmail = uniqueEmail('csarejected')
      await request(server).post('/admin/admins/super-admin').set('Cookie', cookie)
        .send({ email: targetEmail, password: 'a-strong-password-12', reason: 'bad password test', confirmPassword: 'definitely-wrong' })
        .expect(401)
      expect(await prisma.user.findUnique({ where: { email: targetEmail } })).toBeNull()
    })

    it('the 12-character password minimum is not weakened for this endpoint', async () => {
      const email = uniqueEmail('csashortpw')
      const password = 'correct-horse-battery'
      const { user } = await createUserDirect(prisma, { email, password, role: 'SUPER_ADMIN' })
      const secret = await enableTotpDirect(prisma, user.id)
      const cookie = await loginCookie(server, email, password, secret)

      await request(server).post('/admin/admins/super-admin').set('Cookie', cookie)
        .send({ email: uniqueEmail('shortpw'), password: 'short1234', reason: 'too short', confirmPassword: password })
        .expect(400)
    })

    // Administrator Accounts (GET /admin/admins) — scoped to the
    // AUTHENTICATED caller's own account only, for every role. Not "every
    // administrator sees administrators of their own tier" — literally
    // exactly one row, always the caller's own, never another SUPER_ADMIN,
    // never another ADMIN, regardless of permissions held or how many
    // other administrators exist.
    it('a SUPER_ADMIN viewer sees ONLY their own row; a plain ADMIN viewer (even holding admins.read) sees ONLY their own row — never another administrator, of either role', async () => {
      const superEmail = uniqueEmail('listadminssuper')
      const superPassword = 'correct-horse-battery'
      const { user: grantor } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const grantorSecret = await enableTotpDirect(prisma, grantor.id)
      const grantorCookie = await loginCookie(server, superEmail, superPassword, grantorSecret)

      const otherSuperEmail = uniqueEmail('listadminsothersuper')
      const otherSuperPassword = 'correct-horse-battery'
      const { user: otherSuper } = await createUserDirect(prisma, { email: otherSuperEmail, password: otherSuperPassword, role: 'SUPER_ADMIN' })

      const plainAdminEmail = uniqueEmail('listadminsplain')
      const plainAdminPassword = 'correct-horse-battery'
      const { user: plainAdmin } = await createUserDirect(prisma, { email: plainAdminEmail, password: plainAdminPassword, role: 'ADMIN' })
      await request(server).patch(`/admin/admins/${plainAdmin.id}/permissions/admins.read/grant`).set('Cookie', grantorCookie)
        .send({ reason: 'test grant', confirmPassword: superPassword }).expect(200)
      const plainAdminCookie = await loginCookie(server, plainAdminEmail, plainAdminPassword)

      const otherAdminEmail = uniqueEmail('listadminsotherplain')
      const otherAdminPassword = 'correct-horse-battery'
      const { user: otherAdmin } = await createUserDirect(prisma, { email: otherAdminEmail, password: otherAdminPassword, role: 'ADMIN' })

      // SUPER_ADMIN viewer → exactly one row, their own.
      const asSuperAdmin = await request(server).get('/admin/admins').set('Cookie', grantorCookie).expect(200)
      expect(asSuperAdmin.body).toHaveLength(1)
      expect((asSuperAdmin.body as { id: string }[])[0].id).toBe(grantor.id)

      // Plain ADMIN viewer (holding admins.read) → exactly one row, their own —
      // never otherSuper, never otherAdmin, never grantor.
      const asPlainAdmin = await request(server).get('/admin/admins').set('Cookie', plainAdminCookie).expect(200)
      expect(asPlainAdmin.body).toHaveLength(1)
      expect((asPlainAdmin.body as { id: string }[])[0].id).toBe(plainAdmin.id)
      const planIds = (asPlainAdmin.body as { id: string }[]).map((a) => a.id)
      expect(planIds).not.toContain(otherSuper.id)
      expect(planIds).not.toContain(otherAdmin.id)
      expect(planIds).not.toContain(grantor.id)
    })

    // Section 4's "Access another SUPER_ADMIN's sensitive account
    // information" — GET /admin/users/:id (getUserDetail) is gated only by
    // the grantable users.read permission, so a plain ADMIN could otherwise
    // reach a Super Admin's balances/deposits/withdrawals directly by id,
    // even though listUsers() already keeps that id out of the list they'd
    // browse to find it. A SUPER_ADMIN viewer is unaffected.
    it('a plain ADMIN gets 403 on GET /admin/users/:id for a SUPER_ADMIN target, even holding users.read; a SUPER_ADMIN viewer can view it', async () => {
      const superEmail = uniqueEmail('userdetailsuper')
      const superPassword = 'correct-horse-battery'
      const { user: targetSuper } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, targetSuper.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

      const plainAdminEmail = uniqueEmail('userdetailplain')
      const plainAdminPassword = 'correct-horse-battery'
      const { user: plainAdmin } = await createUserDirect(prisma, { email: plainAdminEmail, password: plainAdminPassword, role: 'ADMIN' })
      await request(server).patch(`/admin/admins/${plainAdmin.id}/permissions/users.read/grant`).set('Cookie', superCookie)
        .send({ reason: 'test grant', confirmPassword: superPassword }).expect(200)
      const plainAdminCookie = await loginCookie(server, plainAdminEmail, plainAdminPassword)

      await request(server).get(`/admin/users/${targetSuper.id}`).set('Cookie', plainAdminCookie).expect(403)
      await request(server).get(`/admin/users/${targetSuper.id}`).set('Cookie', superCookie).expect(200)
    })

    // Direct-API confirmation that no permission combination lets an ADMIN
    // retrieve ANY other administrator — Super Admin or otherwise — through
    // this endpoint: the service query itself never includes anyone but the
    // caller's own id, regardless of what's granted.
    it('an ADMIN cannot retrieve any other administrator (Super Admin or ADMIN) through GET /admin/admins by any direct API means', async () => {
      const superEmail = uniqueEmail('listadminsnobypass')
      const superPassword = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, superUser.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

      const plainAdminEmail = uniqueEmail('listadminsnobypass2')
      const plainAdminPassword = 'correct-horse-battery'
      const { user: plainAdmin } = await createUserDirect(prisma, { email: plainAdminEmail, password: plainAdminPassword, role: 'ADMIN' })
      for (const perm of ['admins.read', 'admins.manage', 'users.read']) {
        await request(server).patch(`/admin/admins/${plainAdmin.id}/permissions/${perm}/grant`).set('Cookie', superCookie)
          .send({ reason: 'test grant', confirmPassword: superPassword }).expect(200)
      }
      const plainAdminCookie = await loginCookie(server, plainAdminEmail, plainAdminPassword)

      const res = await request(server).get('/admin/admins').set('Cookie', plainAdminCookie).expect(200)
      expect(res.body).toHaveLength(1)
      expect((res.body as { id: string }[])[0].id).toBe(plainAdmin.id)
    })

    it('a plain ADMIN cannot promote OR demote a different, already-existing SUPER_ADMIN through the generic role-change API', async () => {
      const targetEmail = uniqueEmail('roletargetsuper')
      const targetPassword = 'correct-horse-battery'
      const { user: targetSuper } = await createUserDirect(prisma, { email: targetEmail, password: targetPassword, role: 'SUPER_ADMIN' })

      const weakAdminEmail = uniqueEmail('roleweakadmin')
      const weakAdminPassword = 'correct-horse-battery'
      const { user: weakAdmin } = await createUserDirect(prisma, { email: weakAdminEmail, password: weakAdminPassword, role: 'ADMIN' })
      const weakAdminCookie = await loginCookie(server, weakAdminEmail, weakAdminPassword)

      // Attempted demotion of someone ELSE's Super Admin status.
      await request(server).patch(`/admin/users/${targetSuper.id}/role`).set('Cookie', weakAdminCookie)
        .send({ role: 'ADMIN', reason: 'attempted demotion', confirmPassword: weakAdminPassword }).expect(403)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: targetSuper.id } })).role).toBe('SUPER_ADMIN')

      // Attempted promotion of its own account.
      await request(server).patch(`/admin/users/${weakAdmin.id}/role`).set('Cookie', weakAdminCookie)
        .send({ role: 'SUPER_ADMIN', reason: 'attempted self-promotion', confirmPassword: weakAdminPassword }).expect(403)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: weakAdmin.id } })).role).toBe('ADMIN')
    })
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

  // "Grant the complete normal ADMIN permission set" — verifies, against the
  // real permission system (no new code, no bulk endpoint), that granting
  // every single key in PERMISSIONS to one ADMIN account (a) unlocks the
  // full normal operational surface, (b) never unlocks anything
  // SUPER_ADMIN-only — because those actions are @Roles('SUPER_ADMIN')
  // route guards with no permission key at all, not something any amount of
  // granting can reach — and (c) leaves the existing SUPER_ADMIN and the
  // Administrator Accounts visibility rule untouched.
  describe('granting the complete PERMISSIONS set to one ADMIN', () => {
    it('unlocks every normal ADMIN-operational route while every SUPER_ADMIN-only route stays 403, the grant is fully audited, and the existing Super Admin is unaffected', async () => {
      const { PERMISSIONS } = await import('../src/common/permissions')

      const superEmail = uniqueEmail('fullsetsuper')
      const superPassword = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, superUser.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)
      const superSnapshotBefore = await prisma.user.findUniqueOrThrow({ where: { id: superUser.id } })

      const targetEmail = uniqueEmail('fullsetadmin')
      const targetPassword = 'correct-horse-battery'
      const { user: target } = await createUserDirect(prisma, { email: targetEmail, password: targetPassword, role: 'ADMIN' })

      // Grant every defined permission — one call per key, exactly the
      // existing single-permission endpoint the real admin panel uses.
      for (const key of PERMISSIONS) {
        await request(server)
          .patch(`/admin/admins/${target.id}/permissions/${key}/grant`)
          .set('Cookie', superCookie)
          .send({ reason: 'grant full normal ADMIN permission set', confirmPassword: superPassword })
          .expect(200)
      }

      const targetCookie = await loginCookie(server, targetEmail, targetPassword)

      // A representative ADMIN-operational route per permission domain now succeeds.
      await request(server).get('/admin/overview').set('Cookie', targetCookie).expect(200) // platform.read
      await request(server).get('/admin/users').set('Cookie', targetCookie).expect(200) // users.read
      await request(server).get('/admin/deposits').set('Cookie', targetCookie).expect(200) // deposits.read
      await request(server).get('/admin/withdrawals').set('Cookie', targetCookie).expect(200) // withdrawals.read
      await request(server).get('/admin/kyc/submissions').set('Cookie', targetCookie).expect(200) // kyc.read
      await request(server).get('/admin/audit-logs').set('Cookie', targetCookie).expect(200) // audit.read
      await request(server).get('/admin/crypto-deposits/assets').set('Cookie', targetCookie).expect(200) // crypto_deposits.read
      await request(server).get('/admin/contacts').set('Cookie', targetCookie).expect(200) // admin_contacts.read
      await request(server).get('/admin/cms/pages').set('Cookie', targetCookie).expect(200) // cms.pages.read
      await request(server).get('/admin/support/tickets').set('Cookie', targetCookie).expect(200) // support.tickets.read

      // Every SUPER_ADMIN-only action stays 403 — role guards, not permissions,
      // are what gate these, so no grant could ever reach them.
      await request(server).post('/admin/admins/super-admin').set('Cookie', targetCookie)
        .send({ email: uniqueEmail('shouldnotexist'), password: 'a-strong-password-12', reason: 'escalation attempt', confirmPassword: targetPassword })
        .expect(403)
      await request(server).patch(`/admin/users/${target.id}/role`).set('Cookie', targetCookie)
        .send({ role: 'SUPER_ADMIN', reason: 'self-promote attempt', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/admins/${superUser.id}/reset-password`).set('Cookie', targetCookie)
        .send({ newPassword: 'a-strong-password-12', reason: 'attempt', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/admins/${superUser.id}/permissions/users.read/revoke`).set('Cookie', targetCookie)
        .send({ reason: 'attempt', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/users/${superUser.id}/status`).set('Cookie', targetCookie)
        .send({ status: 'SUSPENDED', reason: 'attempt' }).expect(403)
      await request(server).get(`/admin/users/${superUser.id}`).set('Cookie', targetCookie).expect(403)

      // The existing Super Admin account itself was never touched.
      expect(await prisma.user.findUniqueOrThrow({ where: { id: superUser.id } })).toEqual(superSnapshotBefore)

      // Fully audited: one PERMISSION_CHANGED AdminAction per granted key, actor = the granting Super Admin.
      const logs = await prisma.adminAction.findMany({ where: { targetUserId: target.id, action: 'PERMISSION_CHANGED' } })
      expect(logs.length).toBe(PERMISSIONS.length)
      expect(logs.every((l) => l.adminId === superUser.id)).toBe(true)

      // Still role ADMIN, never promoted by any of this.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ADMIN')
    })
  })

  // PATCH /admin/admins/permissions/grant-all — the "Grant All ADMIN
  // Permissions" bulk convenience itself (as opposed to the test above,
  // which proved the underlying per-key grant mechanism scales to the full
  // set; this proves the new single endpoint built on top of it).
  describe('PATCH /admin/admins/permissions/grant-all (bulk grant)', () => {
    it('a SUPER_ADMIN can bulk-grant; the target gets exactly all 55 current PERMISSIONS, remains ADMIN, and every SUPER_ADMIN-only endpoint stays 403 for it', async () => {
      const { PERMISSIONS } = await import('../src/common/permissions')

      const superEmail = uniqueEmail('bulkgrantsuper')
      const superPassword = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, superUser.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

      const targetEmail = uniqueEmail('bulkgranttarget')
      const targetPassword = 'correct-horse-battery'
      const { user: target } = await createUserDirect(prisma, { email: targetEmail, password: targetPassword, role: 'ADMIN' })

      await request(server)
        .patch('/admin/admins/permissions/grant-all')
        .set('Cookie', superCookie)
        .send({ email: targetEmail, reason: 'onboarding full admin access', confirmPassword: superPassword })
        .expect(200)

      const granted = await prisma.userPermission.findMany({ where: { userId: target.id }, include: { permission: true } })
      expect(granted.map((g) => g.permission.key).sort()).toEqual([...PERMISSIONS].sort())
      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ADMIN')

      const targetCookie = await loginCookie(server, targetEmail, targetPassword)
      await request(server).post('/admin/admins/super-admin').set('Cookie', targetCookie)
        .send({ email: uniqueEmail('shouldnotexist'), password: 'a-strong-password-12', reason: 'test reason', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/users/${target.id}/role`).set('Cookie', targetCookie)
        .send({ role: 'SUPER_ADMIN', reason: 'test reason', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/admins/${superUser.id}/reset-password`).set('Cookie', targetCookie)
        .send({ newPassword: 'a-strong-password-12', reason: 'test reason', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/admins/${superUser.id}/permissions/users.read/revoke`).set('Cookie', targetCookie)
        .send({ reason: 'test reason', confirmPassword: targetPassword }).expect(403)
      await request(server).patch(`/admin/users/${superUser.id}/status`).set('Cookie', targetCookie)
        .send({ status: 'SUSPENDED', reason: 'test reason' }).expect(403)

      // Fully audited: one PERMISSION_CHANGED row per key, correct actor/target/reason.
      const logs = await prisma.adminAction.findMany({ where: { targetUserId: target.id, action: 'PERMISSION_CHANGED' } })
      expect(logs.length).toBe(PERMISSIONS.length)
      expect(logs.every((l) => l.adminId === superUser.id)).toBe(true)
      expect(logs.every((l) => l.reason === 'onboarding full admin access')).toBe(true)
      expect(logs.every((l) => l.createdAt instanceof Date)).toBe(true)
      expect(JSON.stringify(logs)).not.toMatch(/correct-horse-battery/)
    })

    it('a plain ADMIN gets 403 attempting the bulk grant directly, even holding admins.read/admins.manage; a customer (USER) gets 403 too', async () => {
      const superEmail = uniqueEmail('bulkgrantblocksuper')
      const superPassword = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, superUser.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

      const actorEmail = uniqueEmail('bulkgrantactor')
      const actorPassword = 'correct-horse-battery'
      const { user: actor } = await createUserDirect(prisma, { email: actorEmail, password: actorPassword, role: 'ADMIN' })
      for (const perm of ['admins.read', 'admins.manage']) {
        await request(server).patch(`/admin/admins/${actor.id}/permissions/${perm}/grant`).set('Cookie', superCookie)
          .send({ reason: 'test grant', confirmPassword: superPassword }).expect(200)
      }
      const actorCookie = await loginCookie(server, actorEmail, actorPassword)

      const victimEmail = uniqueEmail('bulkgrantvictim')
      const { user: victim } = await createUserDirect(prisma, { email: victimEmail, password: 'correct-horse-battery', role: 'ADMIN' })

      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', actorCookie)
        .send({ email: victimEmail, reason: 'escalation attempt', confirmPassword: actorPassword }).expect(403)
      expect(await prisma.userPermission.count({ where: { userId: victim.id } })).toBe(0)

      const customerEmail = uniqueEmail('bulkgrantcustomer')
      const customerPassword = 'correct-horse-battery'
      await createUserDirect(prisma, { email: customerEmail, password: customerPassword, role: 'USER' })
      const customerCookie = await loginCookie(server, customerEmail, customerPassword)
      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', customerCookie)
        .send({ email: victimEmail, reason: 'escalation attempt', confirmPassword: customerPassword }).expect(403)

      await request(server).patch('/admin/admins/permissions/grant-all')
        .send({ email: victimEmail, reason: 'escalation attempt', confirmPassword: 'irrelevant' }).expect(401)
    })

    it('cannot target a SUPER_ADMIN or a plain USER, and does not create duplicate grants/audit rows for permissions the target already holds', async () => {
      const superEmail = uniqueEmail('bulkgrantedge')
      const superPassword = 'correct-horse-battery'
      const { user: superUser } = await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
      const superSecret = await enableTotpDirect(prisma, superUser.id)
      const superCookie = await loginCookie(server, superEmail, superPassword, superSecret)

      // Target is SUPER_ADMIN — refused.
      const otherSuperEmail = uniqueEmail('bulkgrantothersuper')
      await createUserDirect(prisma, { email: otherSuperEmail, password: 'correct-horse-battery', role: 'SUPER_ADMIN' })
      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', superCookie)
        .send({ email: otherSuperEmail, reason: 'test reason', confirmPassword: superPassword }).expect(400)

      // Target is a plain USER — refused.
      const customerEmail = uniqueEmail('bulkgrantcustomer2')
      await createUserDirect(prisma, { email: customerEmail, password: 'correct-horse-battery', role: 'USER' })
      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', superCookie)
        .send({ email: customerEmail, reason: 'test reason', confirmPassword: superPassword }).expect(400)

      // Target doesn't exist — refused.
      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', superCookie)
        .send({ email: uniqueEmail('doesnotexist'), reason: 'test reason', confirmPassword: superPassword }).expect(400)

      // No duplicate: an ADMIN who already holds a couple of permissions gets
      // the rest via bulk grant, with no new audit row for the ones it
      // already had.
      const targetEmail = uniqueEmail('bulkgrantpartial')
      const { user: target } = await createUserDirect(prisma, { email: targetEmail, password: 'correct-horse-battery', role: 'ADMIN' })
      await request(server).patch(`/admin/admins/${target.id}/permissions/users.read/grant`).set('Cookie', superCookie)
        .send({ reason: 'pre-existing grant', confirmPassword: superPassword }).expect(200)

      const { PERMISSIONS } = await import('../src/common/permissions')
      await request(server).patch('/admin/admins/permissions/grant-all').set('Cookie', superCookie)
        .send({ email: targetEmail, reason: 'bulk after partial', confirmPassword: superPassword }).expect(200)

      const finalPerms = await prisma.userPermission.findMany({ where: { userId: target.id } })
      expect(finalPerms.length).toBe(PERMISSIONS.length) // no duplicates — one row per key, not two for users.read

      const usersReadLogs = await prisma.adminAction.findMany({
        where: { targetUserId: target.id, action: 'PERMISSION_CHANGED' },
      })
      const usersReadGrantCount = usersReadLogs.filter((l) => (l.newState as { permission?: string } | null)?.permission === 'users.read').length
      expect(usersReadGrantCount).toBe(1) // only the original pre-existing grant — bulk grant did not re-grant/re-audit it
    })
  })
})
