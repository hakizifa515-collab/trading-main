// Support Audit — a read-only, cross-ticket moderation feed (Role
// Separation). Reachable by SUPER_ADMIN with no explicit grant, and by an
// ADMIN only once a Super Admin grants the support.audit permission via the
// existing Admin Management page — same honest-403 pattern as every other
// admin page in this app (AdminPanel below shows the real backend error
// rather than the nav item being hidden; see AdminPanel's own comment on why
// that's the deliberate design). Unlike the ordinary Support page (one
// ticket at a time, PUBLIC messages only, your own working queue), this
// shows every ticket's full history — PUBLIC and INTERNAL — plus the
// message-edit trail, for investigating a specific conversation or agent.
// This page also hosts the one moderation-action it needs: deleting an
// individual message (SUPER_ADMIN only). User suspension still lives on
// Admin Management — this stays scoped to message-level review + deletion.
// The delete button is gated client-side on role too (not just relying on
// the backend 403), matching the same "no dead controls for the wrong role"
// convention as message editing on the ordinary Support page — the backend
// route (@Roles('SUPER_ADMIN') on AdminSupportController.deleteMessage) is
// the actual, non-bypassable authorization; this is purely UX.
import { useState } from 'react'
import { Eye, Paperclip, Trash2 } from 'lucide-react'
import type { SupportMessageVisibility } from '../../types'
import { attachmentUrl, api } from '../../lib/api'
import { useAuth } from '../../store/auth'
import { useToast } from '../../components/Toast'
import { AdminPageHeader, AdminPanel, AdminTable, AdminTableHead, AdminEmptyState, AdminStatusBadge, useAdmin, tryAction } from '../../components/admin'

interface AuditMessage {
  id: string
  body: string
  visibility: SupportMessageVisibility
  createdAt: string
  deletedAt: string | null
  deletedByAdminId: string | null
  author: { id: string; email: string; fullName: string; role: string } | null
  attachments: { id: string; filename: string }[]
  ticket: { id: string; subject: string; status: string; userId: string; user: { id: string; email: string; fullName: string } | null }
}

interface AuditEditEvent {
  id: string
  createdAt: string
  actor: { id: string; email: string; fullName: string } | null
  targetId: string
  reason: string | null
  previousState: { body?: string } | null
  newState: { body?: string } | null
  metadata: { ticketId?: string; visibility?: string } | null
}

interface AuditDeleteEvent {
  id: string
  createdAt: string
  actor: { id: string; email: string; fullName: string } | null
  targetId: string
  reason: string | null
  previousState: { body?: string } | null
  metadata: { ticketId?: string; senderId?: string; senderType?: string } | null
}

interface AuditFeed {
  messages: AuditMessage[]
  editHistory: AuditEditEvent[]
  deleteHistory: AuditDeleteEvent[]
}

