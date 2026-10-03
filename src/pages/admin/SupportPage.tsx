// Customer Support — a proper two-panel chat interface (left: searchable
// conversation list, right: selected ticket's message thread). All
// underlying behavior is unchanged from the previous ticket-list version:
// same /admin/support/tickets(+/:id) endpoints, same filters (client-side,
// same reasoning as before — simpler than a filter-param API at this
// platform's scale), same reply/attach/status/assign actions.
//
// Visual design is intentionally scoped to THIS page only, via arbitrary
// Tailwind color values rather than the shared admin-* theme tokens — a
// deep-navy/bright-blue palette matching an explicit reference the operator
// asked to match "completely." Every other admin page keeps the standard
// dark/gold admin theme; nothing here changes any shared token, class, or
// component, so this page's look-and-feel does not leak anywhere else.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { Headset, MoreVertical, Paperclip, Pencil, Plus, Search, SlidersHorizontal, Send, User } from 'lucide-react'
import type { SupportMessage, SupportTicket } from '../../types'
import { api, attachmentUrl } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { useAuth } from '../../store/auth'
import { useLongPress } from '../../lib/useLongPress'
import { AdminBackLink, AdminPanel, statusTone, useAdmin, tryAction, AdminEmptyState } from '../../components/admin'

const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'] as const
const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

// Page-scoped navy palette (see file header comment) — one place to tweak
// the reference-matched colors without hunting through every className.
const NAVY = {
  panel: 'bg-[#0d1940]',
  border: 'border-[#1e2f66]',
  headerBg: 'bg-[#142a68]',
  hoverRow: 'hover:bg-[#12224f]',
  selectedRow: 'bg-[#1a2f6e]',
  muted: 'text-[#8291c4]',
  input: 'bg-[#0b1636] text-white placeholder-[#8291c4]',
  avatar: 'bg-[#3576f0]',
  accent: 'bg-[#3576f0]',
}

// Colored last-message-preview pill per conversation-list row — tone comes
// from the SAME statusTone(ticket.status) used elsewhere (never a
// fabricated color); the reference's mustard-yellow pill is the "default"
// shade here, with the same success/danger tones layered on for a real
// resolved/rejected ticket so status is never lost, just restyled.
const PREVIEW_PILL_CLASS: Record<ReturnType<typeof statusTone>, string> = {
  success: 'bg-[#3ecf8e] text-[#062a1c]',
  danger: 'bg-[#f0645a] text-[#2a0a08]',
  warning: 'bg-[#f0c23a] text-[#1a1a2e]',
  info: 'bg-[#f0c23a] text-[#1a1a2e]',
  neutral: 'bg-[#25376e] text-[#8291c4]',
}

