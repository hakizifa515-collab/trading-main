import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AuditService } from '../audit/audit.service'
import { AuditEvent } from '../audit/audit-events'
import type { PermissionKey } from '../common/permissions'
import { sanitizeText } from '../cms/cms.validation'
import { MediaStorageService } from '../cms/media-storage.service'
import { PlatformSettingsService } from '../platform-settings/platform-settings.service'
import { EmailService } from '../email/email.service'
import type { CreateTicketDto, CreateMessageDto, CreateStaffTicketDto, EditMessageDto, DeleteMessageDto } from './dto/ticket.dto'
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto'

type UploadedFileLike = { originalname: string; mimetype: string; buffer: Buffer }

const VALID_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  WAITING_INTERNAL: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], // reopen a resolved ticket back to IN_PROGRESS
  CLOSED: ['OPEN'], // reopening a closed ticket is an explicit staff action
}

/**
 * Financial boundary (Part 17): nothing in this service, or in either
 * SupportController/AdminSupportController, ever imports LedgerService,
 * AccountsService, DepositsService, WithdrawalsService, or AdminService's
 * financial methods. A support agent with every support.* permission
 * granted still cannot move a single dollar — that requires a completely
 * separate set of financial permissions (ledger.adjust, withdrawals.review,
 * etc.) checked by PermissionsGuard on the financial controllers, which
 * this module never touches.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger('SupportService')

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaStorageService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly email: EmailService,
  ) {}

  // ---- Categories -----------------------------------------------------------------

  listActiveCategories() {
    return this.prisma.supportCategory.findMany({ where: { isActive: true }, orderBy: { order: 'asc' } })
  }

  listAllCategories() {
    return this.prisma.supportCategory.findMany({ orderBy: { order: 'asc' } })
  }

  async createCategory(dto: CreateCategoryDto, adminId: string) {
    const category = await this.prisma.supportCategory.create({
      data: { name: sanitizeText(dto.name), description: dto.description ? sanitizeText(dto.description) : undefined, order: dto.order ?? 0 },
    })
    await this.audit.record({ actorId: adminId, action: AuditEvent.SUPPORT_CATEGORY_CHANGED, targetType: 'SUPPORT_CATEGORY', targetId: category.id, newState: { created: true } })
    return category
  }

  // Deliberately no deleteCategory() — categories referenced by historical
  // tickets must never disappear (Part 9). Deactivate via isActive instead;
  // the FK from SupportTicket.categoryId is RESTRICT at the DB level too, as
  // a second layer independent of this service ever having a delete method.
  async updateCategory(id: string, dto: UpdateCategoryDto, adminId: string) {
    const existing = await this.prisma.supportCategory.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Category not found.')
    const updated = await this.prisma.supportCategory.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? sanitizeText(dto.name) : undefined,
        description: dto.description !== undefined ? sanitizeText(dto.description) : undefined,
        order: dto.order,
        isActive: dto.isActive,
      },
    })
    await this.audit.record({ actorId: adminId, action: AuditEvent.SUPPORT_CATEGORY_CHANGED, targetType: 'SUPPORT_CATEGORY', targetId: id, previousState: { name: existing.name, isActive: existing.isActive }, newState: { name: updated.name, isActive: updated.isActive } })
    return updated
  }

  // ---- Customer-facing --------------------------------------------------------------

  // Deliberately does not create an in-app SupportNotification: a
  // brand-new ticket has no assigned agent yet, and this system has no
  // all-staff broadcast/subscription concept (Part 16) — any agent with
  // support.tickets.read already sees it immediately in the ticket list.
  // That in-app mechanism needs an actual individual USER recipient, not a
  // fabricated one — but the ADMIN NOTIFICATIONS email below is a
  // different channel (a configured address, not a user), so it has no
  // such limitation and fires here unconditionally.
  async createTicket(userId: string, dto: CreateTicketDto) {
    const category = await this.prisma.supportCategory.findUnique({ where: { id: dto.categoryId } })
    if (!category || !category.isActive) throw new BadRequestException('Selected category is not available.')

    const requestedPriority = dto.requestedPriority ?? 'NORMAL'
    const sanitizedMessage = sanitizeText(dto.message)
    const ticket = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          categoryId: dto.categoryId,
          subject: sanitizeText(dto.subject),
          requestedPriority,
          priority: requestedPriority, // starting point only — staff may change it later, this is not re-derived from requestedPriority again
        },
      })
      await tx.supportMessage.create({
        data: { ticketId: ticket.id, authorId: userId, body: sanitizedMessage, visibility: 'PUBLIC' },
      })

      // Auto-greeting (Part: Customer Support redesign) — a real, persisted
      // reply from an actual staff account, never a fabricated/bot sender.
      // Re-validates the configured sender is still a real ADMIN/SUPER_ADMIN
      // at send time (not just when the setting was saved) — if the account
      // was since demoted or deleted, the greeting is silently skipped
      // rather than blocking ticket creation or falling back to some other
      // sender.
      const settings = await this.platformSettings.get()
      if (settings.supportAutoGreetingEnabled && settings.supportAutoGreetingMessage && settings.supportAutoGreetingSenderId) {
        const sender = await tx.user.findUnique({ where: { id: settings.supportAutoGreetingSenderId }, select: { id: true, role: true } })
        if (sender && (sender.role === 'ADMIN' || sender.role === 'SUPER_ADMIN')) {
          await tx.supportMessage.create({
            data: { ticketId: ticket.id, authorId: sender.id, body: settings.supportAutoGreetingMessage, visibility: 'PUBLIC' },
          })
        }
      }

      return ticket
    })

    // ADMIN NOTIFICATIONS — deliberately AFTER the transaction has already
    // committed, never inside it: an interactive-transaction retry (e.g. on
    // a write-conflict) would otherwise re-run this alongside the DB writes
    // and could send the email more than once for what is ultimately a
    // single committed ticket. A failure here is caught inside
    // sendAdminNotification() and can never fail ticket creation itself.
    const customer = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } })
    await this.sendAdminNotification('NEW_TICKET', { id: ticket.id, subject: ticket.subject, category, user: customer }, sanitizedMessage, ticket.createdAt)

    return ticket
  }

  async listMyTickets(userId: string) {
    return this.prisma.supportTicket.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, include: { category: true } })
  }

  // Returns the ticket with only PUBLIC, non-deleted messages — INTERNAL
  // notes and soft-deleted messages (Support Audit) are both filtered out at
  // the query level (not just hidden by the frontend), so there is no
  // response payload for a customer request that ever contains internal-note
  // or deleted content in the first place.
  async getTicketForCustomer(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { category: true, messages: { where: { visibility: 'PUBLIC', deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { attachments: true } } },
    })
    if (!ticket) throw new NotFoundException('Ticket not found.')
    if (ticket.userId !== userId) throw new ForbiddenException('You do not have access to this ticket.')
    return ticket
  }

  async addCustomerMessage(userId: string, ticketId: string, dto: CreateMessageDto) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { category: true, user: { select: { email: true, fullName: true } } },
    })
    if (!ticket) throw new NotFoundException('Ticket not found.')
    if (ticket.userId !== userId) throw new ForbiddenException('You do not have access to this ticket.')
    if (ticket.status === 'CLOSED') throw new BadRequestException('This ticket is closed. Contact support to reopen it.')

    // A customer message is ALWAYS visibility: PUBLIC — dto.visibility is
    // simply never read here, regardless of what a manipulated request body
    // contains (see support.e2e-spec.ts's internal-note-spoofing test).
    const nextStatus = ticket.status === 'RESOLVED' ? 'IN_PROGRESS' : ticket.status === 'WAITING_FOR_CUSTOMER' ? 'WAITING_INTERNAL' : ticket.status
    const sanitizedBody = sanitizeText(dto.body)

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportMessage.create({
        data: { ticketId, authorId: userId, body: sanitizedBody, visibility: 'PUBLIC' },
      })
      if (nextStatus !== ticket.status) {
        await tx.supportTicket.update({ where: { id: ticketId }, data: { status: nextStatus as any } })
      }
      return created
    })
    // Notify the assigned agent, if any — an unassigned ticket has no
    // individual staff recipient yet (see createTicket's comment on why
    // ticket creation itself notifies nobody), so this is a no-op until a
    // ticket has been assigned to someone.
    if (ticket.assignedAgentId) {
      await this.notify(ticket.assignedAgentId, ticketId, 'CUSTOMER_REPLIED', `New customer reply on "${ticket.subject}".`)
    }
    // ADMIN NOTIFICATIONS — every customer reply puts the ticket back in
    // admin's court, regardless of whether it happens to be assigned to a
    // specific agent yet (unlike the in-app notify() above, this channel's
    // recipient is a configured address, not a specific staff user, so it
    // has no "unassigned = nobody to tell" limitation). Never fired for an
    // admin's own reply — see addStaffMessage, which never calls this.
    await this.sendAdminNotification('CUSTOMER_REPLY', { id: ticket.id, subject: ticket.subject, category: ticket.category, user: ticket.user }, sanitizedBody, message.createdAt)
    return message
  }

  // ---- Staff / admin ------------------------------------------------------------------

  // Lightweight, Support-scoped user lookup for "contact any user" — a
  // dedicated search rather than reusing AdminService.listUsers() so this
  // stays gated by the Support permission domain (support.tickets.reply)
  // instead of requiring the separate, broader users.read permission (see
  // this module's own financial/permission-boundary comment at the top of
  // this class). Returns just enough to populate a picker: no balances, no
  // KYC status, no admin-wide fields.
  async searchUsersForSupport(q?: string) {
    const search = q?.trim()
    return this.prisma.user.findMany({
      where: search ? { OR: [{ email: { contains: search, mode: 'insensitive' } }, { fullName: { contains: search, mode: 'insensitive' } }, { id: search }] } : undefined,
      select: { id: true, email: true, fullName: true },
      orderBy: { fullName: 'asc' },
      take: 20,
    })
  }

  // Admin-initiated conversation — the mirror of createTicket() above:
  // same shape (one ticket + one opening PUBLIC message, in one
  // transaction), but the caller specifies which user it belongs to and
  // the opening message is authored by the admin instead of the customer.
  // Auto-assigns the starting admin as the ticket's agent so the
  // existing in-app notify() on the customer's next reply (addCustomerMessage)
  // has someone to notify, and auto-picks the first active category the
  // same way the customer-facing chat-first flow does, since there is no
  // category picker in this UI either.
  async createTicketAsStaff(adminId: string, dto: CreateStaffTicketDto) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } })
    if (!user) throw new NotFoundException('User not found.')

    const category = dto.categoryId
      ? await this.prisma.supportCategory.findUnique({ where: { id: dto.categoryId } })
      : await this.prisma.supportCategory.findFirst({ where: { isActive: true }, orderBy: { order: 'asc' } })
    if (!category || !category.isActive) throw new BadRequestException('Selected category is not available.')

    const sanitizedMessage = sanitizeText(dto.message)
    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          userId: dto.userId,
          categoryId: category.id,
          subject: 'Message from Support Team',
          requestedPriority: 'NORMAL',
          priority: 'NORMAL',
          assignedAgentId: adminId,
        },
      })
      await tx.supportMessage.create({
        data: { ticketId: created.id, authorId: adminId, body: sanitizedMessage, visibility: 'PUBLIC' },
      })
      return created
    })

    await this.audit.record({ actorId: adminId, action: AuditEvent.TICKET_STARTED_BY_STAFF, targetType: 'SUPPORT_TICKET', targetId: ticket.id, metadata: { userId: dto.userId } })
    await this.notify(dto.userId, ticket.id, 'AGENT_REPLIED', 'Support sent you a message.')
    return this.getTicketForStaff(ticket.id, adminId)
  }

  listAllTickets(status?: string) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: {
        category: true,
        user: { select: { id: true, email: true, fullName: true } },
        assignedAgent: { select: { id: true, email: true, fullName: true } },
        // Last-message preview for the ticket list (Customer Support
        // redesign) — PUBLIC and non-deleted only, so a staff member with
        // support.tickets.read but not the separate
        // support.tickets.internal_note permission never sees internal-note
        // content leak into a list preview, and a deleted message (Support
        // Audit) never resurfaces here either.
        messages: { where: { visibility: 'PUBLIC', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
  }

  // ---- Support Audit (cross-ticket moderation feed) --------------------
  // Gated by the support.audit permission at the controller — SUPER_ADMIN
  // has it via PermissionsGuard's role bypass, same as every permission; a
  // plain ADMIN only has it if a SUPER_ADMIN explicitly grants it. Unlike
  // every other read in this service, this deliberately crosses ticket
  // boundaries (every ticket, every message, PUBLIC and INTERNAL) — it is a
  // moderation/investigation view, not a working agent's own queue.
  //
  // Deliberately does NOT filter out soft-deleted messages (the only place
  // in this whole service that doesn't) — an investigator needs to see that
  // a message existed and was removed, which is exactly why deletion is a
  // soft flag rather than a hard delete. Each message's own deletedAt/
  // deletedByAdminId fields (returned as plain scalars, no extra work
  // needed) tell the frontend which rows are deleted; deleteHistory below is
  // the authoritative MESSAGE_DELETED audit trail for who/why/when.
  async listSupportAuditFeed(limit = 100) {
    const take = Math.min(Math.max(limit, 1), 300)
    const [messages, editHistory, deleteHistory] = await Promise.all([
      this.prisma.supportMessage.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          author: { select: { id: true, email: true, fullName: true, role: true } },
          attachments: true,
          ticket: { select: { id: true, subject: true, status: true, userId: true, user: { select: { id: true, email: true, fullName: true } } } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { action: AuditEvent.SUPPORT_MESSAGE_EDITED },
        orderBy: { createdAt: 'desc' },
        take,
        include: { actor: { select: { id: true, email: true, fullName: true } } },
      }),
      this.prisma.auditLog.findMany({
        where: { action: AuditEvent.MESSAGE_DELETED },
        orderBy: { createdAt: 'desc' },
        take,
        include: { actor: { select: { id: true, email: true, fullName: true } } },
      }),
    ])
    return { messages, editHistory, deleteHistory }
  }

  // Deliberately excludes soft-deleted messages (Support Audit) — same
  // "clean normal view" treatment as PUBLIC-only filtering for a customer;
  // a deleted message is reviewable ONLY through listSupportAuditFeed()
  // above, never through the ordinary staff ticket view.
  //
  // `viewerId` is used only to compute `viewerCanEditMessages`, a UX-only
  // convenience flag telling the frontend whether to offer the edit gesture
  // at all — the PATCH route's own @RequirePermissions('support.messages.edit')
  // and editStaffMessage()'s own assertPermission() re-check remain the
  // actual, authoritative enforcement regardless of what this flag says.
  async getTicketForStaff(ticketId: string, viewerId: string) {
    const [ticket, viewerCanEditMessages] = await Promise.all([
      this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          category: true,
          user: { select: { id: true, email: true, fullName: true, kycStatus: true } },
          assignedAgent: { select: { id: true, email: true, fullName: true } },
          messages: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, email: true, fullName: true, role: true } }, attachments: true } },
        },
      }),
      this.hasPermission(viewerId, 'support.messages.edit'),
    ])
    if (!ticket) throw new NotFoundException('Ticket not found.')
    return { ...ticket, viewerCanEditMessages }
  }

  // A staff reply defaults to PUBLIC (visible to the customer); INTERNAL
  // requires the separate support.tickets.internal_note permission, checked
  // here — not by the route's baseline support.tickets.reply permission
  // alone, since "can reply to customers" and "can write staff-only notes"
  // are deliberately different capabilities (Part 12/13).
  async addStaffMessage(adminId: string, ticketId: string, dto: CreateMessageDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException('Ticket not found.')

    const visibility = dto.visibility === 'INTERNAL' ? 'INTERNAL' : 'PUBLIC'
    if (visibility === 'INTERNAL') {
      await this.assertPermission(adminId, 'support.tickets.internal_note')
    } else {
      await this.assertPermission(adminId, 'support.tickets.reply')
    }

    const message = await this.prisma.supportMessage.create({
      data: { ticketId, authorId: adminId, body: sanitizeText(dto.body), visibility },
    })
    if (visibility === 'INTERNAL') {
      await this.audit.record({ actorId: adminId, action: AuditEvent.INTERNAL_NOTE_CREATED, targetType: 'SUPPORT_TICKET', targetId: ticketId })
    } else {
      // Only a PUBLIC reply notifies the customer — an internal note is, by
      // definition, something the customer must never learn even exists.
      await this.notify(ticket.userId, ticketId, 'AGENT_REPLIED', `Support replied on "${ticket.subject}".`)
    }
    return message
  }

  // A staff member correcting a message THEY sent. Only SupportMessage.body
  // is rewritten — attachments, createdAt (so ordering), visibility, author
  // and the ticket itself are untouched, and no new message row is created.
  //
  // Deliberately leaves SupportMessage.editedAt NULL: that column travels in
  // every customer/admin conversation payload, so setting it would hand the
  // "this was edited" signal (and its timestamp) to exactly the surfaces that
  // must show a clean, natural thread. The accountability record lives in the
  // append-only AuditLog instead (previousState.body = text before,
  // newState.body = text after, createdAt = when, actorId = who), which no
  // Support endpoint returns. Chaining edits therefore preserves EVERY
  // version, and the first row's previousState is always the original.
  //
  // No customer notification and no admin email: an edit is a correction to
  // an existing message, not new activity on the ticket.
  //
  // SUPER_ADMIN always; a plain ADMIN only with the explicit
  // support.messages.edit grant. Checked again here via assertPermission(),
  // not just by AdminSupportController.editMessage()'s
  // @RequirePermissions('support.messages.edit') — the same defense-in-depth
  // posture as every other fund/accountability-critical check in this
  // codebase (e.g. isDemoResultModeAllowed() in the options settlement
  // path). Granting every OTHER support.* (or any other) permission does
  // not include this one — it must be granted explicitly, same as any
  // permission. On top of that the caller must still be the message's own
  // author — a SUPER_ADMIN or a permitted ADMIN still cannot edit another
  // admin's or a customer's message.
  async editStaffMessage(adminId: string, ticketId: string, messageId: string, dto: EditMessageDto) {
    await this.assertPermission(adminId, 'support.messages.edit')

    const message = await this.prisma.supportMessage.findUnique({ where: { id: messageId } })
    if (!message || message.ticketId !== ticketId || message.deletedAt) throw new NotFoundException('Message not found.')
    if (message.authorId !== adminId) throw new ForbiddenException('You can only edit messages you sent.')

    const newBody = sanitizeText(dto.body)
    if (!newBody) throw new BadRequestException('Message cannot be empty.')

    const include = { attachments: true, author: { select: { id: true, email: true, fullName: true, role: true } } } as const
    if (newBody === message.body) {
      return this.prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId }, include })
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.supportMessage.update({ where: { id: messageId }, data: { body: newBody }, include })
      await this.audit.record({
        actorId: adminId,
        action: AuditEvent.SUPPORT_MESSAGE_EDITED,
        targetType: 'SUPPORT_MESSAGE',
        targetId: messageId,
        previousState: { body: message.body },
        newState: { body: newBody },
        metadata: { ticketId, visibility: message.visibility },
      }, tx)
      return updated
    })
  }

  // Support Audit — soft-deleting ONE message. SUPER_ADMIN ONLY, checked
  // again here on top of AdminSupportController.deleteMessage()'s own
  // @Roles('SUPER_ADMIN') (same defense-in-depth posture as
  // editStaffMessage() immediately above) — deletion is not a permission
  // grantable to a plain ADMIN, no matter which support.* permissions
  // (support.audit included) it holds; it is a role. Unlike editing, there is
  // no author-only rule: a Super Admin may delete ANY message — a client's
  // or an agent's — which is exactly the moderation capability Support Audit
  // exists for.
  //
  // This ONLY sets deletedAt/deletedByAdminId on the SupportMessage row —
  // the row itself, its body, and its attachments are never touched or
  // removed, and neither the parent SupportTicket nor any sibling message is
  // touched. The original body is preserved a second time, independently, in
  // the MESSAGE_DELETED AuditLog's previousState — so it survives even in a
  // hypothetical future where the message row's own body were ever scrubbed.
  // No customer notification, no admin email, no ticket-status change: a
  // deletion is a moderation action, not new ticket activity.
  async deleteStaffMessage(adminId: string, ticketId: string, messageId: string, dto: DeleteMessageDto) {
    const admin = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId } })
    if (admin.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only a Super Admin can delete a support message.')

    const message = await this.prisma.supportMessage.findUnique({ where: { id: messageId }, include: { ticket: { select: { userId: true } } } })
    if (!message || message.ticketId !== ticketId || message.deletedAt) throw new NotFoundException('Message not found.')

    const senderType = message.authorId === message.ticket.userId ? 'CUSTOMER' : 'STAFF'
    const now = new Date()

    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.update({ where: { id: messageId }, data: { deletedAt: now, deletedByAdminId: adminId } })
      await this.audit.record({
        actorId: adminId,
        action: AuditEvent.MESSAGE_DELETED,
        targetType: 'SUPPORT_MESSAGE',
        targetId: messageId,
        reason: dto.reason,
        previousState: { body: message.body, visibility: message.visibility },
        newState: { deleted: true },
        metadata: { ticketId, senderId: message.authorId, senderType },
      }, tx)
    })

    return { ok: true, messageId, deletedAt: now }
  }

  async updateStatus(adminId: string, ticketId: string, status: string, reason?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException('Ticket not found.')

    const allowed = VALID_TRANSITIONS[ticket.status] ?? []
    if (!allowed.includes(status)) {
      throw new BadRequestException(`Cannot transition a ${ticket.status} ticket directly to ${status}.`)
    }

    // Resolve/close are their own permissions, on top of the baseline
    // support.tickets.update the route already requires — see Part 13.
    if (status === 'RESOLVED') await this.assertPermission(adminId, 'support.tickets.resolve')
    if (status === 'CLOSED') await this.assertPermission(adminId, 'support.tickets.close')

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: status as any,
        resolvedAt: status === 'RESOLVED' ? new Date() : status === 'IN_PROGRESS' && ticket.status === 'RESOLVED' ? null : undefined,
        closedAt: status === 'CLOSED' ? new Date() : undefined,
      },
    })
    await this.audit.record({ actorId: adminId, action: AuditEvent.TICKET_STATUS_CHANGED, targetType: 'SUPPORT_TICKET', targetId: ticketId, previousState: { status: ticket.status }, newState: { status }, reason })

    // RESOLVED and CLOSED-then-reopened-to-OPEN get their own named events
    // (Part 16's required list treats them as distinct from a generic status
    // change); every other transition notifies as a plain STATUS_CHANGED.
    const event = status === 'RESOLVED' ? 'TICKET_RESOLVED' : ticket.status === 'CLOSED' && status === 'OPEN' ? 'TICKET_REOPENED' : 'STATUS_CHANGED'
    await this.notify(ticket.userId, ticketId, event, `Your ticket "${ticket.subject}" is now ${status.replace(/_/g, ' ')}.`)
    return updated
  }

  async updatePriority(adminId: string, ticketId: string, priority: string, reason?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException('Ticket not found.')
    const updated = await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { priority: priority as any } })
    await this.audit.record({ actorId: adminId, action: AuditEvent.TICKET_PRIORITY_CHANGED, targetType: 'SUPPORT_TICKET', targetId: ticketId, previousState: { priority: ticket.priority }, newState: { priority }, reason })
    return updated
  }

  async assignTicket(adminId: string, ticketId: string, agentId: string, reason?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException('Ticket not found.')
    const agent = await this.prisma.user.findUnique({ where: { id: agentId } })
    if (!agent || agent.role === 'USER') throw new BadRequestException('Assignee must be an admin/support-staff account.')

    const updated = await this.prisma.$transaction(async (tx) => {
      // Close out the previous open assignment (if any) rather than
      // deleting it — preserves the full assignment trail (Part 14).
      await tx.supportAssignment.updateMany({
        where: { ticketId, unassignedAt: null },
        data: { unassignedAt: new Date() },
      })
      await tx.supportAssignment.create({
        data: { ticketId, agentId, assignedByAdminId: adminId },
      })
      const result = await tx.supportTicket.update({ where: { id: ticketId }, data: { assignedAgentId: agentId } })
      await this.audit.record({ actorId: adminId, action: AuditEvent.TICKET_ASSIGNED, targetType: 'SUPPORT_TICKET', targetId: ticketId, previousState: { assignedAgentId: ticket.assignedAgentId }, newState: { assignedAgentId: agentId }, reason })
      return result
    })
    await this.notify(agentId, ticketId, 'TICKET_ASSIGNED', `You were assigned ticket "${ticket.subject}".`)
    return updated
  }

  async listAssignmentHistory(ticketId: string) {
    return this.prisma.supportAssignment.findMany({ where: { ticketId }, orderBy: { assignedAt: 'desc' }, include: { agent: { select: { id: true, email: true, fullName: true } }, assignedBy: { select: { id: true, email: true, fullName: true } } } })
  }

  // Staff who can be assigned a ticket — any ADMIN/SUPER_ADMIN account, not
  // filtered by which support.* permissions they hold (an assigner decides
  // who's the right person; this just needs to exclude plain customers).
  // Gated by support.tickets.assign at the route, same as assignTicket
  // itself — deliberately does NOT require admins.read (a separate,
  // financial-admin-adjacent permission domain this module never reaches
  // into, consistent with the module's financial-boundary design).
  listAssignableAgents() {
    return this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
      select: { id: true, email: true, fullName: true, role: true },
      orderBy: { fullName: 'asc' },
    })
  }

  // ---- Notifications (Part 16) -----------------------------------------------------

  private async notify(userId: string, ticketId: string, event: string, message: string) {
    await this.prisma.supportNotification.create({ data: { userId, ticketId, event, message } })
  }

  // ---- Admin email notifications (ADMIN NOTIFICATIONS feature) ----------------------
  // A SEPARATE channel from notify() above: that creates an in-app
  // SupportNotification row for one specific USER; this emails a
  // configured ADDRESS (PlatformSettings.supportNotificationEmail) that
  // need not correspond to any single user account (e.g. a shared ops
  // inbox) — see platform-settings.service.ts. Only ever called from
  // customer-initiated paths (createTicket, addCustomerMessage,
  // addAttachmentAsCustomer); addStaffMessage/addAttachmentAsStaff never
  // call this, so "no admin self-notification on an admin's own reply" is
  // structural, not a runtime check. Always invoked AFTER the triggering
  // write has already committed (never from inside a $transaction — a
  // transaction retry must never risk a duplicate send), and always
  // swallows its own errors: a delivery failure must never fail the
  // support request that triggered it (same division of responsibility as
  // auth.service.ts's forgotPassword() around sendPasswordResetEmail()).
  private async sendAdminNotification(
    kind: 'NEW_TICKET' | 'CUSTOMER_REPLY',
    ticket: { id: string; subject: string; category: { name: string } | null; user: { email: string; fullName: string } | null },
    messagePreview: string,
    createdAt: Date,
  ): Promise<void> {
    const settings = await this.platformSettings.get()
    const toEmail = settings.supportNotificationEmail
    if (!toEmail) return // feature is a silent no-op until an address is configured — never a hardcoded fallback
    try {
      await this.email.sendSupportNotificationEmail(toEmail, {
        kind,
        ticketId: ticket.id,
        ticketSubject: ticket.subject,
        categoryName: ticket.category?.name ?? 'Uncategorized',
        customerLabel: ticket.user?.fullName || ticket.user?.email || 'Unknown customer',
        messagePreview: messagePreview.length > 300 ? `${messagePreview.slice(0, 300)}…` : messagePreview,
        createdAt,
        ticketUrl: this.buildAdminTicketUrl(ticket.id),
      })
    } catch (err) {
      this.logger.error(`Failed to send support admin notification (${kind}, ticket ${ticket.id}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // No auth token, session cookie, or any other secret in this URL (ADMIN
  // NOTIFICATIONS security requirement) — a plain deep link into the
  // EXISTING authenticated /admin/support route. Whoever clicks it still
  // has to sign in as an admin exactly as if they'd navigated there by
  // hand; the ticket id in the query string grants no access by itself
  // (SupportService.getTicketForStaff() / the support.tickets.read
  // permission check is what actually gates the data, unchanged by this
  // feature).
  private buildAdminTicketUrl(ticketId: string): string {
    const origin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
    return `${origin}/admin/support?ticket=${ticketId}`
  }

  listMyNotifications(userId: string) {
    return this.prisma.supportNotification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  }

  // With no `ids`, marks every one of the caller's own unread notifications
  // read — always scoped to userId in the WHERE clause, so this can never
  // touch another user's notifications no matter what ids are supplied
  // (updateMany silently matches zero rows for an id that isn't both
  // unread AND owned by this user, rather than erroring — the safe default
  // for a "mark read" action).
  async markNotificationsRead(userId: string, ids?: string[]) {
    await this.prisma.supportNotification.updateMany({
      where: { userId, readAt: null, ...(ids && ids.length > 0 ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    })
    return { ok: true }
  }

  // ---- Attachments (Part 15) ---------------------------------------------------------
  // Reuses MediaStorageService exactly as CmsMedia does — same allowlist,
  // size limit, magic-byte check, random storage key. Unlike CmsMedia,
  // bytes are only ever returned via getAttachmentFile()'s ownership/
  // permission check below — there is no public URL for a support
  // attachment.

  async addAttachmentAsCustomer(userId: string, ticketId: string, file: UploadedFileLike, body?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { category: true, user: { select: { email: true, fullName: true } } },
    })
    if (!ticket) throw new NotFoundException('Ticket not found.')
    if (ticket.userId !== userId) throw new ForbiddenException('You do not have access to this ticket.')
    if (ticket.status === 'CLOSED') throw new BadRequestException('This ticket is closed. Contact support to reopen it.')

    const message = await this.createMessageWithAttachment(ticketId, userId, 'PUBLIC', file, body)
    if (ticket.assignedAgentId) {
      await this.notify(ticket.assignedAgentId, ticketId, 'CUSTOMER_REPLIED', `New customer reply on "${ticket.subject}".`)
    }
    // ADMIN NOTIFICATIONS — same reasoning as addCustomerMessage above.
    await this.sendAdminNotification('CUSTOMER_REPLY', { id: ticket.id, subject: ticket.subject, category: ticket.category, user: ticket.user }, message.body, message.createdAt)
    return message
  }

  async addAttachmentAsStaff(adminId: string, ticketId: string, file: UploadedFileLike, visibility: 'PUBLIC' | 'INTERNAL', body?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) throw new NotFoundException('Ticket not found.')

    if (visibility === 'INTERNAL') {
      await this.assertPermission(adminId, 'support.tickets.internal_note')
    } else {
      await this.assertPermission(adminId, 'support.tickets.reply')
    }

    const message = await this.createMessageWithAttachment(ticketId, adminId, visibility, file, body)
    if (visibility === 'INTERNAL') {
      await this.audit.record({ actorId: adminId, action: AuditEvent.INTERNAL_NOTE_CREATED, targetType: 'SUPPORT_TICKET', targetId: ticketId })
    } else {
      await this.notify(ticket.userId, ticketId, 'AGENT_REPLIED', `Support replied on "${ticket.subject}".`)
    }
    return message
  }

  private async createMessageWithAttachment(ticketId: string, authorId: string, visibility: 'PUBLIC' | 'INTERNAL', file: UploadedFileLike, body?: string) {
    const safeName = sanitizeText(file.originalname).slice(0, 200) || 'attachment'
    const { storageKey, size } = await this.media.save(file.originalname, file.mimetype, file.buffer)
    return this.prisma.supportMessage.create({
      data: {
        ticketId,
        authorId,
        visibility,
        body: body ? sanitizeText(body) : `Attached: ${safeName}`,
        attachments: {
          create: { filename: safeName, mimeType: file.mimetype, size, storageKey, uploadedByUserId: authorId },
        },
      },
      include: { attachments: true },
    })
  }

  // Authorization here is deliberately NOT route-decorator-based (same
  // reasoning as addStaffMessage): the ticket owner may always fetch their
  // own attachments; anyone else needs support.tickets.read. No public URL
  // exists for a support attachment (contrast CmsMedia, which is
  // intentionally public) — this is the only path to the bytes.
  async getAttachmentFile(requesterId: string, attachmentId: string) {
    const attachment = await this.prisma.supportAttachment.findUnique({
      where: { id: attachmentId },
      include: { message: { include: { ticket: true } } },
    })
    // Support Audit — once the parent message is soft-deleted, its
    // attachment(s) are no longer served through this route for ANYONE
    // (customer or staff alike), matching "no deleted content in a normal
    // response" for attachments too. A Super Admin investigating in Support
    // Audit still sees the attachment's own metadata (filename, size) in
    // listSupportAuditFeed() — only the byte stream is unreachable here.
    if (!attachment || attachment.message.deletedAt) throw new NotFoundException('Attachment not found.')
    const ticket = attachment.message.ticket
    if (ticket.userId !== requesterId) {
      await this.assertPermission(requesterId, 'support.tickets.read')
    }
    const stream = await this.media.getObjectStream(attachment.storageKey)
    return { stream, mimeType: attachment.mimeType, filename: attachment.filename }
  }

  // Mirrors PermissionsGuard's own check (SUPER_ADMIN bypasses; ADMIN needs
  // an explicit grant). Used both where the required permission depends on
  // a value in the request body (target status, message visibility) rather
  // than being fixed at route-definition time — so the declarative
  // @RequirePermissions() decorator alone can't express it — and as a
  // defense-in-depth re-check inside a service method whose route already
  // has the matching @RequirePermissions() (editStaffMessage below).
  private async hasPermission(userId: string, permission: PermissionKey): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.role === 'SUPER_ADMIN') return true
    const granted = await this.prisma.userPermission.findFirst({ where: { userId, permission: { key: permission } } })
    return !!granted
  }

  private async assertPermission(userId: string, permission: PermissionKey) {
    if (!(await this.hasPermission(userId, permission))) {
      throw new ForbiddenException(`Missing required permission(s): ${permission}`)
    }
  }
}
