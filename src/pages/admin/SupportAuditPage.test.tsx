import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SupportAuditPage } from './SupportAuditPage'
import { ToastProvider } from '../../components/Toast'
import { ApiError } from '../../lib/api'

const apiGet = vi.fn()
const apiDel = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => apiGet(...args),
      del: (...args: unknown[]) => apiDel(...args),
    },
    attachmentUrl: (id: string) => `/attachments/${id}`,
  }
})

let currentUser: { id: string; role: 'ADMIN' | 'SUPER_ADMIN' } = { id: 'admin1', role: 'SUPER_ADMIN' }
vi.mock('../../store/auth', () => ({
  useAuth: () => ({ user: currentUser }),
}))

const CUSTOMER_MESSAGE = {
  id: 'm1', body: 'My withdrawal never arrived.', visibility: 'PUBLIC', createdAt: '2026-09-20T10:00:00.000Z',
  deletedAt: null, deletedByAdminId: null,
  author: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa', role: 'USER' },
  attachments: [],
  ticket: { id: 't1', subject: 'Missing withdrawal', status: 'OPEN', userId: 'u1', user: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa' } },
}
const AGENT_MESSAGE = {
  id: 'm2', body: 'We are looking into it.', visibility: 'PUBLIC', createdAt: '2026-09-20T10:05:00.000Z',
  deletedAt: null, deletedByAdminId: null,
  author: { id: 'admin2', email: 'bob@example.com', fullName: 'Bob Agent', role: 'ADMIN' },
  attachments: [],
  ticket: { id: 't1', subject: 'Missing withdrawal', status: 'OPEN', userId: 'u1', user: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa' } },
}
const ALREADY_DELETED_MESSAGE = {
  id: 'm3', body: 'This was removed already.', visibility: 'PUBLIC', createdAt: '2026-09-20T10:10:00.000Z',
  deletedAt: '2026-09-20T11:00:00.000Z', deletedByAdminId: 'admin1',
  author: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa', role: 'USER' },
  attachments: [],
  ticket: { id: 't1', subject: 'Missing withdrawal', status: 'OPEN', userId: 'u1', user: { id: 'u1', email: 'kabwa@example.com', fullName: 'kabwa' } },
}

const DELETE_HISTORY_EVENT = {
  id: 'del1', createdAt: '2026-09-20T11:00:00.000Z', actor: { id: 'admin1', email: 'super@example.com', fullName: 'Super Admin' },
  targetId: 'm3', reason: 'Spam content', previousState: { body: 'This was removed already.' },
  metadata: { ticketId: 't1', senderId: 'u1', senderType: 'CUSTOMER' },
}

function feed(overrides?: Partial<{ messages: unknown[]; editHistory: unknown[]; deleteHistory: unknown[] }>) {
  return {
    messages: [CUSTOMER_MESSAGE, AGENT_MESSAGE],
    editHistory: [],
    deleteHistory: [],
    ...overrides,
  }
}

function renderPage() {
  return render(<MemoryRouter><ToastProvider><SupportAuditPage /></ToastProvider></MemoryRouter>)
}

describe('Support Audit — message deletion', () => {
  beforeEach(() => {
    currentUser = { id: 'admin1', role: 'SUPER_ADMIN' }
    apiGet.mockReset()
    apiDel.mockReset()
    apiGet.mockImplementation((path: string) => {
      if (path === '/admin/support/audit?limit=150') return Promise.resolve(feed())
      return Promise.resolve(null)
    })
  })

  it('SUPER_ADMIN sees a delete control on every non-deleted message', async () => {
    renderPage()
    await screen.findByText('My withdrawal never arrived.')
    expect(screen.getAllByRole('button', { name: 'Delete message' })).toHaveLength(2)
  })

  it('a plain ADMIN (e.g. granted support.audit) sees no delete control at all', async () => {
    currentUser = { id: 'admin2', role: 'ADMIN' }
    renderPage()
    await screen.findByText('My withdrawal never arrived.')
    expect(screen.queryByRole('button', { name: 'Delete message' })).not.toBeInTheDocument()
  })

  it('clicking delete opens a confirmation dialog requiring a reason; the confirm button stays disabled until one is entered', async () => {
    renderPage()
    await screen.findByText('My withdrawal never arrived.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0])

    expect(screen.getByText('Delete this message?')).toBeInTheDocument()
    const dialog = screen.getByText('Delete this message?').closest('div')!.parentElement as HTMLElement
    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete message' })
    expect(confirmBtn).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Why is this message being deleted?'), { target: { value: 'ok' } })
    expect(confirmBtn).toBeDisabled() // still below the 3-character minimum
    fireEvent.change(screen.getByPlaceholderText('Why is this message being deleted?'), { target: { value: 'okay reason' } })
    expect(confirmBtn).not.toBeDisabled()
    expect(apiDel).not.toHaveBeenCalled()
  })

  it('canceling the dialog does not call the API', async () => {
    renderPage()
    await screen.findByText('My withdrawal never arrived.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this message?')).not.toBeInTheDocument()
    expect(apiDel).not.toHaveBeenCalled()
  })

  it('confirming with a reason deletes a customer message via the correct endpoint and refetches on success', async () => {
    apiDel.mockResolvedValue({ ok: true, messageId: 'm1', deletedAt: '2026-09-20T12:00:00.000Z' })
    renderPage()
    await screen.findByText('My withdrawal never arrived.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0])
    fireEvent.change(screen.getByPlaceholderText('Why is this message being deleted?'), { target: { value: 'Customer requested removal' } })
    const dialog = screen.getByText('Delete this message?').closest('div') as HTMLElement
    fireEvent.click(within(dialog.parentElement as HTMLElement).getByRole('button', { name: 'Delete message' }))

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/admin/support/tickets/t1/messages/m1', { reason: 'Customer requested removal' }))
    await waitFor(() => expect(screen.queryByText('Delete this message?')).not.toBeInTheDocument())
    // Refetch happened (second call to the audit endpoint).
    await waitFor(() => expect(apiGet.mock.calls.filter(([p]) => p === '/admin/support/audit?limit=150').length).toBeGreaterThanOrEqual(2))
  })

  it('confirming deletion of a support-agent message uses that message\'s id', async () => {
    apiDel.mockResolvedValue({ ok: true, messageId: 'm2', deletedAt: '2026-09-20T12:00:00.000Z' })
    renderPage()
    await screen.findByText('We are looking into it.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[1])
    fireEvent.change(screen.getByPlaceholderText('Why is this message being deleted?'), { target: { value: 'Incorrect information' } })
    const dialog = screen.getByText('Delete this message?').closest('div') as HTMLElement
    fireEvent.click(within(dialog.parentElement as HTMLElement).getByRole('button', { name: 'Delete message' }))

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/admin/support/tickets/t1/messages/m2', { reason: 'Incorrect information' }))
  })

  it('a rejected delete (e.g. 403) shows an error and keeps the dialog open with the draft reason intact', async () => {
    apiDel.mockRejectedValue(new ApiError(403, 'Only a Super Admin can delete messages.', null))
    renderPage()
    await screen.findByText('My withdrawal never arrived.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0])
    fireEvent.change(screen.getByPlaceholderText('Why is this message being deleted?'), { target: { value: 'Attempted removal' } })
    const dialog = screen.getByText('Delete this message?').closest('div') as HTMLElement
    fireEvent.click(within(dialog.parentElement as HTMLElement).getByRole('button', { name: 'Delete message' }))

    expect(await screen.findByText('Only a Super Admin can delete messages.')).toBeInTheDocument()
    expect(screen.getByText('Delete this message?')).toBeInTheDocument()
    expect((screen.getByPlaceholderText('Why is this message being deleted?') as HTMLTextAreaElement).value).toBe('Attempted removal')
  })

  it('an already-deleted message shows a DELETED badge, dimmed body, and no delete control for it', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/admin/support/audit?limit=150') return Promise.resolve(feed({ messages: [ALREADY_DELETED_MESSAGE] }))
      return Promise.resolve(null)
    })
    renderPage()
    await screen.findByText('This was removed already.')
    expect(screen.getByText('DELETED')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete message' })).not.toBeInTheDocument()
  })

  it('renders the Message Deletion History section from deleteHistory', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/admin/support/audit?limit=150') return Promise.resolve(feed({ messages: [], deleteHistory: [DELETE_HISTORY_EVENT] }))
      return Promise.resolve(null)
    })
    renderPage()
    expect(await screen.findByText('Message Deletion History (1)')).toBeInTheDocument()
    expect(screen.getByText('Spam content')).toBeInTheDocument()
    expect(screen.getByText('Super Admin')).toBeInTheDocument()
    expect(screen.getByText('CUSTOMER')).toBeInTheDocument()
  })
})