export function SupportPage() {
  const { error, loading, data, refetch } = useAdmin<SupportTicket[]>('/admin/support/tickets')
  // Deep-link support for the ADMIN NOTIFICATIONS email's "Open Support
  // Ticket" button (?ticket=<id>) — the link carries no auth of its own,
  // just an id; this only pre-selects it once the ticket list has loaded,
  // so it still goes through the exact same authenticated fetch/permission
  // path as clicking a row by hand.
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const ticketId = searchParams.get('ticket')
    if (ticketId && data?.some((t) => t.id === ticketId)) setSelected(ticketId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [category, setCategory] = useState('')
  const [agent, setAgent] = useState('')
  const [q, setQ] = useState('')
  // Filters collapsed by default (Customer Support redesign) — the sidebar
  // now leads with just the search bar, matching the reference layout; the
  // 4 dropdowns are still the exact same real client-side filters, just
  // tucked behind this toggle instead of always taking up space.
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = [status, priority, category, agent].filter(Boolean).length
  // "Contact any user" (operator request) — lets an admin start a brand-new
  // conversation with a user who has no ticket yet, or only a closed one.
  const [showNewMessage, setShowNewMessage] = useState(false)
  // A staff member editing their own message updates the open thread in
  // place (no refetch, so no loading flash and no scroll reset). The
  // conversation-list preview is fed by a separate list fetch, so remember
  // the edit here to keep that preview in step. `from` is the body the server
  // last returned: the override only applies while that is still current, so
  // a later real refetch (or another edit elsewhere) always wins.
  const [previewEdits, setPreviewEdits] = useState<Record<string, { from: string; to: string }>>({})
  const previewBody = (msg: { id: string; body: string }) => {
    const edit = previewEdits[msg.id]
    return edit && edit.from === msg.body ? edit.to : msg.body
  }

  const categories = Array.from(new Set((data ?? []).map((t) => t.category?.name).filter(Boolean))) as string[]
  const agents = Array.from(new Map((data ?? []).filter((t) => t.assignedAgent).map((t) => [t.assignedAgent!.id, t.assignedAgent!])).values())

  const filtered = (data ?? []).filter((t) => {
    if (status && t.status !== status) return false
    if (priority && t.priority !== priority) return false
    if (category && t.category?.name !== category) return false
    if (agent === '__unassigned__' && t.assignedAgentId) return false
    if (agent && agent !== '__unassigned__' && t.assignedAgentId !== agent) return false
    if (q && !`${t.subject} ${t.user?.email ?? ''} ${t.user?.fullName ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  const selectedTicket = filtered.find((t) => t.id === selected) ?? (data ?? []).find((t) => t.id === selected)

  return (
    <div>
      <AdminBackLink to="/admin" />
      <AdminPanel loading={loading} error={error} refetch={refetch}>
        {/* On phones the panel runs edge to edge (negative margin cancels the
            layout's px-4 gutter) and is sized with dvh, so the browser's
            collapsing address bar doesn't push the composer off-screen; the
            plain-vh height is the fallback for browsers without dvh. From md
            up nothing changes: inset, rounded, bordered card. */}
        <div className={`-mx-4 flex h-[calc(100vh-160px)] overflow-hidden border-y supports-[height:100dvh]:h-[calc(100dvh-160px)] md:mx-0 md:rounded-2xl md:border ${NAVY.border} ${NAVY.panel}`}>
          {/* Left sidebar — search + conversation list */}
          <div className={`w-full min-w-0 shrink-0 flex-col border-r ${NAVY.border} md:flex md:w-80 ${selected ? 'hidden md:flex' : 'flex'}`}>
            <div className={`border-b ${NAVY.border} ${NAVY.headerBg} p-3`}>
              <div className="flex items-center gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8291c4]" />
                  <input
                    className={`w-full rounded-full border-none py-2 pl-8 pr-3 text-xs outline-none ${NAVY.input}`}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search customer or subject"
                  />
                </div>
                <button
                  onClick={() => setShowFilters((v) => !v)}
                  className={`relative shrink-0 rounded-full border p-2 transition ${showFilters || activeFilterCount > 0 ? 'border-[#3576f0] bg-[#3576f0]/20 text-[#6ea1ff]' : `${NAVY.border} text-[#8291c4] hover:text-white`}`}
                  title="Filters"
                  aria-label="Toggle filters"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {activeFilterCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#f0c23a] text-[9px] font-bold text-[#1a1a2e]">{activeFilterCount}</span>
                  )}
                </button>
                <button
                  onClick={() => setShowNewMessage((v) => !v)}
                  className={`shrink-0 rounded-full border p-2 transition ${showNewMessage ? 'border-[#3576f0] bg-[#3576f0]/20 text-[#6ea1ff]' : `${NAVY.border} text-[#8291c4] hover:text-white`}`}
                  title="Message a user"
                  aria-label="Message a user"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {showFilters && (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <select className={`rounded-lg border-none py-1.5 text-[11px] ${NAVY.input}`} value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">All statuses</option>
                    {TICKET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={`rounded-lg border-none py-1.5 text-[11px] ${NAVY.input}`} value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="">All priorities</option>
                    {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select className={`rounded-lg border-none py-1.5 text-[11px] ${NAVY.input}`} value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">All categories</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select className={`rounded-lg border-none py-1.5 text-[11px] ${NAVY.input}`} value={agent} onChange={(e) => setAgent(e.target.value)}>
                    <option value="">All agents</option>
                    <option value="__unassigned__">Unassigned</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                  </select>
                </div>
              )}
            </div>
            {showNewMessage && (
              <NewMessagePanel
                onClose={() => setShowNewMessage(false)}
                onCreated={async (ticketId) => {
                  setShowNewMessage(false)
                  await refetch()
                  setSelected(ticketId)
                }}
              />
            )}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <AdminEmptyState icon={Headset} title="No conversations match" />
              ) : (
                filtered.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelected(t.id)}
                    className={`flex w-full items-start gap-2.5 border-b ${NAVY.border} border-l-2 px-3 py-3 text-left transition ${selected === t.id ? `border-l-[#f0c23a] ${NAVY.selectedRow}` : `border-l-transparent ${NAVY.hoverRow}`}`}
                  >
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${NAVY.avatar} text-white`}>
                      <User className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className="truncate text-sm font-semibold text-white">{t.user?.fullName ?? t.user?.email ?? 'Unknown customer'}</p>
                        <span className="shrink-0 text-[10px] text-[#8291c4]">{new Date(t.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <p className="truncate text-[11px] text-[#8291c4]">ID: {t.userId.slice(0, 8)}</p>
                      {t.messages?.[0] ? (
                        <p className={`mt-1 inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium ${PREVIEW_PILL_CLASS[statusTone(t.status)]}`}>
                          {previewBody(t.messages[0])}
                        </p>
                      ) : (
                        <p className="mt-1 inline-block truncate rounded bg-[#25376e] px-1.5 py-0.5 text-[11px] font-medium text-[#8291c4]">No messages yet</p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Main chat panel */}
          <div className={`min-w-0 flex-1 flex-col md:flex ${selected ? 'flex' : 'hidden md:flex'}`}>
            {selectedTicket ? (
              <SupportTicketDetail
                ticket={selectedTicket}
                onBack={() => setSelected(null)}
                onChanged={refetch}
                onMessageEdited={(id, from, to) => setPreviewEdits((prev) => ({ ...prev, [id]: { from, to } }))}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-[#8291c4]">Select a conversation to view messages</div>
            )}
          </div>
        </div>
      </AdminPanel>
    </div>
  )
}

// "Contact any user" — search the whole user base (not just existing
// conversations) and send an opening message, creating a new ticket owned
// by that user with this admin as its first (and auto-assigned) author.
// Deliberately its own small self-contained component: own search
// state, own selected-user state, own message draft — none of it needs
// to live in the parent SupportPage beyond "a ticket got created."
function NewMessagePanel({ onClose, onCreated }: { onClose: () => void; onCreated: (ticketId: string) => void }) {
  const { push } = useToast()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<{ id: string; email: string; fullName: string }[] | null>(null)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  async function search() {
    setSearching(true)
    try {
      setResults(await api.get<{ id: string; email: string; fullName: string }[]>(`/admin/support/users?q=${encodeURIComponent(query.trim())}`))
    } catch {
      push('error', 'Could not search users.')
    } finally {
      setSearching(false)
    }
  }

  async function send() {
    if (!selectedUserId || !message.trim()) return
    setSending(true)
    const res = await tryAction(() => api.post<{ id: string }>('/admin/support/tickets', { userId: selectedUserId, message: message.trim() }))
    setSending(false)
    if (res.ok) { push('success', 'Message sent.'); onCreated(res.data.id) }
    else push('error', res.error)
  }

  return (
    <div className={`border-b ${NAVY.border} ${NAVY.headerBg} p-3`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-white">Message a user</p>
        <button onClick={onClose} className="text-[11px] text-[#8291c4] hover:text-white">Close</button>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          className={`min-w-0 flex-1 rounded-lg border-none px-3 py-1.5 text-base outline-none sm:text-xs ${NAVY.input}`}
          placeholder="Search by name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button onClick={search} disabled={searching} className="shrink-0 rounded-lg bg-[#3576f0] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{searching ? '…' : 'Search'}</button>
      </div>
      {results && (
        <select
          className={`mt-2 w-full rounded-lg border-none px-3 py-1.5 text-xs ${NAVY.input}`}
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
        >
          <option value="">{results.length === 0 ? 'No users found' : 'Select a user…'}</option>
          {results.map((u) => <option key={u.id} value={u.id}>{u.fullName} — {u.email}</option>)}
        </select>
      )}
      {selectedUserId && (
        <div className="mt-2 space-y-1.5">
          <textarea
            className={`w-full resize-none rounded-lg border-none px-3 py-1.5 text-base outline-none sm:text-xs ${NAVY.input}`}
            rows={2}
            placeholder="Type your message…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            onClick={send}
            disabled={sending || !message.trim()}
            className="w-full rounded-lg bg-[#3576f0] py-1.5 text-xs font-semibold text-white transition hover:bg-[#4a86ff] disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Start conversation'}
          </button>
        </div>
      )}
    </div>
  )
}

// The small right-click / press-and-hold menu for a message the current staff
// member sent. Rendered in a portal so no scrolling/clipping ancestor (the
// thread is overflow-y-auto) can cut it off, and clamped to the viewport so
// it never opens partly off-screen on a narrow phone.
function MessageContextMenu({ at, onEdit, onClose }: { at: { x: number; y: number }; onEdit: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(margin, Math.min(at.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(at.y, window.innerHeight - height - margin)),
    })
  }, [at.x, at.y])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointerDown = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className={`fixed z-[300] min-w-[9.5rem] overflow-hidden rounded-xl border ${NAVY.border} ${NAVY.headerBg} py-1 text-xs text-white shadow-2xl`}
    >
      <button role="menuitem" onClick={onEdit} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#25376e] focus:bg-[#25376e] focus:outline-none">
        <Pencil className="h-3.5 w-3.5" /> Edit message
      </button>
    </div>,
    document.body,
  )
}

// One message in the staff thread. Editing requires SUPER_ADMIN or the
// support.messages.edit permission (Role Separation) — a plain ADMIN
// without that specific grant never gets the gesture, no matter which
// OTHER support.* permissions it holds. `canEdit` (passed in by the caller)
// also requires the message to be one the viewer sent themselves — only
// those get the edit gesture (right-click on desktop, press-and-hold on
// touch) and an inline editor; everyone else's are inert. Nothing here ever
// renders an "edited" marker, a timestamp change or the previous text —
// after saving, the bubble simply shows the new wording. The backend is
// what actually decides who may edit (AdminSupportController.editMessage()'s
// @RequirePermissions('support.messages.edit'), re-checked again inside
// SupportService.editStaffMessage() via assertPermission(), rejects an
// ungranted ADMIN even via a direct API call); this only decides who is
// OFFERED it, using `viewerCanEditMessages` from the ticket fetch as the
// UX-only signal for whether the signed-in viewer currently holds it.
function MessageBubble({
  message, ticketId, customerName, isCustomer, canEdit, displayBody, onEdited,
}: {
  message: SupportMessage
  ticketId: string
  customerName: string
  isCustomer: boolean
  canEdit: boolean
  displayBody: string
  onEdited: (id: string, from: string, to: string) => void
}) {
  const { push } = useToast()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const press = useLongPress((at) => setMenuAt(at), canEdit && !editing)

  function startEdit() {
    setMenuAt(null)
    setDraft(displayBody)
    setEditing(true)
  }

  async function save() {
    const next = draft.trim()
    if (!next || saving) return
    if (next === displayBody.trim()) { setEditing(false); return }
    setSaving(true)
    const res = await tryAction(() => api.patch<{ id: string; body: string }>(`/admin/support/tickets/${ticketId}/messages/${message.id}`, { body: next }))
    setSaving(false)
    if (res.ok) {
      onEdited(message.id, message.body, res.data.body)
      setEditing(false)
    } else {
      push('error', res.error)
    }
  }

  // Enter saves; Shift+Enter keeps multi-line messages usable. On touch
  // devices (no hover) Enter stays a newline — there's no Shift key on a
  // phone keyboard, so Save is the button.
  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); return }
    const touchOnly = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touchOnly) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div className={`flex min-w-0 ${isCustomer ? 'justify-start' : 'justify-end'}`}>
      <div
        {...(canEdit ? press : {})}
        data-editable={canEdit ? 'true' : undefined}
        className={`min-w-0 rounded-xl px-3 py-2 text-xs ${editing ? 'w-full max-w-[85%] sm:max-w-[75%]' : 'max-w-[85%] sm:max-w-[75%]'} ${
          canEdit ? '[-webkit-touch-callout:none] [@media(hover:none)]:select-none' : ''
        } ${
          message.visibility === 'INTERNAL'
            ? 'border border-[#f0c23a]/40 bg-[#4a3a12] text-[#f0c23a]'
            : isCustomer
              ? 'bg-[#16224f] text-white'
              : 'bg-[#3576f0] text-white'
        }`}
      >
        <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{message.author?.fullName ?? (isCustomer ? customerName : 'Support')}</span>
          {message.visibility === 'INTERNAL' && <span className="shrink-0 text-[#f0c23a]">(internal)</span>}
        </div>
        {editing ? (
          <div>
            <textarea
              autoFocus
              aria-label="Edit message"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditorKeyDown}
              className="block w-full min-w-0 resize-none rounded-lg border-none bg-[#0b1636] px-2.5 py-1.5 text-base text-white outline-none focus:ring-1 focus:ring-[#6ea1ff] sm:text-xs"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button onClick={() => setEditing(false)} disabled={saving} className="rounded-full px-2.5 py-1 text-[11px] font-medium text-[#cddcff] hover:text-white disabled:opacity-50">Cancel</button>
              <button onClick={() => void save()} disabled={saving || !draft.trim()} className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[#142a68] disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word]">{displayBody}</p>
        )}
        {(message.attachments ?? []).map((a) => (
          <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="mt-1 block min-w-0 max-w-full">
            {a.mimeType.startsWith('image/') ? (
              <img src={attachmentUrl(a.id)} alt={a.filename} className="block h-auto max-h-64 w-auto max-w-full rounded-lg object-cover" />
            ) : (
              <span className="flex min-w-0 items-start gap-1.5 text-[#cddcff] hover:text-white">
                <Paperclip className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere] [word-break:break-word]">{a.filename}</span>
              </span>
            )}
          </a>
        ))}
        <p className="mt-1 text-right text-[10px] text-[#cddcff]/70">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      </div>
      {menuAt && <MessageContextMenu at={menuAt} onEdit={startEdit} onClose={() => setMenuAt(null)} />}
    </div>
  )
}

