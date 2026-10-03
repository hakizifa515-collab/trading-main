// Admin Management — the existing permission-grant list (ported unchanged
// from the old AdminsTab) plus Add Admin and Reset Password, both wired to
// backend endpoints that already existed but had no frontend before this
// page (createAdmin/resetAdminPassword, both SUPER_ADMIN + step-up gated).
//
// "Delete" (per the reference spec) is implemented as account suspension,
// NOT a hard delete — the backend has no admin-delete endpoint (deleting a
// user with ledger/audit history would be unsafe), and AdminService's own
// comment on updateUserStatus documents this exact mapping. The button is
// labeled Suspend/Reactivate rather than "Delete" so it's never presented
// as anything other than what it actually does. Suspension is real,
// immediate (revokes login), safe, and audit-logged.
import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, UserCog, UserX } from 'lucide-react'
import type { User } from '../../types'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../store/auth'
import { useToast } from '../../components/Toast'
import { StepUpModal } from '../../components/StepUpModal'
import { AdminPageHeader, AdminPanel, AdminTable, AdminStatusBadge, useAdmin, tryAction } from '../../components/admin'

interface AdminRow extends User { permissions: string[] }

const PERMISSIONS = [
  'users.read', 'users.write', 'kyc.read', 'kyc.review', 'deposits.read', 'deposits.review',
  'crypto_deposits.read', 'crypto_deposits.control',
  'withdrawals.read', 'withdrawals.review', 'trading.read', 'trading.control', 'markets.read',
  'markets.control', 'options.read', 'options.control', 'ledger.read', 'ledger.adjust', 'audit.read',
  'platform.read', 'platform.control', 'admins.read', 'admins.manage', 'admin_contacts.read', 'admin_contacts.control',
  // Support (Role Separation) — support.tickets.reply/internal_note already
  // existed and were previously ungrantable through this page (only
  // reachable via a raw API call); listed here now so a Super Admin can
  // actually delegate day-to-day Support work through the UI.
  'support.tickets.read', 'support.tickets.assign', 'support.tickets.update', 'support.tickets.reply',
  'support.tickets.internal_note', 'support.tickets.resolve', 'support.tickets.close', 'support.categories.manage',
  // Editing a message you sent — a normal grantable permission (message
  // DELETION remains SUPER_ADMIN only by role, with no permission able to
  // reach it; see AdminSupportController.deleteMessage()).
  'support.messages.edit',
  // Cross-ticket moderation feed — SUPER_ADMIN has it for free; ungranted by
  // default for a plain ADMIN, same as every permission above.
  'support.audit',
] as const

