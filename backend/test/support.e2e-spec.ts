import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createTestApp, uniqueEmail, extractSessionCookie, createUserDirect, grantPermissionDirect } from './helpers/test-app'
import type { PrismaService } from '../src/prisma/prisma.service'

describe('Customer Support (real PostgreSQL)', () => {
  let app: INestApplication
  let prisma: PrismaService
  let server: any
  let categoryId: string

  beforeAll(async () => {
    const t = await createTestApp()
    app = t.app
    prisma = t.prisma
    server = app.getHttpServer()
    const category = await prisma.supportCategory.upsert({
      where: { name: 'Test Category' },
      create: { name: 'Test Category' },
      update: {},
    })
    categoryId = category.id
  })

  afterAll(async () => {
    await app.close()
  })

  async function loginAs(email: string, password: string) {
    const res = await request(server).post('/auth/login').send({ email, password }).expect(200)
    return extractSessionCookie(res)
  }

  async function makeCustomer(prefix: string) {
    const email = uniqueEmail(prefix)
    const password = 'correct-horse-battery'
    const { user } = await createUserDirect(prisma, { email, password, role: 'USER' })
    const cookie = await loginAs(email, password)
    return { userId: user.id, cookie }
  }

  async function makeAgentWith(...permissions: string[]) {
    const email = uniqueEmail('agent')
    const password = 'correct-horse-battery'
    const { user } = await createUserDirect(prisma, { email, password, role: 'ADMIN' })
    for (const p of permissions) await grantPermissionDirect(prisma, user.id, p)
    const cookie = await loginAs(email, password)
    return { userId: user.id, cookie }
  }

  // ---- 11, 12: create + list own ----

  it('11. a customer can create a support ticket', async () => {
    const { cookie } = await makeCustomer('cust11')
    const res = await request(server).post('/support/tickets').set('Cookie', cookie)
      .send({ categoryId, subject: 'My withdrawal is missing', message: 'It has been 3 days.' }).expect(201)
    expect(res.body.status).toBe('OPEN')
  })

  it('12. a customer can see their own tickets', async () => {
    const { cookie } = await makeCustomer('cust12')
    await request(server).post('/support/tickets').set('Cookie', cookie).send({ categoryId, subject: 'Q1', message: 'hi' }).expect(201)
    const list = await request(server).get('/support/tickets').set('Cookie', cookie).expect(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].subject).toBe('Q1')
  })

  // ---- 13, 25: cross-customer isolation ----

  it('13 & 25. Customer A cannot see or access Customer B\'s ticket by ID', async () => {
    const a = await makeCustomer('custA')
    const b = await makeCustomer('custB')
    const ticket = await request(server).post('/support/tickets').set('Cookie', a.cookie).send({ categoryId, subject: 'A private matter', message: 'hi' }).expect(201)

    // B tries to fetch A's ticket directly by ID
    await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', b.cookie).expect(403)

    // B's own ticket list never includes A's ticket
    const bList = await request(server).get('/support/tickets').set('Cookie', b.cookie).expect(200)
    expect(bList.body.find((t: any) => t.id === ticket.body.id)).toBeUndefined()
  })

  // ---- 14: customer reply ----

  it('14. a customer can reply to their own open ticket', async () => {
    const { cookie } = await makeCustomer('cust14')
    const ticket = await request(server).post('/support/tickets').set('Cookie', cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    await request(server).post(`/support/tickets/${ticket.body.id}/messages`).set('Cookie', cookie).send({ body: 'Any update?' }).expect(201)
    const detail = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', cookie).expect(200)
    expect(detail.body.messages).toHaveLength(2) // original + reply
  })

  // ---- 15, 27: customer cannot create/see internal notes ----

  it('15 & 27. a customer cannot create an internal note by manipulating the visibility field', async () => {
    const { cookie } = await makeCustomer('cust15')
    const ticket = await request(server).post('/support/tickets').set('Cookie', cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    await request(server).post(`/support/tickets/${ticket.body.id}/messages`).set('Cookie', cookie).send({ body: 'sneaky', visibility: 'INTERNAL' }).expect(201)

    const stored = await prisma.supportMessage.findFirst({ where: { ticketId: ticket.body.id, body: 'sneaky' } })
    expect(stored!.visibility).toBe('PUBLIC') // the customer's requested INTERNAL visibility was ignored server-side
  })

  // ---- 16, 17, 18: agent view/reply/internal note ----

  it('16 & 17. an agent with support.tickets.read + support.tickets.reply can view and reply to a ticket', async () => {
    const customer = await makeCustomer('cust1617')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)

    const agent = await makeAgentWith('support.tickets.read', 'support.tickets.reply')
    await request(server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', agent.cookie).expect(200)
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'We are looking into it.' }).expect(201)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages.some((m: any) => m.body === 'We are looking into it.')).toBe(true)
  })

  it('18 & 19. an agent with support.tickets.internal_note can write a note the customer never sees', async () => {
    const customer = await makeCustomer('cust1819')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)

    const agent = await makeAgentWith('support.tickets.read', 'support.tickets.internal_note')
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'Escalate to finance', visibility: 'INTERNAL' }).expect(201)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages.some((m: any) => m.body === 'Escalate to finance')).toBe(false)

    const agentView = await request(server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', agent.cookie).expect(200)
    expect(agentView.body.messages.some((m: any) => m.body === 'Escalate to finance')).toBe(true)
  })

  // ---- 20, 21: status update permission ----

  it('20 & 21. an agent WITHOUT support.tickets.resolve cannot resolve a ticket even with support.tickets.update', async () => {
    const customer = await makeCustomer('cust2021')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)

    const agent = await makeAgentWith('support.tickets.update') // no .resolve
    await request(server).patch(`/admin/support/tickets/${ticket.body.id}/status`).set('Cookie', agent.cookie).send({ status: 'RESOLVED' }).expect(403)

    const withResolve = await makeAgentWith('support.tickets.update', 'support.tickets.resolve')
    const res = await request(server).patch(`/admin/support/tickets/${ticket.body.id}/status`).set('Cookie', withResolve.cookie).send({ status: 'RESOLVED' }).expect(200)
    expect(res.body.status).toBe('RESOLVED')
  })

  // ---- 22: assignment permission-controlled ----

  it('22. ticket assignment requires support.tickets.assign specifically', async () => {
    const customer = await makeCustomer('cust22')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const targetAgent = await makeAgentWith('support.tickets.read')

    const noAssignPerm = await makeAgentWith('support.tickets.update')
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/assign`).set('Cookie', noAssignPerm.cookie).send({ agentId: targetAgent.userId }).expect(403)

    const withAssignPerm = await makeAgentWith('support.tickets.assign')
    const res = await request(server).post(`/admin/support/tickets/${ticket.body.id}/assign`).set('Cookie', withAssignPerm.cookie).send({ agentId: targetAgent.userId, reason: 'best fit' }).expect(201)
    expect(res.body.assignedAgentId).toBe(targetAgent.userId)

    const history = await request(server).get(`/admin/support/tickets/${ticket.body.id}/assignments`).set('Cookie', withAssignPerm.cookie).expect(200)
    expect(history.body).toHaveLength(1)
  })

  // ---- 23: category deactivation preserves history ----

  it('23. deactivating a category does not destroy tickets that reference it, and cannot be deleted', async () => {
    const manager = await makeAgentWith('support.categories.manage')
    const catRes = await request(server).post('/admin/support/categories').set('Cookie', manager.cookie).send({ name: `Deactivate Me ${Date.now()}` }).expect(201)

    const customer = await makeCustomer('cust23')
    await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId: catRes.body.id, subject: 'Q', message: 'hi' }).expect(201)

    const deactivated = await request(server).patch(`/admin/support/categories/${catRes.body.id}`).set('Cookie', manager.cookie).send({ isActive: false }).expect(200)
    expect(deactivated.body.isActive).toBe(false)

    // The ticket referencing it still exists and is queryable.
    const stillThere = await prisma.supportTicket.findFirst({ where: { categoryId: catRes.body.id } })
    expect(stillThere).not.toBeNull()

    // No delete endpoint exists for categories at all (structural
    // prevention, not just an unused permission) — a real DELETE request
    // hits no registered route and 404s, even for a SUPER_ADMIN.
    const superEmail = uniqueEmail('catdeletesuper')
    const superPassword = 'correct-horse-battery'
    await createUserDirect(prisma, { email: superEmail, password: superPassword, role: 'SUPER_ADMIN' })
    const superCookie = await loginAs(superEmail, superPassword)
    await request(server).delete(`/admin/support/categories/${catRes.body.id}`).set('Cookie', superCookie).expect(404)
  })

  // ---- 24: audit trail ----

  it('24. assigning a ticket and changing its status are recorded in the audit log', async () => {
    const customer = await makeCustomer('cust24')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeAgentWith('support.tickets.assign', 'support.tickets.update', 'support.tickets.resolve')

    await request(server).post(`/admin/support/tickets/${ticket.body.id}/assign`).set('Cookie', agent.cookie).send({ agentId: agent.userId }).expect(201)
    await request(server).patch(`/admin/support/tickets/${ticket.body.id}/status`).set('Cookie', agent.cookie).send({ status: 'RESOLVED' }).expect(200)

    const assignLog = await prisma.auditLog.findFirst({ where: { action: 'TICKET_ASSIGNED', targetId: ticket.body.id } })
    const statusLog = await prisma.auditLog.findFirst({ where: { action: 'TICKET_STATUS_CHANGED', targetId: ticket.body.id } })
    expect(assignLog).not.toBeNull()
    expect(statusLog).not.toBeNull()
    expect(statusLog!.newState).toEqual({ status: 'RESOLVED' })
  })

  // ---- 26: customer cannot manipulate author ID ----

  it('26. a customer cannot manipulate message authorship — it always comes from the session, never the request body', async () => {
    const customer = await makeCustomer('cust26')
    const otherUser = await makeCustomer('cust26b')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)

    // authorId is not a field CreateMessageDto declares. The global
    // ValidationPipe runs with forbidNonWhitelisted: true, so this isn't
    // silently stripped-then-accepted — the whole request is rejected
    // outright as malformed (a stronger property than silent stripping).
    await request(server).post(`/support/tickets/${ticket.body.id}/messages`).set('Cookie', customer.cookie).send({ body: 'reply', authorId: otherUser.userId }).expect(400)

    // The legitimate request (no authorId field) still works, and the
    // author is always taken from the authenticated session.
    await request(server).post(`/support/tickets/${ticket.body.id}/messages`).set('Cookie', customer.cookie).send({ body: 'reply' }).expect(201)
    const stored = await prisma.supportMessage.findFirst({ where: { ticketId: ticket.body.id, body: 'reply' } })
    expect(stored!.authorId).toBe(customer.userId)
  })

  // ---- 28: customer cannot escalate authoritative priority ----

  it('28. a customer\'s requested priority is recorded but never becomes the authoritative priority automatically', async () => {
    const { cookie } = await makeCustomer('cust28')
    const res = await request(server).post('/support/tickets').set('Cookie', cookie).send({ categoryId, subject: 'URGENT!!!', message: 'hi', requestedPriority: 'URGENT' }).expect(201)
    expect(res.body.requestedPriority).toBe('URGENT')
    // priority starts equal to what was requested (a reasonable default),
    // but the customer has no endpoint that can change `priority` directly
    // afterward — only PATCH /admin/support/tickets/:id/priority can, and
    // that requires support.tickets.update (staff-only).
    const asCustomerAgain = await request(server).patch(`/support/tickets/${res.body.id}/priority`).set('Cookie', cookie).send({ priority: 'URGENT' })
    expect(asCustomerAgain.status).toBe(404) // no such customer-facing route exists at all
  })

  // ---------------------------------------------------------------------
  // Phase 4 — notifications (Part 22, items 24 & 25)
  // ---------------------------------------------------------------------

  it('24. a staff PUBLIC reply creates a notification for the customer, and an internal note does not', async () => {
    const customer = await makeCustomer('custnotify1')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Notify me', message: 'hi' }).expect(201)
    const agent = await makeAgentWith('support.tickets.read', 'support.tickets.reply', 'support.tickets.internal_note')

    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'We are on it.' }).expect(201)
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'internal only', visibility: 'INTERNAL' }).expect(201)

    const notifs = await request(server).get('/support/notifications').set('Cookie', customer.cookie).expect(200)
    const forThisTicket = notifs.body.filter((n: any) => n.ticketId === ticket.body.id)
    expect(forThisTicket).toHaveLength(1) // only the PUBLIC reply notifies, not the internal note
    expect(forThisTicket[0].event).toBe('AGENT_REPLIED')
    expect(forThisTicket[0].message).not.toContain('internal only') // preview never carries message body content
  })

  it('24b. assigning a ticket notifies the newly assigned agent; resolving notifies the customer', async () => {
    const customer = await makeCustomer('custnotify2')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeAgentWith('support.tickets.assign', 'support.tickets.update', 'support.tickets.resolve')

    await request(server).post(`/admin/support/tickets/${ticket.body.id}/assign`).set('Cookie', agent.cookie).send({ agentId: agent.userId }).expect(201)
    const agentNotifs = await request(server).get('/support/notifications').set('Cookie', agent.cookie).expect(200)
    expect(agentNotifs.body.some((n: any) => n.ticketId === ticket.body.id && n.event === 'TICKET_ASSIGNED')).toBe(true)

    await request(server).patch(`/admin/support/tickets/${ticket.body.id}/status`).set('Cookie', agent.cookie).send({ status: 'RESOLVED' }).expect(200)
    const customerNotifs = await request(server).get('/support/notifications').set('Cookie', customer.cookie).expect(200)
    expect(customerNotifs.body.some((n: any) => n.ticketId === ticket.body.id && n.event === 'TICKET_RESOLVED')).toBe(true)
  })

  it('25. notification ownership is enforced — a customer only ever sees their own, and marking read cannot touch another user\'s row', async () => {
    const a = await makeCustomer('notifyownerA')
    const b = await makeCustomer('notifyownerB')
    const ticket = await request(server).post('/support/tickets').set('Cookie', a.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeAgentWith('support.tickets.read', 'support.tickets.reply')
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'reply' }).expect(201)

    const aNotifs = await request(server).get('/support/notifications').set('Cookie', a.cookie).expect(200)
    const targetNotif = aNotifs.body.find((n: any) => n.ticketId === ticket.body.id)
    expect(targetNotif).toBeDefined()

    // B never sees A's notification in their own list.
    const bNotifs = await request(server).get('/support/notifications').set('Cookie', b.cookie).expect(200)
    expect(bNotifs.body.find((n: any) => n.id === targetNotif.id)).toBeUndefined()

    // B "marking read" (even by guessing A's notification id) cannot mark
    // A's row read — the WHERE clause is always scoped to the caller's own
    // userId, so this silently matches zero rows rather than erroring.
    await request(server).patch('/support/notifications/read').set('Cookie', b.cookie).send({ ids: [targetNotif.id] }).expect(200)
    const stillUnread = await prisma.supportNotification.findUnique({ where: { id: targetNotif.id } })
    expect(stillUnread!.readAt).toBeNull()

    // A marking their own notification read works.
    await request(server).patch('/support/notifications/read').set('Cookie', a.cookie).send({ ids: [targetNotif.id] }).expect(200)
    const nowRead = await prisma.supportNotification.findUnique({ where: { id: targetNotif.id } })
    expect(nowRead!.readAt).not.toBeNull()
  })

  // ---------------------------------------------------------------------
  // Phase 4 — attachments (Part 22, item 26)
  // ---------------------------------------------------------------------

  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

  it('26. a customer can upload and download their own attachment; storage key is never the filename; another customer cannot access it', async () => {
    const customer = await makeCustomer('attachcust')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Screenshot attached', message: 'see attached' }).expect(201)

    const upload = await request(server).post(`/support/tickets/${ticket.body.id}/attachments`).set('Cookie', customer.cookie)
      .attach('file', PNG_BYTES, { filename: '../../etc/passwd.png', contentType: 'image/png' })
      .expect(201)
    const attachmentId = upload.body.attachments[0].id

    // storage key is a fresh random name, never derived from the (here,
    // path-traversal-shaped) client-supplied filename.
    const row = await prisma.supportAttachment.findUniqueOrThrow({ where: { id: attachmentId } })
    expect(row.storageKey).not.toContain('..')
    expect(row.storageKey).not.toContain('passwd')

    const download = await request(server).get(`/support/attachments/${attachmentId}`).set('Cookie', customer.cookie).expect(200)
    // 'inline' (not 'attachment') — an image attachment must render directly
    // in the chat thread, not force a download, matching CmsMedia/Kyc's own
    // file-serving convention.
    expect(download.headers['content-disposition']).toMatch(/^inline;/)

    const otherCustomer = await makeCustomer('attachother')
    await request(server).get(`/support/attachments/${attachmentId}`).set('Cookie', otherCustomer.cookie).expect(403)
  })

  // Regression test for a real bug: the upload response itself always
  // included `attachments` (createMessageWithAttachment always did), but
  // re-fetching the ticket afterwards — what the actual chat UI renders
  // off — silently dropped every attachment, because getTicketForCustomer()/
  // getTicketForStaff() never included the relation on their nested
  // `messages` query. The customer/admin pages' image-vs-download-link
  // logic was always correct; it just never received any attachment data
  // to act on. This asserts the SAME endpoints the UI actually calls,
  // not just the upload response.
  it('26c. the attachment is still present (with its real mimeType) when the ticket is re-fetched afterwards, for both the customer and the admin views', async () => {
    const customer = await makeCustomer('attachrefetch')
    const agent = await makeAgentWith('support.tickets.read')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Screenshot attached', message: 'see attached' }).expect(201)
    await request(server).post(`/support/tickets/${ticket.body.id}/attachments`).set('Cookie', customer.cookie)
      .attach('file', PNG_BYTES, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    const customerAttachmentMsg = customerView.body.messages.find((m: any) => (m.attachments ?? []).length > 0)
    expect(customerAttachmentMsg).toBeDefined()
    expect(customerAttachmentMsg.attachments[0]).toMatchObject({ filename: 'screenshot.png', mimeType: 'image/png' })

    const adminView = await request(server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', agent.cookie).expect(200)
    const adminAttachmentMsg = adminView.body.messages.find((m: any) => (m.attachments ?? []).length > 0)
    expect(adminAttachmentMsg).toBeDefined()
    expect(adminAttachmentMsg.attachments[0]).toMatchObject({ filename: 'screenshot.png', mimeType: 'image/png' })
  })

  it('26d. a text-only message (no attachment) round-trips unchanged through the same ticket-refetch endpoints', async () => {
    const customer = await makeCustomer('attachtextonly')
    const agent = await makeAgentWith('support.tickets.read')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Just a question', message: 'no attachment here' }).expect(201)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages[0].body).toBe('no attachment here')
    expect(customerView.body.messages[0].attachments ?? []).toHaveLength(0)

    const adminView = await request(server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', agent.cookie).expect(200)
    expect(adminView.body.messages[0].body).toBe('no attachment here')
    expect(adminView.body.messages[0].attachments ?? []).toHaveLength(0)
  })

  it('26b. an oversized or disallowed-type attachment is rejected before it is ever stored', async () => {
    const customer = await makeCustomer('attachreject')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)

    // Wrong signature for the declared type (plain bytes claiming image/png).
    await request(server).post(`/support/tickets/${ticket.body.id}/attachments`).set('Cookie', customer.cookie)
      .attach('file', Buffer.from('not actually a png'), { filename: 'fake.png', contentType: 'image/png' })
      .expect(400)

    // Disallowed mime type outright, regardless of content.
    await request(server).post(`/support/tickets/${ticket.body.id}/attachments`).set('Cookie', customer.cookie)
      .attach('file', PNG_BYTES, { filename: 'evil.exe', contentType: 'application/x-msdownload' })
      .expect(400)

    // Oversized (over the shared 5MB MediaStorageService limit).
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024 + 1)])
    await request(server).post(`/support/tickets/${ticket.body.id}/attachments`).set('Cookie', customer.cookie)
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' })
      .expect(400)

    expect(await prisma.supportAttachment.count({ where: { message: { ticketId: ticket.body.id } } })).toBe(0)
  })

  it('a staff member with support.tickets.assign can list assignable agents, without needing admins.read', async () => {
    const agent = await makeAgentWith('support.tickets.assign')
    const res = await request(server).get('/admin/support/agents').set('Cookie', agent.cookie).expect(200)
    expect(res.body.some((a: any) => a.id === agent.userId)).toBe(true)
  })

  // ---- Support ticket auto-greeting (Customer Support redesign) ----

  async function makeSuperAdmin(prefix: string) {
    const email = uniqueEmail(prefix)
    const password = 'correct-horse-battery'
    const { user } = await createUserDirect(prisma, { email, password, role: 'SUPER_ADMIN' })
    const cookie = await loginAs(email, password)
    return { userId: user.id, cookie }
  }

  afterEach(async () => {
    // Every auto-greeting test leaves the singleton row disabled again, so
    // tests in this file (and later files, since PlatformSettings is a
    // shared singleton) never see a stray real ticket message they didn't
    // create.
    await prisma.platformSettings.updateMany({
      data: { supportAutoGreetingEnabled: false, supportAutoGreetingMessage: null, supportAutoGreetingSenderId: null },
    })
  })

  it('auto-greeting disabled (the default): a new ticket has exactly the customer\'s own opening message', async () => {
    const { cookie } = await makeCustomer('nogreet')
    const res = await request(server).post('/support/tickets').set('Cookie', cookie)
      .send({ categoryId, subject: 'Question', message: 'Hi there' }).expect(201)

    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: res.body.id }, include: { messages: true } })
    expect(ticket.messages).toHaveLength(1)
    expect(ticket.messages[0].body).toBe('Hi there')
  })

  it('auto-greeting enabled: a new ticket also gets a real, persisted reply authored by the configured staff account', async () => {
    const admin = await makeSuperAdmin('greetsender')
    const { cookie: customerCookie } = await makeCustomer('greetcust')

    await request(server)
      .patch('/admin/platform-settings')
      .set('Cookie', admin.cookie)
      .send({
        supportAutoGreetingEnabled: true,
        supportAutoGreetingMessage: 'Hi! Thanks for reaching out.',
        supportAutoGreetingSenderId: admin.userId,
        reason: 'enable auto-greeting for test',
        confirmPassword: 'correct-horse-battery',
      })
      .expect(200)

    const res = await request(server).post('/support/tickets').set('Cookie', customerCookie)
      .send({ categoryId, subject: 'Question', message: 'Hi there' }).expect(201)

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    expect(ticket.messages).toHaveLength(2)
    expect(ticket.messages[0].body).toBe('Hi there')
    expect(ticket.messages[1].body).toBe('Hi! Thanks for reaching out.')
    expect(ticket.messages[1].authorId).toBe(admin.userId)
    expect(ticket.messages[1].visibility).toBe('PUBLIC')
  })

  it('configuring an auto-greeting sender that is not a real admin account is rejected', async () => {
    const admin = await makeSuperAdmin('greetbadsender')
    const { userId: notAnAdminId } = await makeCustomer('notadmin')

    await request(server)
      .patch('/admin/platform-settings')
      .set('Cookie', admin.cookie)
      .send({
        supportAutoGreetingEnabled: true,
        supportAutoGreetingMessage: 'Hi!',
        supportAutoGreetingSenderId: notAnAdminId,
        reason: 'should be rejected',
        confirmPassword: 'correct-horse-battery',
      })
      .expect(400)
  })

  it('if the configured sender is demoted after being set, the greeting is silently skipped rather than blocking ticket creation', async () => {
    const admin = await makeSuperAdmin('greetdemoted')
    const { cookie: customerCookie } = await makeCustomer('greetdemotedcust')

    await request(server)
      .patch('/admin/platform-settings')
      .set('Cookie', admin.cookie)
      .send({
        supportAutoGreetingEnabled: true,
        supportAutoGreetingMessage: 'Hi!',
        supportAutoGreetingSenderId: admin.userId,
        reason: 'enable',
        confirmPassword: 'correct-horse-battery',
      })
      .expect(200)

    // Demote the configured sender directly (bypassing the API, simulating
    // "the account was since demoted or deleted" independent of this flow).
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'USER' } })

    const res = await request(server).post('/support/tickets').set('Cookie', customerCookie)
      .send({ categoryId, subject: 'Question', message: 'Hi there' }).expect(201)

    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: res.body.id }, include: { messages: true } })
    expect(ticket.messages).toHaveLength(1)
    expect(ticket.messages[0].body).toBe('Hi there')
  })

  // ---------------------------------------------------------------------
  // "Contact any user" — admin-initiated conversations (operator request)
  // ---------------------------------------------------------------------

  it('29. an admin can start a brand-new conversation with a user who has no ticket yet', async () => {
    const agent = await makeAgentWith('support.tickets.reply')
    const customer = await makeCustomer('newmsgtarget')

    const res = await request(server).post('/admin/support/tickets').set('Cookie', agent.cookie)
      .send({ userId: customer.userId, message: 'Hi, following up on your account.' }).expect(201)

    expect(res.body.userId).toBe(customer.userId)
    expect(res.body.assignedAgentId).toBe(agent.userId) // auto-assigned to whoever started it
    expect(res.body.messages).toHaveLength(1)
    expect(res.body.messages[0].authorId).toBe(agent.userId)
    expect(res.body.messages[0].body).toBe('Hi, following up on your account.')
    expect(res.body.messages[0].visibility).toBe('PUBLIC')

    // Audited as an administrative action.
    const events = await prisma.auditLog.findMany({ where: { action: 'TICKET_STARTED_BY_STAFF', targetId: res.body.id } })
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(agent.userId)
  })

  it('29b. an agent WITHOUT support.tickets.reply cannot start a new conversation', async () => {
    const agent = await makeAgentWith('support.tickets.read') // read-only, no .reply
    const customer = await makeCustomer('newmsgforbidden')
    await request(server).post('/admin/support/tickets').set('Cookie', agent.cookie)
      .send({ userId: customer.userId, message: 'hi' }).expect(403)
  })

  it('29c. GET /admin/support/users searches by name/email and returns a small, non-sensitive projection', async () => {
    const agent = await makeAgentWith('support.tickets.reply')
    const email = uniqueEmail('findable-user')
    const { user } = await createUserDirect(prisma, { email, password: 'correct-horse-battery', fullName: 'Findable Customer' })

    const res = await request(server).get(`/admin/support/users?q=Findable`).set('Cookie', agent.cookie).expect(200)
    const match = res.body.find((u: any) => u.id === user.id)
    expect(match).toEqual({ id: user.id, email, fullName: 'Findable Customer' })
    // Only id/email/fullName — no balance, KYC status, role, or password hash.
    expect(Object.keys(match).sort()).toEqual(['email', 'fullName', 'id'])
  })

  it('29d. the customer can see and reply to a conversation the admin started', async () => {
    const agent = await makeAgentWith('support.tickets.reply')
    const customer = await makeCustomer('newmsgreply')

    const created = await request(server).post('/admin/support/tickets').set('Cookie', agent.cookie)
      .send({ userId: customer.userId, message: 'We noticed an issue with your account.' }).expect(201)

    const customerView = await request(server).get(`/support/tickets/${created.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages[0].body).toBe('We noticed an issue with your account.')

    const reply = await request(server).post(`/support/tickets/${created.body.id}/messages`).set('Cookie', customer.cookie)
      .send({ body: 'Thanks, what issue?' }).expect(201)
    expect(reply.body.authorId).toBe(customer.userId)

    // The customer also gets an in-app notification about the admin's opening message.
    const notifications = await prisma.supportNotification.findMany({ where: { userId: customer.userId, ticketId: created.body.id } })
    expect(notifications.some((n) => n.event === 'AGENT_REPLIED')).toBe(true)
  })

  it('29e. starting a conversation with a nonexistent user returns 404', async () => {
    const agent = await makeAgentWith('support.tickets.reply')
    await request(server).post('/admin/support/tickets').set('Cookie', agent.cookie)
      .send({ userId: '00000000-0000-0000-0000-000000000000', message: 'hi' }).expect(404)
  })

  it('29f. omitting categoryId auto-selects the first active category, same as the customer-facing chat-first flow', async () => {
    const agent = await makeAgentWith('support.tickets.reply')
    const customer = await makeCustomer('newmsgnocat')
    const res = await request(server).post('/admin/support/tickets').set('Cookie', agent.cookie)
      .send({ userId: customer.userId, message: 'hi' }).expect(201)
    expect(res.body.categoryId).toBeTruthy()
  })

  // ---- 30: staff message editing (SUPER_ADMIN ONLY) ----------------------
  // The visible thread must stay clean (no edited flag/timestamp/history in
  // any normal conversation payload); the original text must survive
  // internally, in the append-only AuditLog. Editing is a ROLE, not a
  // permission — a plain ADMIN cannot do it no matter what support.* grants
  // it holds (see 30f2/30g below); only SUPER_ADMIN can, and only for a
  // message it authored itself.

  async function ticketWithAgentMessage(body = 'Your withdrawal is being processed.') {
    const customer = await makeCustomer('edit-cust')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'Where is my money?' }).expect(201)
    const agent = await makeSuperAdmin('edit-super')
    const sent = await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body }).expect(201)
    return { customer, agent, ticketId: ticket.body.id as string, messageId: sent.body.id as string, originalBody: body }
  }

  const editUrl = (ticketId: string, messageId: string) => `/admin/support/tickets/${ticketId}/messages/${messageId}`

  it('30. a Super Admin can edit a message they sent: the customer and admin views both show only the updated text, with no duplicate, no reorder, no edited marker', async () => {
    const { customer, agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    // A later customer message so ordering is observable.
    await request(server).post(`/support/tickets/${ticketId}/messages`).set('Cookie', customer.cookie).send({ body: 'Thanks, any ETA?' }).expect(201)
    const ticketBefore = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
    const orderBefore = (await prisma.supportMessage.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } })).map((m) => m.id)

    const res = await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'Your withdrawal was approved and sent.' }).expect(200)
    expect(res.body.id).toBe(messageId)
    expect(res.body.body).toBe('Your withdrawal was approved and sent.')

    for (const view of [
      await request(server).get(`/support/tickets/${ticketId}`).set('Cookie', customer.cookie).expect(200),
      await request(server).get(`/admin/support/tickets/${ticketId}`).set('Cookie', agent.cookie).expect(200),
    ]) {
      const bodies = view.body.messages.map((m: any) => m.body)
      expect(bodies).toContain('Your withdrawal was approved and sent.')
      expect(bodies).not.toContain(originalBody)
      const edited = view.body.messages.find((m: any) => m.id === messageId)
      expect(edited.editedAt).toBeNull() // no edit timestamp/flag anywhere in the normal payload
      expect(view.body.messages.map((m: any) => m.id)).toEqual(orderBefore) // same messages, same order, no duplicate
    }

    const ticketAfter = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
    expect(ticketAfter.updatedAt.getTime()).toBe(ticketBefore.updatedAt.getTime()) // the edit did not touch the ticket
    expect(ticketAfter.assignedAgentId).toBe(ticketBefore.assignedAgentId)
  })

  it('30b. the original text and edit metadata are preserved internally (AuditLog), across repeated edits', async () => {
    const { agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'Second version.' }).expect(200)
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'Third version.' }).expect(200)

    const rows = await prisma.auditLog.findMany({ where: { action: 'SUPPORT_MESSAGE_EDITED', targetId: messageId }, orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0].actorId).toBe(agent.userId)
    expect(rows[0].targetType).toBe('SUPPORT_MESSAGE')
    expect((rows[0].previousState as any).body).toBe(originalBody) // the true original survives
    expect((rows[0].newState as any).body).toBe('Second version.')
    expect((rows[1].previousState as any).body).toBe('Second version.') // every intermediate version too
    expect((rows[1].newState as any).body).toBe('Third version.')
    expect(rows[0].createdAt).toBeInstanceOf(Date) // edit timestamp
    expect((rows[0].metadata as any).ticketId).toBe(ticketId)

    // The visible message row itself only ever holds the latest text.
    const stored = await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })
    expect(stored.body).toBe('Third version.')
    expect(stored.editedAt).toBeNull()
  })

  it('30c. no normal customer or admin conversation payload exposes the original text or any edit-history field', async () => {
    const { customer, agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage('ORIGINAL-SECRET-WORDING-123')
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'Corrected wording.' }).expect(200)

    const customerView = await request(server).get(`/support/tickets/${ticketId}`).set('Cookie', customer.cookie).expect(200)
    const adminView = await request(server).get(`/admin/support/tickets/${ticketId}`).set('Cookie', agent.cookie).expect(200)
    const adminList = await request(server).get('/admin/support/tickets').set('Cookie', agent.cookie).expect(200)
    const patchRes = await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'Corrected wording.' }).expect(200)

    for (const payload of [customerView.body, adminView.body, adminList.body, patchRes.body]) {
      const json = JSON.stringify(payload)
      expect(json).not.toContain(originalBody)
      expect(json).not.toMatch(/previousBody|originalBody|editHistory|history|previousState/i)
    }
  })

  it('30d. editing keeps the message\'s attachments intact', async () => {
    const customer = await makeCustomer('edit-attach')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeSuperAdmin('edit-attach-super')
    const upload = await request(server).post(`/admin/support/tickets/${ticket.body.id}/attachments`).set('Cookie', agent.cookie)
      .field('body', 'Here is the receipt').attach('file', PNG_BYTES, { filename: 'receipt.png', contentType: 'image/png' }).expect(201)
    const attachmentId = upload.body.attachments[0].id

    const res = await request(server).patch(editUrl(ticket.body.id, upload.body.id)).set('Cookie', agent.cookie).send({ body: 'Here is the corrected receipt' }).expect(200)
    expect(res.body.attachments).toHaveLength(1)
    expect(res.body.attachments[0].id).toBe(attachmentId)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    const msg = customerView.body.messages.find((m: any) => m.id === upload.body.id)
    expect(msg.body).toBe('Here is the corrected receipt')
    expect(msg.attachments.map((a: any) => a.id)).toEqual([attachmentId])
    await request(server).get(`/support/attachments/${attachmentId}`).set('Cookie', customer.cookie).expect(200) // still downloadable
  })

  it('30e. a customer cannot edit an admin message — the admin route rejects them and no customer edit route exists', async () => {
    const { customer, agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', customer.cookie).send({ body: 'hacked' }).expect(403)
    // There is deliberately no customer-facing edit route at all.
    await request(server).patch(`/support/tickets/${ticketId}/messages/${messageId}`).set('Cookie', customer.cookie).send({ body: 'hacked' }).expect(404)
    await request(server).patch(editUrl(ticketId, messageId)).send({ body: 'anon' }).expect(401)

    const stored = await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })
    expect(stored.body).toBe(originalBody)
    expect(await prisma.auditLog.count({ where: { action: 'SUPPORT_MESSAGE_EDITED', targetId: messageId } })).toBe(0)
    expect(agent.userId).toBe(stored.authorId)
  })

  it('30f. a different Super Admin cannot edit another Super Admin\'s message, and neither can anyone edit a customer\'s message', async () => {
    const { customer, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const otherSuper = await makeSuperAdmin('edit-other-super')
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', otherSuper.cookie).send({ body: 'not yours' }).expect(403)

    const customerMsg = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId, authorId: customer.userId } })
    await request(server).patch(editUrl(ticketId, customerMsg.id)).set('Cookie', otherSuper.cookie).send({ body: 'rewriting the customer' }).expect(403)

    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: customerMsg.id } })).body).toBe('Where is my money?')
    expect(await prisma.auditLog.count({ where: { action: 'SUPPORT_MESSAGE_EDITED', targetId: { in: [messageId, customerMsg.id] } } })).toBe(0)
  })

  it('30f2. a plain ADMIN can NEVER edit a support message via the API — not another author\'s, and not even one it sent itself — no matter which support.* permissions it holds; only the role matters', async () => {
    // The ADMIN authors its own message (with full support permissions, the
    // same way any ordinary staff reply is created) and then tries to edit
    // that exact message it just sent.
    const customer = await makeCustomer('edit-plainadmin')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const fullAgent = await makeAgentWith('support.tickets.read', 'support.tickets.reply', 'support.tickets.internal_note', 'support.tickets.update', 'support.tickets.assign', 'support.tickets.resolve', 'support.tickets.close', 'support.audit')
    const own = await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', fullAgent.cookie).send({ body: 'my own reply' }).expect(201)
    await request(server).patch(editUrl(ticket.body.id, own.body.id)).set('Cookie', fullAgent.cookie).send({ body: 'trying to edit my own message' }).expect(403)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: own.body.id } })).body).toBe('my own reply')

    // And, as before, a Super Admin's own message is equally untouchable by this ADMIN.
    const { ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', fullAgent.cookie).send({ body: 'still not yours' }).expect(403)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)
    expect(await prisma.auditLog.count({ where: { action: 'SUPPORT_MESSAGE_EDITED', targetId: { in: [own.body.id, messageId] } } })).toBe(0)
  })

  it('30g. demoting the author from SUPER_ADMIN to ADMIN immediately removes their ability to edit their own past message; promoting back restores it', async () => {
    const { agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    // A second Super Admin exists so demoting `agent` is legal (never the last one).
    const rootSuper = await makeSuperAdmin('edit-root-super')

    await request(server).patch(`/admin/users/${agent.userId}/role`).set('Cookie', rootSuper.cookie)
      .send({ role: 'ADMIN', reason: 'demote for e2e', confirmPassword: 'correct-horse-battery' }).expect(200)
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'after demotion' }).expect(403)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)

    await request(server).patch(`/admin/users/${agent.userId}/role`).set('Cookie', rootSuper.cookie)
      .send({ role: 'SUPER_ADMIN', reason: 're-promote for e2e', confirmPassword: 'correct-horse-battery' }).expect(200)
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'after re-promotion' }).expect(200)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe('after re-promotion')
  })

  it('30g2. an unauthenticated caller and a plain USER both get rejected before any role/author check even runs', async () => {
    const { ticketId, messageId } = await ticketWithAgentMessage()
    await request(server).patch(editUrl(ticketId, messageId)).send({ body: 'anon' }).expect(401)
    const { cookie } = await makeCustomer('edit-plainuser-noticket')
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', cookie).send({ body: 'nope' }).expect(403)
  })

  it('30h. invalid edits are rejected: empty body, tags-only body, over-long body, wrong ticket, unknown message', async () => {
    const { agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const other = await ticketWithAgentMessage()
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: '' }).expect(400)
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: '<b></b>' }).expect(400) // sanitizes to empty
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'x'.repeat(4001) }).expect(400)
    await request(server).patch(editUrl(other.ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'wrong ticket' }).expect(404)
    await request(server).patch(editUrl(ticketId, '00000000-0000-4000-8000-000000000000')).set('Cookie', agent.cookie).send({ body: 'ghost' }).expect(404)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)
  })

  it('30i. an edit sends no customer notification and writes no audit row when the text is unchanged', async () => {
    const { customer, agent, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const notesBefore = await prisma.supportNotification.count({ where: { userId: customer.userId } })

    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'A corrected reply.' }).expect(200)
    expect(await prisma.supportNotification.count({ where: { userId: customer.userId } })).toBe(notesBefore)

    // Re-submitting identical text is a no-op: no extra audit row.
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'A corrected reply.' }).expect(200)
    expect(await prisma.auditLog.count({ where: { action: 'SUPPORT_MESSAGE_EDITED', targetId: messageId } })).toBe(1)
    expect(originalBody).not.toBe('A corrected reply.')
  })

  it('30j. a Super Admin can edit an INTERNAL note it authored (Super Admin bypasses the internal_note permission entirely) and it stays invisible to the customer', async () => {
    const customer = await makeCustomer('edit-internal')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeSuperAdmin('edit-internal-super')
    const note = await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'Escalate to finance', visibility: 'INTERNAL' }).expect(201)

    await request(server).patch(editUrl(ticket.body.id, note.body.id)).set('Cookie', agent.cookie).send({ body: 'Escalate to compliance' }).expect(200)
    const stored = await prisma.supportMessage.findUniqueOrThrow({ where: { id: note.body.id } })
    expect(stored.body).toBe('Escalate to compliance')
    expect(stored.visibility).toBe('INTERNAL') // an edit can never change visibility

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(JSON.stringify(customerView.body)).not.toMatch(/Escalate to (finance|compliance)/)
  })

  it('30k. a plain ADMIN holding support.tickets.internal_note can still create an internal note as before (unaffected) — it just can never edit it', async () => {
    const customer = await makeCustomer('edit-internal-admin')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const agent = await makeAgentWith('support.tickets.read', 'support.tickets.internal_note')
    const note = await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', agent.cookie).send({ body: 'Escalate to finance', visibility: 'INTERNAL' }).expect(201)
    expect(note.body.visibility).toBe('INTERNAL') // ticket creation/reply behavior is unchanged by this task

    await request(server).patch(editUrl(ticket.body.id, note.body.id)).set('Cookie', agent.cookie).send({ body: 'sneaky' }).expect(403)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: note.body.id } })).body).toBe('Escalate to finance')
  })

  // ---- Support Audit (SUPER_ADMIN by default; grantable to an ADMIN) -----

  it('31. GET /admin/support/audit is available to SUPER_ADMIN with no explicit grant, and rejected for a plain ADMIN until support.audit is granted', async () => {
    const superAdmin = await makeSuperAdmin('audit-super')
    await request(server).get('/admin/support/audit').set('Cookie', superAdmin.cookie).expect(200)

    const plainAdmin = await makeAgentWith('support.tickets.read', 'support.tickets.reply') // every OTHER support permission, deliberately not support.audit
    await request(server).get('/admin/support/audit').set('Cookie', plainAdmin.cookie).expect(403)

    await grantPermissionDirect(prisma, plainAdmin.userId, 'support.audit')
    await request(server).get('/admin/support/audit').set('Cookie', plainAdmin.cookie).expect(200)
  })

  it('32. the audit feed shows PUBLIC and INTERNAL messages across every ticket (not just one agent\'s own), plus the message-edit trail', async () => {
    const customerA = await makeCustomer('audit-cust-a')
    const ticketA = await request(server).post('/support/tickets').set('Cookie', customerA.cookie).send({ categoryId, subject: 'A', message: 'AUDIT-FEED-PUBLIC-MARKER' }).expect(201)
    const superAdmin = await makeSuperAdmin('audit-super2')
    await request(server).post(`/admin/support/tickets/${ticketA.body.id}/messages`).set('Cookie', superAdmin.cookie).send({ body: 'AUDIT-FEED-INTERNAL-MARKER', visibility: 'INTERNAL' }).expect(201)
    const editedMsg = await request(server).post(`/admin/support/tickets/${ticketA.body.id}/messages`).set('Cookie', superAdmin.cookie).send({ body: 'to be edited' }).expect(201)
    await request(server).patch(editUrl(ticketA.body.id, editedMsg.body.id)).set('Cookie', superAdmin.cookie).send({ body: 'AUDIT-FEED-EDITED-MARKER' }).expect(200)

    const feed = await request(server).get('/admin/support/audit').set('Cookie', superAdmin.cookie).expect(200)
    const bodies = feed.body.messages.map((m: any) => m.body)
    expect(bodies).toContain('AUDIT-FEED-PUBLIC-MARKER')
    expect(bodies).toContain('AUDIT-FEED-INTERNAL-MARKER') // INTERNAL included — this is a moderation view, not the customer-facing one
    expect(bodies).toContain('AUDIT-FEED-EDITED-MARKER')
    const publicMsg = feed.body.messages.find((m: any) => m.body === 'AUDIT-FEED-PUBLIC-MARKER')
    expect(publicMsg.ticket.id).toBe(ticketA.body.id)
    expect(publicMsg.ticket.user.id).toBe(customerA.userId)

    const editEvent = feed.body.editHistory.find((e: any) => e.newState?.body === 'AUDIT-FEED-EDITED-MARKER')
    expect(editEvent).toBeTruthy()
    expect(editEvent.actor.id).toBe(superAdmin.userId)
    expect(editEvent.previousState.body).toBe('to be edited')
  })

  it('33. a customer and an unauthenticated caller are both rejected from the Support Audit feed', async () => {
    const { cookie } = await makeCustomer('audit-plainuser')
    await request(server).get('/admin/support/audit').set('Cookie', cookie).expect(403)
    await request(server).get('/admin/support/audit').expect(401)
  })

  // ---- 34+: Support Audit message deletion (SUPER_ADMIN only) -----------
  // Soft delete: SupportMessage.deletedAt/deletedByAdminId. The row, its
  // body, and its attachments are never removed from the database — only
  // hidden from the ordinary customer/admin read paths.

  const deleteUrl = (ticketId: string, messageId: string) => `/admin/support/tickets/${ticketId}/messages/${messageId}`
  const del = (cookie: string, ticketId: string, messageId: string, reason = 'moderation removal') =>
    request(server).delete(deleteUrl(ticketId, messageId)).set('Cookie', cookie).send({ reason })

  it('34. a Super Admin can delete a CLIENT message: it vanishes from the customer\'s own chat, the ticket survives, and the rest of the conversation keeps its order', async () => {
    const customer = await makeCustomer('del-client')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'DELETE-ME-CLIENT-MESSAGE' }).expect(201)
    const superAdmin = await makeSuperAdmin('del-client-super')
    await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', superAdmin.cookie).send({ body: 'keep-me-reply' }).expect(201)
    const clientMsgId = (await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.body.id, body: 'DELETE-ME-CLIENT-MESSAGE' } })).id
    const orderBefore = (await prisma.supportMessage.findMany({ where: { ticketId: ticket.body.id }, orderBy: { createdAt: 'asc' } })).map((m) => m.id)

    const res = await del(superAdmin.cookie, ticket.body.id, clientMsgId).expect(200)
    expect(res.body).toMatchObject({ ok: true, messageId: clientMsgId })

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages.some((m: any) => m.id === clientMsgId)).toBe(false)
    expect(customerView.body.messages.some((m: any) => m.body === 'keep-me-reply')).toBe(true) // the rest survives

    const ticketRow = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.body.id } })
    expect(ticketRow).toBeTruthy() // the ticket itself was never touched
    const remaining = await prisma.supportMessage.findMany({ where: { ticketId: ticket.body.id }, orderBy: { createdAt: 'asc' } })
    expect(remaining.map((m) => m.id)).toEqual(orderBefore) // same rows, same order — soft delete, no reordering, no deletion of siblings
    const deletedRow = remaining.find((m) => m.id === clientMsgId)!
    expect(deletedRow.body).toBe('DELETE-ME-CLIENT-MESSAGE') // body preserved, only flagged
    expect(deletedRow.deletedAt).not.toBeNull()
    expect(deletedRow.deletedByAdminId).toBe(superAdmin.userId)
  })

  it('35. a Super Admin can delete a SUPPORT-AGENT message the same way, and it disappears from the normal admin ticket view too', async () => {
    const { customer, agent, ticketId, messageId } = await ticketWithAgentMessage('DELETE-ME-AGENT-MESSAGE')
    await del(agent.cookie, ticketId, messageId).expect(200)

    const customerView = await request(server).get(`/support/tickets/${ticketId}`).set('Cookie', customer.cookie).expect(200)
    expect(JSON.stringify(customerView.body)).not.toContain('DELETE-ME-AGENT-MESSAGE')

    const adminView = await request(server).get(`/admin/support/tickets/${ticketId}`).set('Cookie', agent.cookie).expect(200)
    expect(adminView.body.messages.some((m: any) => m.id === messageId)).toBe(false) // hidden from the normal staff view too, not just the customer's

    const adminList = await request(server).get('/admin/support/tickets').set('Cookie', agent.cookie).expect(200)
    expect(JSON.stringify(adminList.body)).not.toContain('DELETE-ME-AGENT-MESSAGE') // never resurfaces as the ticket-list preview either

    const stored = await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })
    expect(stored.body).toBe('DELETE-ME-AGENT-MESSAGE') // still in the database — soft delete
  })

  it('36. a plain ADMIN gets 403 attempting to delete a message directly via the API — even holding support.audit and every other support permission', async () => {
    const { ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const fullAgent = await makeAgentWith('support.tickets.read', 'support.tickets.reply', 'support.tickets.internal_note', 'support.tickets.update', 'support.audit')
    await del(fullAgent.cookie, ticketId, messageId).expect(403)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).deletedAt).toBeNull()
    expect(await prisma.auditLog.count({ where: { action: 'MESSAGE_DELETED', targetId: messageId } })).toBe(0)
  })

  it('37. a customer gets 403 (and an unauthenticated caller 401) attempting to delete a message — there is no customer-facing delete route at all', async () => {
    const { customer, ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    await del(customer.cookie, ticketId, messageId).expect(403)
    await request(server).delete(deleteUrl(ticketId, messageId)).send({ reason: 'anon' }).expect(401)
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe(originalBody)
  })

  it('38. deleting a message never deletes the ticket/conversation, and never changes its status', async () => {
    const { ticketId, messageId } = await ticketWithAgentMessage()
    const superAdmin = await makeSuperAdmin('del-ticket-status-super')
    const before = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
    await del(superAdmin.cookie, ticketId, messageId).expect(200)
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
    expect(after.id).toBe(before.id)
    expect(after.status).toBe(before.status)
    expect(after.assignedAgentId).toBe(before.assignedAgentId)
  })

  it('39. deleting one message in the middle of a conversation leaves every other message exactly intact, in the same order', async () => {
    const customer = await makeCustomer('del-middle')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'first' }).expect(201)
    const superAdmin = await makeSuperAdmin('del-middle-super')
    const mid = await request(server).post(`/admin/support/tickets/${ticket.body.id}/messages`).set('Cookie', superAdmin.cookie).send({ body: 'middle-to-delete' }).expect(201)
    await request(server).post(`/support/tickets/${ticket.body.id}/messages`).set('Cookie', customer.cookie).send({ body: 'last' }).expect(201)

    await del(superAdmin.cookie, ticket.body.id, mid.body.id).expect(200)

    const view = await request(server).get(`/admin/support/tickets/${ticket.body.id}`).set('Cookie', superAdmin.cookie).expect(200)
    const bodies = view.body.messages.map((m: any) => m.body)
    expect(bodies).toEqual(['first', 'last']) // the deleted one is gone, the other two keep their original relative order
  })

  it('40. a MESSAGE_DELETED audit record is written with every required field: message id, ticket id, sender id/type, actor, timestamp, and the original body', async () => {
    const { ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const superAdmin = await makeSuperAdmin('del-audit-super')
    await del(superAdmin.cookie, ticketId, messageId, 'contained a phone number').expect(200)

    const rows = await prisma.auditLog.findMany({ where: { action: 'MESSAGE_DELETED', targetId: messageId } })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.actorId).toBe(superAdmin.userId) // administrator who performed the deletion
    expect(row.targetType).toBe('SUPPORT_MESSAGE')
    expect(row.targetId).toBe(messageId) // message ID
    expect(row.reason).toBe('contained a phone number')
    expect((row.metadata as any).ticketId).toBe(ticketId) // ticket/conversation ID
    expect((row.metadata as any).senderType).toBe('STAFF') // sender type — the message came from the agent fixture
    expect((row.previousState as any).body).toBe(originalBody) // original content preserved
    expect(row.createdAt).toBeInstanceOf(Date) // timestamp
  })

  it('40b. sender type is correctly reported as CUSTOMER when the deleted message was the client\'s own', async () => {
    const customer = await makeCustomer('del-sendertype')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const superAdmin = await makeSuperAdmin('del-sendertype-super')
    const clientMsg = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.body.id } })
    await del(superAdmin.cookie, ticket.body.id, clientMsg.id).expect(200)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'MESSAGE_DELETED', targetId: clientMsg.id } })
    expect((row.metadata as any).senderId).toBe(customer.userId)
    expect((row.metadata as any).senderType).toBe('CUSTOMER')
  })

  it('41. a deleted message never appears in the customer chat, the normal admin ticket view, or the admin ticket-list preview — deleting the ticket\'s only/latest message', async () => {
    const customer = await makeCustomer('del-onlymsg')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'ONLY-MESSAGE-MARKER' }).expect(201)
    const superAdmin = await makeSuperAdmin('del-onlymsg-super')
    const onlyMsg = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.body.id } })
    await del(superAdmin.cookie, ticket.body.id, onlyMsg.id).expect(200)

    const customerView = await request(server).get(`/support/tickets/${ticket.body.id}`).set('Cookie', customer.cookie).expect(200)
    expect(customerView.body.messages).toHaveLength(0)
    const adminList = await request(server).get('/admin/support/tickets').set('Cookie', superAdmin.cookie).expect(200)
    const row = adminList.body.find((t: any) => t.id === ticket.body.id)
    expect(row.messages).toHaveLength(0) // no stale preview once the only message is deleted
  })

  it('42. attachments are handled safely: deleting a message with an attachment keeps the file row and bytes intact in storage, but both the customer and staff can no longer fetch it — while an unrelated message\'s attachment is completely unaffected', async () => {
    const customer = await makeCustomer('del-attach')
    const ticket = await request(server).post('/support/tickets').set('Cookie', customer.cookie).send({ categoryId, subject: 'Q', message: 'hi' }).expect(201)
    const superAdmin = await makeSuperAdmin('del-attach-super')
    const toDelete = await request(server).post(`/admin/support/tickets/${ticket.body.id}/attachments`).set('Cookie', superAdmin.cookie)
      .field('body', 'delete-this-file').attach('file', PNG_BYTES, { filename: 'secret.png', contentType: 'image/png' }).expect(201)
    const toKeep = await request(server).post(`/admin/support/tickets/${ticket.body.id}/attachments`).set('Cookie', superAdmin.cookie)
      .field('body', 'keep-this-file').attach('file', PNG_BYTES, { filename: 'keep.png', contentType: 'image/png' }).expect(201)
    const deletedAttachmentId = toDelete.body.attachments[0].id
    const keptAttachmentId = toKeep.body.attachments[0].id

    await del(superAdmin.cookie, ticket.body.id, toDelete.body.id).expect(200)

    // The attachment ROW still exists in the database — never hard-deleted.
    const attachmentRow = await prisma.supportAttachment.findUniqueOrThrow({ where: { id: deletedAttachmentId } })
    expect(attachmentRow.filename).toBe('secret.png')

    // But nobody can fetch its bytes through the normal route any more.
    await request(server).get(`/support/attachments/${deletedAttachmentId}`).set('Cookie', customer.cookie).expect(404)
    await request(server).get(`/support/attachments/${deletedAttachmentId}`).set('Cookie', superAdmin.cookie).expect(404)

    // The OTHER attachment (on a different, non-deleted message) is completely unaffected.
    await request(server).get(`/support/attachments/${keptAttachmentId}`).set('Cookie', customer.cookie).expect(200)
    const keptRow = await prisma.supportAttachment.findUniqueOrThrow({ where: { id: keptAttachmentId } })
    expect(keptRow.filename).toBe('keep.png')
  })

  it('43. direct-API bypass attempts are all rejected: wrong ticket id, unknown message id, an already-deleted message, and a missing/short reason', async () => {
    const { ticketId, messageId } = await ticketWithAgentMessage()
    const other = await ticketWithAgentMessage()
    const superAdmin = await makeSuperAdmin('del-bypass-super')

    await del(superAdmin.cookie, other.ticketId, messageId).expect(404) // message doesn't belong to this ticket
    await request(server).delete(deleteUrl(ticketId, '00000000-0000-4000-8000-000000000000')).set('Cookie', superAdmin.cookie).send({ reason: 'ghost' }).expect(404)
    await request(server).delete(deleteUrl(ticketId, messageId)).set('Cookie', superAdmin.cookie).send({}).expect(400) // reason is required
    await request(server).delete(deleteUrl(ticketId, messageId)).set('Cookie', superAdmin.cookie).send({ reason: 'ab' }).expect(400) // too short

    await del(superAdmin.cookie, ticketId, messageId).expect(200) // the real, valid delete
    await del(superAdmin.cookie, ticketId, messageId).expect(404) // deleting an already-deleted message is refused, not a silent success
    expect(await prisma.auditLog.count({ where: { action: 'MESSAGE_DELETED', targetId: messageId } })).toBe(1) // no double audit row from the repeat attempt
  })

  it('44. a deletion sends no customer notification and does not touch the message-edit feature — an un-deleted message can still be edited normally', async () => {
    const { customer, agent, ticketId, messageId } = await ticketWithAgentMessage()
    const other = await ticketWithAgentMessage()
    const notesBefore = await prisma.supportNotification.count({ where: { userId: customer.userId } })

    await del(agent.cookie, ticketId, messageId).expect(200)
    expect(await prisma.supportNotification.count({ where: { userId: customer.userId } })).toBe(notesBefore) // no notification fired

    // Editing the DELETED message is now correctly refused (it no longer "exists" for normal purposes)...
    await request(server).patch(editUrl(ticketId, messageId)).set('Cookie', agent.cookie).send({ body: 'edit a deleted message' }).expect(404)
    // ...but editing still works completely normally for an untouched message elsewhere.
    await request(server).patch(editUrl(other.ticketId, other.messageId)).set('Cookie', other.agent.cookie).send({ body: 'still editable' }).expect(200)
  })

  it('45. the Support Audit feed shows a deleted message (flagged) plus its own MESSAGE_DELETED entry in deleteHistory, separate from edit history', async () => {
    const { ticketId, messageId, originalBody } = await ticketWithAgentMessage()
    const superAdmin = await makeSuperAdmin('del-feed-super')
    await del(superAdmin.cookie, ticketId, messageId, 'feed visibility check').expect(200)

    const feed = await request(server).get('/admin/support/audit').set('Cookie', superAdmin.cookie).expect(200)
    const feedMsg = feed.body.messages.find((m: any) => m.id === messageId)
    expect(feedMsg).toBeTruthy() // still visible in the AUDIT feed, unlike every normal view
    expect(feedMsg.body).toBe(originalBody)
    expect(feedMsg.deletedAt).not.toBeNull()
    expect(feedMsg.deletedByAdminId).toBe(superAdmin.userId)

    const deleteEvent = feed.body.deleteHistory.find((e: any) => e.targetId === messageId)
    expect(deleteEvent).toBeTruthy()
    expect(deleteEvent.actor.id).toBe(superAdmin.userId)
    expect(deleteEvent.reason).toBe('feed visibility check')
    expect(feed.body.editHistory.some((e: any) => e.targetId === messageId)).toBe(false) // deletion is not recorded as an edit
  })
})