function SupportTicketDetail({ ticket, onBack, onChanged, onMessageEdited }: { ticket: SupportTicket; onBack: () => void; onChanged: () => void; onMessageEdited: (id: string, from: string, to: string) => void }) {
  const { push } = useToast()
  const { user: currentUser } = useAuth()
  const { data, loading, error, refetch } = useAdmin<SupportTicket>(`/admin/support/tickets/${ticket.id}`)
  // Edits made in this open thread, applied in place. Same `from` guard as the
  // list preview: an override only applies while the server's body is still
  // the one it was made against.
  const [edits, setEdits] = useState<Record<string, { from: string; to: string }>>({})
  const bodyOf = (m: SupportMessage) => {
    const edit = edits[m.id]
    return edit && edit.from === m.body ? edit.to : m.body
  }
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<{ id: string; fullName: string; email: string }[] | null>(null)
  // Status/assign controls collapsed by default (Customer Support redesign)
  // — the thread gets the full vertical space by default, matching the
  // reference layout; same real actions, just tucked behind this toggle.
  const [showActions, setShowActions] = useState(false)

  useEffect(() => {
    // Not every viewer has support.tickets.assign — a 403 here just means
    // "don't show the assign control", not a page-level error.
    api.get<{ id: string; fullName: string; email: string }[]>('/admin/support/agents').then(setAgents).catch(() => setAgents(null))
  }, [])

  async function sendReply() {
    if (!reply.trim() && !file) return
    setSending(true)
    let res: { ok: true; data: unknown } | { ok: false; error: string }
    if (file) {
      const form = new FormData()
      form.append('file', file)
      if (reply.trim()) form.append('body', reply)
      form.append('visibility', internal ? 'INTERNAL' : 'PUBLIC')
      res = await tryAction(() => api.postForm(`/admin/support/tickets/${ticket.id}/attachments`, form))
    } else {
      res = await tryAction(() => api.post(`/admin/support/tickets/${ticket.id}/messages`, { body: reply, visibility: internal ? 'INTERNAL' : 'PUBLIC' }))
    }
    setSending(false)
    if (res.ok) { setReply(''); setFile(null); refetch(); onChanged() }
    else push('error', res.error)
  }

  async function setStatus(status: string) {
    const res = await tryAction(() => api.patch(`/admin/support/tickets/${ticket.id}/status`, { status, reason: `Set to ${status} via admin panel` }))
    if (res.ok) { push('success', `Status set to ${status}.`); refetch(); onChanged() }
    else push('error', res.error)
  }

  async function assign(agentId: string) {
    if (!agentId) return
    const res = await tryAction(() => api.post(`/admin/support/tickets/${ticket.id}/assign`, { agentId, reason: 'Assigned via admin panel' }))
    if (res.ok) { push('success', 'Ticket assigned.'); refetch(); onChanged() }
    else push('error', res.error)
  }

  const customerName = ticket.user?.fullName ?? ticket.user?.email ?? 'Unknown customer'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={`flex items-center gap-2.5 border-b ${NAVY.border} ${NAVY.headerBg} px-4 py-3`}>
        <button onClick={onBack} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1c2f6b] text-white md:hidden">←</button>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${NAVY.avatar} text-white`}>
          <User className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-white">{customerName}</p>
          <p className="truncate text-[11px] text-[#8291c4]">ID: {ticket.userId} · {ticket.subject}</p>
        </div>
        <button
          onClick={() => setShowActions((v) => !v)}
          className={`shrink-0 rounded-full p-2 transition ${showActions ? 'bg-[#3576f0] text-white' : 'bg-[#1c2f6b] text-[#8291c4] hover:text-white'}`}
          title="Status & assignment"
          aria-label="Toggle status and assignment controls"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[#8291c4]">Loading…</div>
      ) : error || !data ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[#f0645a]">{error?.message ?? 'Could not load ticket.'}</div>
      ) : (
        <>
          {/* Status / assign controls — collapsed by default */}
          {showActions && (
            <div className={`flex flex-wrap items-center gap-1.5 border-b ${NAVY.border} px-4 py-2`}>
              {(['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'] as const).map((s) => (
                <button key={s} onClick={() => setStatus(s)} className="rounded-full bg-[#1c2f6b] px-2.5 py-1 text-[10px] font-medium text-white hover:bg-[#25376e]">{s}</button>
              ))}
              {agents && (
                <select className={`ml-auto w-auto rounded-lg border-none py-1 text-[11px] ${NAVY.input}`} value={data.assignedAgentId ?? ''} onChange={(e) => assign(e.target.value)}>
                  <option value="">Unassigned — assign to…</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                </select>
              )}
            </div>
          )}

          {/* Message thread */}
          {/* min-w-0/min-h-0 at every flex level: without them one long
              unbroken string, filename or wide image widens its row past the
              phone instead of wrapping. */}
          <div data-testid="support-thread" className={`min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain ${NAVY.panel} px-3 py-4 sm:px-4`}>
            {(data.messages ?? []).map((m) => {
              const isCustomer = m.author?.role === 'USER' || (!m.author?.role && m.authorId === data.userId)
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  ticketId={ticket.id}
                  customerName={customerName}
                  isCustomer={isCustomer}
                  canEdit={!!currentUser && (currentUser.role === 'SUPER_ADMIN' || !!data.viewerCanEditMessages) && m.authorId === currentUser.id}
                  displayBody={bodyOf(m)}
                  onEdited={(id, from, to) => {
                    setEdits((prev) => ({ ...prev, [id]: { from, to } }))
                    onMessageEdited(id, from, to)
                  }}
                />
              )
            })}
          </div>

          {/* Reply box */}
          <div className={`min-w-0 shrink-0 border-t ${NAVY.border} ${NAVY.panel} p-3`}>
            <div className="flex min-w-0 items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-full border-none bg-white px-4 py-2.5 text-base text-[#1a1a2e] placeholder-[#8291c4] outline-none sm:text-sm"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Type a reply…"
                onKeyDown={(e) => e.key === 'Enter' && sendReply()}
              />
              <button
                onClick={sendReply}
                disabled={sending}
                title="Send"
                aria-label="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3576f0] text-white transition hover:bg-[#4a86ff] disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            {/* A native file input has a wide intrinsic width (and grows with a
                long chosen filename) — cap it to the row instead of letting it
                push the composer wider than the phone. */}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[#8291c4]">
              <label className="flex shrink-0 items-center gap-1.5"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
              <label className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full min-w-0 max-w-full text-[11px]" />
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