export function AdminManagementPage() {
  const { user: viewer } = useAuth()
  const { push } = useToast()
  const { data, loading, error, refetch } = useAdmin<AdminRow[]>('/admin/admins')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<{ admin: AdminRow; permission: string; grant: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingSuperAdmin, setCreatingSuperAdmin] = useState(false)
  const [grantingAll, setGrantingAll] = useState(false)
  const [resetting, setResetting] = useState<AdminRow | null>(null)
  const [suspending, setSuspending] = useState<AdminRow | null>(null)
  const [suspendBusy, setSuspendBusy] = useState(false)

  async function toggleSuspend(a: AdminRow) {
    const nextStatus = a.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED'
    setSuspendBusy(true)
    const res = await tryAction(() => api.patch(`/admin/users/${a.id}/status`, { status: nextStatus, reason: `${nextStatus === 'SUSPENDED' ? 'Suspended' : 'Reactivated'} via Admin Management` }))
    setSuspendBusy(false)
    if (res.ok) { push('success', `${a.email} is now ${nextStatus}.`); setSuspending(null); refetch() }
    else push('error', res.error)
  }

  return (
    <div>
      <AdminPageHeader
        icon={UserCog}
        title="Administrator Accounts"
        description="Manage administrator accounts, passwords, and permissions."
        back={{ to: '/admin' }}
        actions={
          <div className="flex gap-2">
            <button onClick={() => setCreating(true)} className="admin-btn-success">+ Add Admin</button>
            {/* Server-side enforced (POST /admin/admins/super-admin is
                @Roles('SUPER_ADMIN') only) — this client-side check is a
                UX nicety only, so a plain ADMIN who reached this page via a
                granted admins.read permission never sees a control that
                would just 403 for them. */}
            {viewer?.role === 'SUPER_ADMIN' && (
              <button onClick={() => setCreatingSuperAdmin(true)} className="admin-btn-primary">+ Create Super Admin</button>
            )}
            {/* Server-side enforced (PATCH /admin/admins/permissions/grant-all
                is @Roles('SUPER_ADMIN') only). Administrator Accounts below
                only ever shows the signed-in viewer's own row now, so this
                targets an account by email instead of by clicking a row. */}
            {viewer?.role === 'SUPER_ADMIN' && (
              <button onClick={() => setGrantingAll(true)} className="admin-btn-info">Grant All ADMIN Permissions</button>
            )}
          </div>
        }
      />

      <AdminPanel loading={loading} error={error} refetch={refetch}>
        <AdminTable>
          <thead>
            <tr className="border-b border-admin-border bg-admin-surface text-left text-[11px] uppercase tracking-wide text-admin-mutedDim">
              <th className="w-8 px-2 py-2.5"></th>
              <th className="px-4 py-2.5 font-medium">ID</th>
              <th className="px-4 py-2.5 font-medium">Username</th>
              <th className="px-4 py-2.5 font-medium">Password</th>
              <th className="px-4 py-2.5 font-medium">Role / Status</th>
              <th className="px-4 py-2.5 font-medium">Created</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((a) => (
              <Fragment key={a.id}>
                <tr className="border-b border-admin-border/60 hover:bg-admin-surface/50">
                  <td className="px-2 py-2.5">
                    {a.role !== 'SUPER_ADMIN' && (
                      <button onClick={() => setExpanded(expanded === a.id ? null : a.id)} className="text-admin-mutedDim hover:text-admin-text" aria-label="Toggle permissions">
                        {expanded === a.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-admin-mutedDim">{a.id.slice(0, 8)}</td>
                  <td className="px-4 py-2.5 text-admin-text">{a.email}</td>
                  <td className="px-4 py-2.5 font-mono tracking-widest text-admin-mutedDim" title="Passwords are never displayed — hashed and never readable, even by other admins">••••••••</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <AdminStatusBadge tone="info">{a.role}</AdminStatusBadge>
                      <AdminStatusBadge tone={a.status === 'ACTIVE' ? 'success' : 'danger'}>{a.status}</AdminStatusBadge>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-admin-muted">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2.5 text-right">
                    {a.role !== 'SUPER_ADMIN' && (
                      <div className="flex justify-end gap-1.5">
                        <button onClick={() => setResetting(a)} className="admin-btn-info px-2.5 py-1.5 text-[11px]">Change Password</button>
                        <button
                          onClick={() => setSuspending(a)}
                          disabled={a.id === viewer?.id}
                          title={a.id === viewer?.id ? 'You cannot suspend your own account.' : undefined}
                          className="admin-btn-danger px-2.5 py-1.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <UserX className="h-3 w-3" /> {a.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {expanded === a.id && a.role !== 'SUPER_ADMIN' && (
                  <tr className="border-b border-admin-border/60 bg-admin-bg2">
                    <td colSpan={7} className="px-4 py-3">
                      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-admin-mutedDim">Permissions</p>
                      <div className="flex flex-wrap gap-1.5">
                        {PERMISSIONS.map((p) => {
                          const granted = a.permissions.includes(p)
                          return (
                            <button
                              key={p}
                              onClick={() => setPending({ admin: a, permission: p, grant: !granted })}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${granted ? 'border-bull/30 bg-bull/10 text-bull' : 'border-admin-border text-admin-mutedDim hover:border-admin-borderLight'}`}
                            >
                              {p}
                            </button>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </AdminTable>
      </AdminPanel>

      {pending && (
        <StepUpModal
          title={`${pending.grant ? 'Grant' : 'Revoke'} ${pending.permission}`}
          description={`${pending.grant ? 'Granting' : 'Revoking'} a permission for ${pending.admin.email} requires SUPER_ADMIN + step-up re-authentication.`}
          onConfirm={async ({ reason, confirmPassword }) => {
            const action = pending.grant ? 'grant' : 'revoke'
            const res = await tryAction(() => api.patch(`/admin/admins/${pending.admin.id}/permissions/${pending.permission}/${action}`, { reason, confirmPassword }))
            if (res.ok) { push('success', `Permission ${action}ed.`); setPending(null); refetch() }
            else throw new ApiError(0, res.error, null)
          }}
          onClose={() => setPending(null)}
        />
      )}

      {creating && (
        <AddAdminModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refetch() }} />
      )}

      {creatingSuperAdmin && (
        <CreateSuperAdminModal onClose={() => setCreatingSuperAdmin(false)} onCreated={() => { setCreatingSuperAdmin(false); refetch() }} />
      )}

      {grantingAll && (
        <GrantAllPermissionsModal onClose={() => setGrantingAll(false)} onDone={() => setGrantingAll(false)} />
      )}

      {resetting && (
        <ResetPasswordModal admin={resetting} onClose={() => setResetting(null)} onDone={() => setResetting(null)} />
      )}

      {suspending && (
        <ConfirmSuspendDialog
          admin={suspending}
          busy={suspendBusy}
          onConfirm={() => toggleSuspend(suspending)}
          onClose={() => setSuspending(null)}
        />
      )}
    </div>
  )
}

function AddAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')

  return (
    <StepUpModal
      title="Add a new administrator"
      description="Creates a new ADMIN account (never SUPER_ADMIN) with the password set below. Requires SUPER_ADMIN + step-up re-authentication."
      onConfirm={async ({ reason, confirmPassword }) => {
        if (!email.trim() || password.length < 12) throw new ApiError(0, 'Enter a valid email and a password of at least 12 characters.', null)
        const res = await tryAction(() => api.post('/admin/admins', { email: email.trim(), fullName: fullName.trim() || undefined, password, reason, confirmPassword }))
        if (res.ok) { push('success', 'Administrator created.'); onCreated() }
        else throw new ApiError(0, res.error, null)
      }}
      onClose={onClose}
    >
      <div><label className="admin-label">Email</label><input className="admin-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div><label className="admin-label">Full name (optional)</label><input className="admin-input" value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
      <div><label className="admin-label">Initial password (min. 12 characters)</label><input className="admin-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
    </StepUpModal>
  )
}

// Creates a brand-new account AND promotes it to SUPER_ADMIN in one step —
// backed by POST /admin/admins/super-admin, which itself just composes the
// existing createAdmin + role-change actions server-side (see
// AdminService.createSuperAdmin). Same StepUpModal pattern as every other
// sensitive action on this page — the server, not this confirmation UI, is
// what actually enforces SUPER_ADMIN-only + re-authenticated access.
function CreateSuperAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')

  return (
    <StepUpModal
      title="Create a second Super Admin"
      description="You are about to grant SUPER_ADMIN privileges to a new account. This gives the account platform-owner-level administrative access, equal to your own. Requires step-up re-authentication."
      onConfirm={async ({ reason, confirmPassword }) => {
        if (!email.trim() || password.length < 12) throw new ApiError(0, 'Enter a valid email and a password of at least 12 characters.', null)
        const res = await tryAction(() => api.post('/admin/admins/super-admin', { email: email.trim(), fullName: fullName.trim() || undefined, password, reason, confirmPassword }))
        if (res.ok) { push('success', 'Second Super Admin created.'); onCreated() }
        else throw new ApiError(0, res.error, null)
      }}
      onClose={onClose}
    >
      <div><label className="admin-label">Email</label><input className="admin-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div><label className="admin-label">Full name (optional)</label><input className="admin-input" value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
      <div><label className="admin-label">Initial password (min. 12 characters)</label><input className="admin-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
    </StepUpModal>
  )
}

// Bulk-grants every currently-defined permission to one existing ADMIN
// account in a single step-up-confirmed call — backed by
// PATCH /admin/admins/permissions/grant-all (AdminService.grantAllAdminPermissions),
// which itself just loops over the same single-permission grant the
// per-row expandable panel above already used. Targets by email since
// Administrator Accounts no longer lists any account but the viewer's own.
function GrantAllPermissionsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { push } = useToast()
  const [email, setEmail] = useState('')

  return (
    <StepUpModal
      title="Grant All ADMIN Permissions"
      description="Grants every currently-defined permission to an existing ADMIN account (never SUPER_ADMIN, and never changes its role). Requires step-up re-authentication."
      onConfirm={async ({ reason, confirmPassword }) => {
        if (!email.trim()) throw new ApiError(0, 'Enter the target administrator\'s email.', null)
        const res = await tryAction(() => api.patch('/admin/admins/permissions/grant-all', { email: email.trim(), reason, confirmPassword }))
        if (res.ok) { push('success', 'All permissions granted.'); onDone() }
        else throw new ApiError(0, res.error, null)
      }}
      onClose={onClose}
    >
      <div><label className="admin-label">Administrator's email (must already be role ADMIN)</label><input className="admin-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
    </StepUpModal>
  )
}

function ResetPasswordModal({ admin, onClose, onDone }: { admin: AdminRow; onClose: () => void; onDone: () => void }) {
  const { push } = useToast()
  const [newPassword, setNewPassword] = useState('')

  return (
    <StepUpModal
      title={`Change password — ${admin.email}`}
      description="This immediately revokes every active session for this account. Requires SUPER_ADMIN + step-up re-authentication."
      onConfirm={async ({ reason, confirmPassword }) => {
        if (newPassword.length < 12) throw new ApiError(0, 'New password must be at least 12 characters.', null)
        const res = await tryAction(() => api.patch(`/admin/admins/${admin.id}/reset-password`, { newPassword, reason, confirmPassword }))
        if (res.ok) { push('success', 'Password changed — all sessions revoked.'); onDone() }
        else throw new ApiError(0, res.error, null)
      }}
      onClose={onClose}
    >
      <div><label className="admin-label">New password (min. 12 characters)</label><input className="admin-input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
    </StepUpModal>
  )
}

function ConfirmSuspendDialog({ admin, busy, onConfirm, onClose }: { admin: AdminRow; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const reactivating = admin.status === 'SUSPENDED'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="admin-card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-admin-text">{reactivating ? 'Reactivate' : 'Suspend'} {admin.email}?</h3>
        <p className="mt-2 text-sm text-admin-muted">
          {reactivating
            ? 'This restores login access for this administrator account.'
            : 'This immediately blocks login for this administrator account. No data is deleted — this can be reversed by reactivating the account.'}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="admin-btn-secondary">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className={reactivating ? 'admin-btn-success' : 'admin-btn-danger'}>{busy ? 'Working…' : reactivating ? 'Reactivate' : 'Suspend'}</button>
        </div>
      </div>
    </div>
  )
}
