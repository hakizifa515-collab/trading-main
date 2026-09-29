import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, createEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SupportPage } from './SupportPage'
import { ToastProvider } from '../../components/Toast'
import { ApiError } from '../../lib/api'
import { LONG_PRESS_MS } from '../../lib/useLongPress'
import type { SupportTicket } from '../../types'

const apiGet = vi.fn()
const apiPost = vi.fn()
const apiPatch = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => apiGet(...args),
      post: (...args: unknown[]) => apiPost(...args),
      patch: (...args: unknown[]) => apiPatch(...args),
    },
    attachmentUrl: (id: string) => `/attachments/${id}`,
  }
})

// The signed-in staff member. Mutable (reset to a plain ADMIN in the outer
// beforeEach below) so the "editing a message you sent" describe block can
// switch it to SUPER_ADMIN — message editing is now a role restriction, not
// a permission, so those tests need the viewer to actually hold that role.
let currentUser: { id: string; role: 'ADMIN' | 'SUPER_ADMIN' } = { id: 'admin1', role: 'ADMIN' }
const getCurrentUser = () => currentUser

vi.mock('../../store/auth', () => ({
  useAuth: () => ({ user: getCurrentUser() }),
}))

const TICKET: SupportTicket = {
  id: 't1', userId: 'u1', categoryId: 'c1', subject: 'Screenshot attached', status: 'OPEN',
  priority: 'NORMAL', requestedPriority: 'NORMAL', assignedAgentId: null,
  createdAt: '2026-09-13T15:08:00.000Z', updatedAt: '2026-09-13T15:32:00.000Z', resolvedAt: null, closedAt: null,
  user: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa' },
  messages: [
    {
      id: 'm1', ticketId: 't1', authorId: 'u1', body: 'Attached: photo.png', visibility: 'PUBLIC',
      createdAt: '2026-09-13T15:32:00.000Z', editedAt: null, author: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa', role: 'USER' },
      attachments: [{ id: 'a1', messageId: 'm1', filename: 'photo.png', mimeType: 'image/png', size: 1234, createdAt: '2026-09-13T15:32:00.000Z' }],
    },
    {
      id: 'm2', ticketId: 't1', authorId: 'u1', body: 'Attached: notes.pdf', visibility: 'PUBLIC',
      createdAt: '2026-09-13T15:33:00.000Z', editedAt: null, author: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa', role: 'USER' },
      attachments: [{ id: 'a2', messageId: 'm2', filename: 'notes.pdf', mimeType: 'application/pdf', size: 5678, createdAt: '2026-09-13T15:33:00.000Z' }],
    },
    // Sent by the signed-in staff member (admin1) — editable. `editedAt` is
    // deliberately non-null: even if a payload ever carried it, the UI must
    // never turn it into an "Edited" label.
    {
      id: 'm3', ticketId: 't1', authorId: 'admin1', body: 'Your withdrawal is being processed.', visibility: 'PUBLIC',
      createdAt: '2026-09-13T15:40:00.000Z', editedAt: '2026-09-13T15:50:00.000Z', author: { id: 'admin1', email: 'amy@example.com', fullName: 'Amy Agent', role: 'ADMIN' },
    },
    // Sent by a DIFFERENT staff member — never offered for editing.
    {
      id: 'm4', ticketId: 't1', authorId: 'admin2', body: 'Other agent reply.', visibility: 'PUBLIC',
      createdAt: '2026-09-13T15:41:00.000Z', editedAt: null, author: { id: 'admin2', email: 'bob@example.com', fullName: 'Bob Other', role: 'ADMIN' },
    },
  ],
}

function renderAdminSupport() {
  return render(<MemoryRouter><ToastProvider><SupportPage /></ToastProvider></MemoryRouter>)
}

const FOUND_USER = { id: 'u-new', email: 'newcustomer@example.com', fullName: 'New Customer' }