export function SupportAuditPage() {
  const { user: currentUser } = useAuth()
  const { push } = useToast()
  const { data, loading, error, refetch } = useAdmin<AuditFeed>('/admin/support/audit?limit=150')
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AuditMessage | null>(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [deleting, setDeleting] = useState(false)

  const canDelete = currentUser?.role === 'SUPER_ADMIN'

  const messages = (data?.messages ?? []).filter((m) => {
    if (!query.trim()) return true
    const q = query.trim().toLowerCase()
    return m.body.toLowerCase().includes(q) || m.author?.email.toLowerCase().includes(q) || m.ticket.user?.email.toLowerCase().includes(q) || m.ticket.subject.toLowerCase().includes(q)
  })

  function openDelete(m: AuditMessage) {
    setDeleteReason('')
    setDeleteTarget(m)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    if (deleteReason.trim().length < 3) { push('error', 'Enter a reason of at least 3 characters.'); return }
    setDeleting(true)
    const res = await tryAction(() =>
      api.del(`/admin/support/tickets/${deleteTarget.ticket.id}/messages/${deleteTarget.id}`, { reason: deleteReason.trim() })
    )
    setDeleting(false)
    if (res.ok) { push('success', 'Message deleted.'); setDeleteTarget(null); refetch() }
    else push('error', res.error)
  }

  return (
    <div>
      <AdminPageHeader
        icon={Eye}
        title="Support Audit"
        description="Every ticket's full message history (public and internal), for investigation and accountability. Super Admin only, unless explicitly granted."
        back={{ to: '/admin' }}
      />

      <AdminPanel loading={loading} error={error} refetch={refetch}>
        <div className="admin-card mb-4 p-3">
          <input
            className="admin-input w-full"
            placeholder="Search by message text, customer email, agent email, or ticket subject…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-admin-gold">Messages ({messages.length})</h3>
        {messages.length === 0 ? (
          <AdminEmptyState icon={Eye} title="No messages match" />
        ) : (
          <AdminTable>
            <AdminTableHead columns={[
              { label: 'Time' }, { label: 'Ticket' }, { label: 'Customer' }, { label: 'Author' }, { label: 'Visibility' }, { label: 'Message' }, { label: '' },
            ]} />
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-b border-admin-border/60 align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-admin-mutedDim">{new Date(m.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-admin-muted" title={m.ticket.id}>{m.ticket.subject}</td>
                  <td className="px-4 py-2.5 text-admin-muted">{m.ticket.user?.fullName ?? m.ticket.user?.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-admin-muted">{m.author ? `${m.author.fullName} (${m.author.role})` : '—'}</td>
                  <td className="px-4 py-2.5">
                    <AdminStatusBadge tone={m.visibility === 'INTERNAL' ? 'warning' : 'neutral'}>{m.visibility}</AdminStatusBadge>
                  </td>
                  <td className="max-w-md px-4 py-2.5 text-admin-text">
                    {m.deletedAt ? (
                      <div className="flex items-center gap-2">
                        <AdminStatusBadge tone="danger">DELETED</AdminStatusBadge>
                        <p className="whitespace-pre-wrap break-words text-admin-mutedDim line-through opacity-70">{m.body}</p>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {m.attachments.map((a) => (
                          <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-admin-mutedDim hover:text-admin-text">
                            <Paperclip className="h-3 w-3" /> {a.filename}
                          </a>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {canDelete && !m.deletedAt && (
                      <button
                        onClick={() => openDelete(m)}
                        title="Delete message"
                        aria-label="Delete message"
                        className="admin-btn-secondary !p-1.5 text-bear hover:text-bear"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}

        <h3 className="mb-1.5 mt-6 text-[11px] font-bold uppercase tracking-wide text-admin-gold">Message Edit History ({(data?.editHistory ?? []).length})</h3>
        {(data?.editHistory ?? []).length === 0 ? (
          <AdminEmptyState icon={Eye} title="No message edits recorded" />
        ) : (
          <AdminTable>
            <AdminTableHead columns={[{ label: 'Time' }, { label: 'Edited by' }, { label: 'Reason' }, { label: 'Before' }, { label: 'After' }]} />
            <tbody>
              {(data?.editHistory ?? []).map((e) => (
                <tr key={e.id} className="border-b border-admin-border/60 align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-admin-mutedDim">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-admin-muted">{e.actor?.fullName ?? e.actor?.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-admin-mutedDim">{e.reason || '—'}</td>
                  <td className="max-w-xs px-4 py-2.5 text-admin-mutedDim"><p className="whitespace-pre-wrap break-words line-through opacity-70">{e.previousState?.body ?? '—'}</p></td>
                  <td className="max-w-xs px-4 py-2.5 text-admin-text"><p className="whitespace-pre-wrap break-words">{e.newState?.body ?? '(deleted)'}</p></td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}

        <h3 className="mb-1.5 mt-6 text-[11px] font-bold uppercase tracking-wide text-admin-gold">Message Deletion History ({(data?.deleteHistory ?? []).length})</h3>
        {(data?.deleteHistory ?? []).length === 0 ? (
          <AdminEmptyState icon={Eye} title="No message deletions recorded" />
        ) : (
          <AdminTable>
            <AdminTableHead columns={[{ label: 'Time' }, { label: 'Deleted by' }, { label: 'Sender type' }, { label: 'Reason' }, { label: 'Original message' }]} />
            <tbody>
              {(data?.deleteHistory ?? []).map((d) => (
                <tr key={d.id} className="border-b border-admin-border/60 align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-admin-mutedDim">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-admin-muted">{d.actor?.fullName ?? d.actor?.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-admin-muted">{d.metadata?.senderType ?? '—'}</td>
                  <td className="px-4 py-2.5 text-admin-mutedDim">{d.reason || '—'}</td>
                  <td className="max-w-xs px-4 py-2.5 text-admin-mutedDim"><p className="whitespace-pre-wrap break-words line-through opacity-70">{d.previousState?.body ?? '—'}</p></td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminPanel>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="admin-card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-admin-text">Delete this message?</h3>
            <p className="mt-2 text-sm text-admin-muted">
              This removes the message from Support conversations for the customer and staff. It does not delete the ticket or any other message, and the deletion itself is permanently recorded in the audit trail below.
            </p>
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded border border-admin-border bg-black/20 p-2 text-xs text-admin-mutedDim">
              {deleteTarget.body}
            </p>
            <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-admin-mutedDim">Reason (required)</label>
            <textarea
              className="admin-input mt-1 w-full"
              rows={2}
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Why is this message being deleted?"
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="admin-btn-secondary">Cancel</button>
              <button onClick={confirmDelete} disabled={deleting || deleteReason.trim().length < 3} className="admin-btn-danger">
                {deleting ? 'Deleting…' : 'Delete message'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