describe('Admin SupportPage', () => {
  beforeEach(() => {
    currentUser = { id: 'admin1', role: 'ADMIN' }
    apiGet.mockReset()
    apiPost.mockReset()
    apiPatch.mockReset()
    apiGet.mockImplementation((path: string) => {
      if (path === '/admin/support/tickets') return Promise.resolve([TICKET])
      if (path === '/admin/support/tickets/t1') return Promise.resolve(TICKET)
      if (path === '/admin/support/agents') return Promise.resolve([])
      if (path.startsWith('/admin/support/users')) return Promise.resolve([FOUND_USER])
      return Promise.resolve(null)
    })
  })

  it('no longer shows the "Customer Support" title/description block, but keeps Back to Dashboard', async () => {
    renderAdminSupport()
    expect(await screen.findByText('kabwa')).toBeInTheDocument()
    expect(screen.queryByText('Customer Support')).not.toBeInTheDocument()
    expect(screen.queryByText('Support tickets and live conversation threads.')).not.toBeInTheDocument()
    expect(screen.getByText('Back to Dashboard')).toBeInTheDocument()
  })

  it('renders an image attachment as an actual picture, not just a filename link', async () => {
    renderAdminSupport()
    fireEvent.click(await screen.findByText('kabwa'))
    const img = await screen.findByAltText('photo.png')
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('/attachments/a1')
  })

  it('renders a non-image attachment as a filename download link, not an image', async () => {
    renderAdminSupport()
    fireEvent.click(await screen.findByText('kabwa'))
    await screen.findByAltText('photo.png')
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
    expect(screen.queryByAltText('notes.pdf')).not.toBeInTheDocument()
  })

  describe('"Message a user" — contacting a user with no existing ticket', () => {
    it('is hidden until the toggle button is clicked', async () => {
      renderAdminSupport()
      await screen.findByText('kabwa')
      expect(screen.queryByPlaceholderText('Search by name or email…')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Message a user' }))
      expect(screen.getByPlaceholderText('Search by name or email…')).toBeInTheDocument()
    })

    it('searches users and lists results for selection', async () => {
      renderAdminSupport()
      await screen.findByText('kabwa')
      fireEvent.click(screen.getByRole('button', { name: 'Message a user' }))
      fireEvent.change(screen.getByPlaceholderText('Search by name or email…'), { target: { value: 'New' } })
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      expect(await screen.findByText('New Customer — newcustomer@example.com')).toBeInTheDocument()
    })

    it('selecting a found user reveals a message box; sending creates a ticket and opens it', async () => {
      apiPost.mockResolvedValue({ id: 't-new' })
      renderAdminSupport()
      await screen.findByText('kabwa')
      fireEvent.click(screen.getByRole('button', { name: 'Message a user' }))
      fireEvent.change(screen.getByPlaceholderText('Search by name or email…'), { target: { value: 'New' } })
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      await screen.findByText('New Customer — newcustomer@example.com')

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'u-new' } })
      const messageBox = await screen.findByPlaceholderText('Type your message…')
      fireEvent.change(messageBox, { target: { value: 'Hello, following up.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

      await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/admin/support/tickets', { userId: 'u-new', message: 'Hello, following up.' }))
      // Panel closes and the new ticket becomes selected once created — the
      // "Message a user" search box is gone again.
      await waitFor(() => expect(screen.queryByPlaceholderText('Type your message…')).not.toBeInTheDocument())
    })
  })

  // ---- Editing a message you sent ---------------------------------------

  async function openThread() {
    renderAdminSupport()
    fireEvent.click(await screen.findByText('kabwa'))
    await screen.findByText('Your withdrawal is being processed.')
  }
  const bubbleOf = (text: string) => screen.getByText(text).parentElement as HTMLElement
  const ticketFetches = () => apiGet.mock.calls.filter(([p]) => p === '/admin/support/tickets/t1').length

  // jsdom's TouchEvent carries no `touches`, so attach them by hand.
  function touch(el: Element, type: 'touchStart' | 'touchMove' | 'touchEnd', x = 40, y = 60) {
    const ev = createEvent[type](el, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'touches', { value: type === 'touchEnd' ? [] : [{ clientX: x, clientY: y }] })
    fireEvent(el, ev)
  }

  describe('editing a message you sent (as SUPER_ADMIN — see "message editing is SUPER_ADMIN only" below for the plain-ADMIN case)', () => {
    beforeEach(() => { currentUser = { id: 'admin1', role: 'SUPER_ADMIN' } })
    afterEach(() => { vi.useRealTimers() })

    it('shows no edit affordance until the gesture — there is no permanent Edit button on any message', async () => {
      await openThread()
      expect(screen.queryByText('Edit message')).not.toBeInTheDocument()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    })

    it('desktop: right-clicking your own message opens a menu with "Edit message"', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'), { clientX: 120, clientY: 140 })
      const menu = screen.getByRole('menu')
      expect(within(menu).getByRole('menuitem', { name: 'Edit message' })).toBeInTheDocument()
    })

    it('desktop: right-clicking another staff member\'s message, or the customer\'s, does not offer editing', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Other agent reply.'))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      fireEvent.contextMenu(bubbleOf('Attached: notes.pdf'))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('touch: pressing and holding your own message for the full hold opens the same menu — not before', async () => {
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()
      touch(bubble, 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100) })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(100) })
      expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit message' })).toBeInTheDocument()
    })

    it('touch: the hold is 1.5–2 seconds, and a finger that moves (a scroll) or lifts early never opens it', async () => {
      expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(1500)
      expect(LONG_PRESS_MS).toBeLessThanOrEqual(2000)
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()

      touch(bubble, 'touchStart', 40, 60)
      touch(bubble, 'touchMove', 40, 120) // scrolled well past the tolerance
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 500) })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()

      touch(bubble, 'touchStart', 40, 60)
      act(() => { vi.advanceTimersByTime(400) })
      touch(bubble, 'touchEnd')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 500) })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('touch: the browser\'s early native contextmenu event (Android) does not open the menu before the full hold', async () => {
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()
      touch(bubble, 'touchStart')
      act(() => { vi.advanceTimersByTime(500) })
      fireEvent.contextMenu(bubble)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('touch: after a long-press opens the menu and Edit is chosen, Save and Cancel taps still work (the hold\'s click-suppression is short-lived)', async () => {
      apiPatch.mockResolvedValue({ id: 'm3', body: 'Approved and sent.' })
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()

      touch(bubble, 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
      touch(bubble, 'touchEnd')
      act(() => { vi.advanceTimersByTime(1000) }) // the user reads the menu, then taps Edit
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))

      // A tap on Cancel (touch sequence + click) must not be swallowed…
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Approved and sent.' } })
      touch(screen.getByRole('button', { name: 'Cancel' }), 'touchStart')
      touch(screen.getByRole('button', { name: 'Cancel' }), 'touchEnd')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument()

      // …nor a tap on Save the next time round.
      touch(bubbleOf('Your withdrawal is being processed.'), 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
      touch(bubbleOf('Your withdrawal is being processed.'), 'touchEnd')
      act(() => { vi.advanceTimersByTime(1000) })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Approved and sent.' } })
      touch(screen.getByRole('button', { name: 'Save' }), 'touchStart')
      touch(screen.getByRole('button', { name: 'Save' }), 'touchEnd')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => { await Promise.resolve() })

      expect(apiPatch).toHaveBeenCalledTimes(1)
      expect(apiPatch).toHaveBeenCalledWith('/admin/support/tickets/t1/messages/m3', { body: 'Approved and sent.' })
    })

    it('touch: a click synthesized right after the hold ends is swallowed (so it cannot follow an attachment link or dismiss the menu)', async () => {
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()
      touch(bubble, 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
      touch(bubble, 'touchEnd')
      const onClick = vi.fn()
      bubble.addEventListener('click', onClick)
      fireEvent.click(bubble) // the browser's follow-up click, immediately after the finger lifts
      expect(onClick).not.toHaveBeenCalled()
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('touch: press-and-hold on another staff member\'s message does nothing', async () => {
      await openThread()
      vi.useFakeTimers()
      touch(bubbleOf('Other agent reply.'), 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 500) })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('choosing Edit pre-fills the current text; Save replaces the message in place and PATCHes only that message', async () => {
      apiPatch.mockResolvedValue({ id: 'm3', body: 'Your withdrawal was approved.' })
      await openThread()
      const fetchesBefore = ticketFetches()

      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      const editor = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement
      expect(editor.value).toBe('Your withdrawal is being processed.')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()

      fireEvent.change(editor, { target: { value: 'Your withdrawal was approved.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/admin/support/tickets/t1/messages/m3', { body: 'Your withdrawal was approved.' }))
      // Replaced in place: new text shown, old text gone, editor closed…
      expect(await screen.findByText('Your withdrawal was approved.')).toBeInTheDocument()
      expect(screen.queryByText('Your withdrawal is being processed.')).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument()
      // …with no reload of the thread (no loading flash / scroll reset) and no duplicate bubble.
      expect(ticketFetches()).toBe(fetchesBefore)
      expect(screen.getAllByText('Your withdrawal was approved.')).toHaveLength(1)
      // Other messages untouched.
      expect(screen.getByText('Other agent reply.')).toBeInTheDocument()
      expect(screen.getByAltText('photo.png')).toBeInTheDocument()
    })

    it('never shows an "Edited" label, edit timestamp, or previous version — before or after saving, even when the payload carries editedAt', async () => {
      apiPatch.mockResolvedValue({ id: 'm3', body: 'Corrected wording.' })
      await openThread()
      expect(screen.queryByText(/edit/i)).not.toBeInTheDocument() // m3 arrives with a non-null editedAt

      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Corrected wording.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText('Corrected wording.')

      expect(screen.queryByText(/edited/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/previous|original|history|revised|updated at/i)).not.toBeInTheDocument()
      expect(screen.queryByText('Your withdrawal is being processed.')).not.toBeInTheDocument()
      // The bubble's only timestamp is still its original send time.
      expect(bubbleOf('Corrected wording.').textContent).toContain(new Date('2026-09-13T15:40:00.000Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    })

    it('Cancel discards the edit: original text stays and nothing is sent', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Something else entirely' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(apiPatch).not.toHaveBeenCalled()
      expect(screen.getByText('Your withdrawal is being processed.')).toBeInTheDocument()
      expect(screen.queryByText('Something else entirely')).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument()
    })

    it('Escape cancels; Enter saves; Shift+Enter is a newline and does not save', async () => {
      apiPatch.mockResolvedValue({ id: 'm3', body: 'Line one\nLine two' })
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      const editor = screen.getByRole('textbox', { name: 'Edit message' })

      fireEvent.keyDown(editor, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument()
      expect(apiPatch).not.toHaveBeenCalled()

      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      const editor2 = screen.getByRole('textbox', { name: 'Edit message' })
      fireEvent.change(editor2, { target: { value: 'Line one\nLine two' } })
      fireEvent.keyDown(editor2, { key: 'Enter', shiftKey: true })
      expect(apiPatch).not.toHaveBeenCalled()

      fireEvent.keyDown(editor2, { key: 'Enter' })
      await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/admin/support/tickets/t1/messages/m3', { body: 'Line one\nLine two' }))
    })

    it('Escape on the open menu closes it without editing', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      expect(screen.getByRole('menu')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('a save the server rejects keeps the editor open with the draft and shows the error', async () => {
      apiPatch.mockRejectedValue(new ApiError(403, 'You can only edit messages you sent.', null))
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Attempted change' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByText('You can only edit messages you sent.')).toBeInTheDocument()
      expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe('Attempted change')
    })

    it('an empty draft cannot be saved, and an unchanged draft closes without a request', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: '   ' } })
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Your withdrawal is being processed.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(apiPatch).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument()
    })

    it('the conversation-list preview follows an edit of the latest message, without refetching the list', async () => {
      apiPatch.mockResolvedValue({ id: 'm3', body: 'Fresh preview wording.' })
      const ownMsg = TICKET.messages![2]
      apiGet.mockImplementation((path: string) => {
        if (path === '/admin/support/tickets') return Promise.resolve([{ ...TICKET, messages: [ownMsg] }]) // list preview = latest message
        if (path === '/admin/support/tickets/t1') return Promise.resolve(TICKET)
        if (path === '/admin/support/agents') return Promise.resolve([])
        return Promise.resolve(null)
      })
      renderAdminSupport()
      fireEvent.click(await screen.findByText('kabwa'))
      await screen.findAllByText('Your withdrawal is being processed.') // preview + bubble

      fireEvent.contextMenu(screen.getAllByText('Your withdrawal is being processed.').map((el) => el.parentElement as HTMLElement).find((el) => el.hasAttribute('data-editable'))!)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Fresh preview wording.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(screen.getAllByText('Fresh preview wording.')).toHaveLength(2)) // preview + bubble
      expect(screen.queryByText('Your withdrawal is being processed.')).not.toBeInTheDocument()
    })
  })

  // Message editing is SUPER_ADMIN only (Role Separation) — currentUser here
  // is the outer beforeEach's default, a plain ADMIN, deliberately NOT
  // overridden. m3 ("Your withdrawal is being processed.") is authored by
  // this exact user id (admin1), so this is the strongest case: even for a
  // message this ADMIN genuinely sent itself, neither gesture is offered.
  // The backend enforcement itself (rejecting a direct API call regardless
  // of what the UI shows) is covered in backend/test/support.e2e-spec.ts's
  // "30f2".
  describe('message editing is SUPER_ADMIN only — a plain ADMIN gets neither gesture, even on its own message', () => {
    afterEach(() => { vi.useRealTimers() })

    it('desktop: right-clicking a message this ADMIN itself sent opens no menu', async () => {
      await openThread()
      fireEvent.contextMenu(bubbleOf('Your withdrawal is being processed.'))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.queryByText('Edit message')).not.toBeInTheDocument()
    })

    it('touch: press-and-hold on that same message for the full duration opens no menu', async () => {
      await openThread()
      const bubble = bubbleOf('Your withdrawal is being processed.')
      vi.useFakeTimers()
      touch(bubble, 'touchStart')
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 500) })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('the bubble carries no data-editable marker for a plain ADMIN\'s own message', async () => {
      await openThread()
      expect(bubbleOf('Your withdrawal is being processed.')).not.toHaveAttribute('data-editable')
    })
  })

  // ---- Mobile layout ----------------------------------------------------
  // jsdom does no layout, so these pin the width constraints that make a
  // flex chat shrink correctly on a phone (verified separately in a real
  // browser at phone widths): every flex level allowed to shrink, text that
  // breaks anywhere, media capped to its container, a composer that can't
  // outgrow the screen.
  describe('mobile layout', () => {
    const LONG_TOKEN = 'A'.repeat(180)
    const LONG_FILENAME = `${'very-long-scanned-document-name-'.repeat(6)}final.pdf`

    function ticketWithLongContent(): SupportTicket {
      return {
        ...TICKET,
        messages: [
          ...TICKET.messages!,
          { id: 'm5', ticketId: 't1', authorId: 'u1', body: LONG_TOKEN, visibility: 'PUBLIC', createdAt: '2026-09-13T15:45:00.000Z', editedAt: null, author: { id: 'u1', email: 'k@example.com', fullName: 'kabwa', role: 'USER' } },
          {
            id: 'm6', ticketId: 't1', authorId: 'u1', body: 'see file', visibility: 'PUBLIC', createdAt: '2026-09-13T15:46:00.000Z', editedAt: null, author: { id: 'u1', email: 'k@example.com', fullName: 'kabwa', role: 'USER' },
            attachments: [{ id: 'a9', messageId: 'm6', filename: LONG_FILENAME, mimeType: 'application/pdf', size: 1, createdAt: '2026-09-13T15:46:00.000Z' }],
          },
        ],
      }
    }

    async function openLongThread() {
      apiGet.mockImplementation((path: string) => {
        if (path === '/admin/support/tickets') return Promise.resolve([TICKET])
        if (path === '/admin/support/tickets/t1') return Promise.resolve(ticketWithLongContent())
        if (path === '/admin/support/agents') return Promise.resolve([])
        return Promise.resolve(null)
      })
      renderAdminSupport()
      fireEvent.click(await screen.findByText('kabwa'))
      await screen.findByText(LONG_TOKEN)
    }

    it('the thread and every flex level above the bubbles can shrink (min-w-0 / min-h-0), so nothing forces the page wider', async () => {
      await openLongThread()
      const thread = screen.getByTestId('support-thread')
      expect(thread).toHaveClass('min-w-0', 'min-h-0', 'flex-1', 'overflow-y-auto')
      const row = screen.getByText(LONG_TOKEN).parentElement!.parentElement as HTMLElement
      expect(row).toHaveClass('min-w-0')
      let el: HTMLElement | null = thread.parentElement
      while (el && !el.className.includes('overflow-hidden')) {
        expect(el.className).toMatch(/min-w-0|flex-1|w-full|h-full|flex-col/) // no bare, unconstrained flex child on the way up
        el = el.parentElement
      }
    })

    it('bubbles are capped to the available width on phones and wrap very long unbroken text', async () => {
      await openLongThread()
      const bubble = screen.getByText(LONG_TOKEN).parentElement as HTMLElement
      expect(bubble).toHaveClass('min-w-0', 'max-w-[85%]', 'sm:max-w-[75%]')
      const text = screen.getByText(LONG_TOKEN)
      expect(text.className).toContain('[overflow-wrap:anywhere]')
      expect(text.className).toContain('whitespace-pre-wrap')
    })

    it('long attachment filenames wrap inside the bubble instead of widening it, and images are capped to the container', async () => {
      await openLongThread()
      const name = screen.getByText(LONG_FILENAME)
      expect(name.className).toContain('[overflow-wrap:anywhere]')
      expect(name.className).toContain('min-w-0')
      expect(name.parentElement).toHaveClass('flex', 'min-w-0') // the icon+name row is allowed to shrink
      expect(name.closest('a')).toHaveClass('min-w-0', 'max-w-full')
      expect(screen.getByAltText('photo.png')).toHaveClass('max-w-full', 'h-auto')
    })

    it('the composer fits the phone: the input can shrink, uses 16px text on phones (no iOS focus-zoom), and the file input is capped to its row', async () => {
      await openLongThread()
      const input = screen.getByPlaceholderText('Type a reply…')
      expect(input).toHaveClass('min-w-0', 'flex-1', 'text-base', 'sm:text-sm')
      expect(input.parentElement).toHaveClass('min-w-0')
      const fileInput = document.querySelector('input[type="file"]') as HTMLElement
      expect(fileInput).toHaveClass('w-full', 'min-w-0', 'max-w-full')
      expect(fileInput.closest('div')).toHaveClass('flex-wrap') // controls wrap instead of overflowing
      expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('shrink-0') // send stays reachable
    })

    it('the panel runs edge to edge on phones and is dvh-sized, while md+ keeps the inset, rounded, bordered card', async () => {
      await openLongThread()
      const panel = screen.getByTestId('support-thread').closest('.overflow-hidden') as HTMLElement
      expect(panel).toHaveClass('-mx-4', 'md:mx-0', 'md:rounded-2xl', 'md:border', 'h-[calc(100vh-160px)]', 'supports-[height:100dvh]:h-[calc(100dvh-160px)]')
      expect(panel.getAttribute('style')).toBeNull() // no fixed inline vh height left over
    })
  })
})
