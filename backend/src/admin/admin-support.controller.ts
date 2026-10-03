import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { SupportService } from '../support/support.service'
import { CreateMessageDto, CreateStaffTicketDto, EditMessageDto, DeleteMessageDto, UpdateStatusDto, UpdatePriorityDto, AssignTicketDto, AttachmentBodyDto } from '../support/dto/ticket.dto'
import { CreateCategoryDto, UpdateCategoryDto } from '../support/dto/category.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { PermissionsGuard } from '../common/guards/permissions.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { RequirePermissions } from '../common/decorators/require-permissions.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../common/types/authenticated-user'

interface UploadedFileLike {
  originalname: string
  mimetype: string
  buffer: Buffer
}

// Same guard stack as every other /admin/* controller. Every route here is a
// SEPARATE permission domain from financial admin (Part 17) — granting
// every support.* permission below still grants zero financial capability;
// see SupportService's own header comment for why that's structurally true,
// not just a convention.
@Controller('admin/support')
@UseGuards(SessionAuthGuard, RolesGuard, PermissionsGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('tickets')
  @RequirePermissions('support.tickets.read')
  listTickets(@Query('status') status?: string) {
    return this.support.listAllTickets(status)
  }

  // "Contact any user" — starts a brand-new conversation with a user who
  // has no ticket yet (or a closed one). Gated by support.tickets.reply,
  // same permission as replying to an existing ticket — this is the same
  // capability (an admin talking to a customer), just with no existing
  // ticket to reply into yet.
  @Post('tickets')
  @RequirePermissions('support.tickets.reply')
  createTicket(@Body() dto: CreateStaffTicketDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.createTicketAsStaff(admin.id, dto)
  }

  // Backs the user picker for the above — deliberately Support-scoped
  // (support.tickets.reply, not the broader users.read) so Support staff
  // don't need an unrelated admin permission just to start a conversation.
  @Get('users')
  @RequirePermissions('support.tickets.reply')
  searchUsers(@Query('q') q?: string) {
    return this.support.searchUsersForSupport(q)
  }

  @Get('tickets/:id')
  @RequirePermissions('support.tickets.read')
  getTicket(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.getTicketForStaff(id, admin.id)
  }

  // Deliberately NO @RequirePermissions() here — the actual required
  // permission is support.tickets.reply for a PUBLIC message OR
  // support.tickets.internal_note for an INTERNAL one, and it depends on
  // dto.visibility, which the route-level decorator can't see. A fixed
  // decorator here would necessarily be wrong for one of the two cases (as
  // caught by test/support.e2e-spec.ts's "18 & 19" test — an agent with
  // ONLY .internal_note was wrongly 403'd by a blanket .reply requirement).
  // SupportService.addStaffMessage() is the real, authoritative check —
  // this route still sits behind @Roles('ADMIN','SUPER_ADMIN') above.
  @Post('tickets/:id/messages')
  addMessage(@Param('id') id: string, @Body() dto: CreateMessageDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.addStaffMessage(admin.id, id, dto)
  }

  // Editing a message you previously sent — SUPER_ADMIN always; a plain
  // ADMIN only once explicitly granted support.messages.edit. No handler-
  // level @Roles() override here (unlike deleteMessage below), so the
  // class-level @Roles('ADMIN', 'SUPER_ADMIN') applies and PermissionsGuard
  // does the real work: it rejects a plain ADMIN without the grant, and
  // SUPER_ADMIN bypasses it entirely (same mechanism as every other
  // @RequirePermissions route). The author-only rule (you may only edit
  // your own message) is enforced in SupportService.editStaffMessage(),
  // which independently re-checks the permission too via assertPermission()
  // (defense in depth — see that method's own comment). There is
  // deliberately no customer-facing counterpart on SupportController.
  @Patch('tickets/:ticketId/messages/:messageId')
  @RequirePermissions('support.messages.edit')
  editMessage(@Param('ticketId') ticketId: string, @Param('messageId') messageId: string, @Body() dto: EditMessageDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.editStaffMessage(admin.id, ticketId, messageId, dto)
  }

  // Deleting (soft) a message — SUPER_ADMIN ONLY. Unlike editMessage()
  // immediately above (now a grantable permission), deletion keeps the
  // @Roles('SUPER_ADMIN') override: it is a role, not a grantable
  // permission — holding support.messages.edit or support.audit (which
  // only gates VIEWING the moderation feed) does not grant this. @Roles
  // here overrides the class-level @Roles('ADMIN', 'SUPER_ADMIN') entirely
  // (Nest's getAllAndOverride takes the handler's own metadata, not a union
  // with the class's), so a plain ADMIN is rejected by RolesGuard before
  // this handler ever runs, direct API call included. There is deliberately no
  // customer-facing counterpart, and no "restore" endpoint (this is scoped
  // exactly to the requested capability — a real undo would need its own
  // separate, explicit design).
  @Delete('tickets/:ticketId/messages/:messageId')
  @Roles('SUPER_ADMIN')
  deleteMessage(@Param('ticketId') ticketId: string, @Param('messageId') messageId: string, @Body() dto: DeleteMessageDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.deleteStaffMessage(admin.id, ticketId, messageId, dto)
  }

  // Support Audit — a cross-ticket moderation feed (every ticket's full
  // message history, PUBLIC and INTERNAL, plus the message-edit trail).
  // Gated by the support.audit permission: SUPER_ADMIN always has it
  // (PermissionsGuard's role bypass); a plain ADMIN only has it once a
  // SUPER_ADMIN explicitly grants it via the existing
  // PATCH /admin/admins/:id/permissions/support.audit/grant endpoint — no
  // new grant mechanism, reuses the one every other permission uses.
  @Get('audit')
  @RequirePermissions('support.audit')
  getAuditFeed(@Query('limit') limit?: string) {
    return this.support.listSupportAuditFeed(limit ? Number(limit) : undefined)
  }

  // Same deliberate absence of a route-level @RequirePermissions() as
  // addMessage above, and for the same reason — the real check
  // (support.tickets.reply vs support.tickets.internal_note) depends on
  // dto.visibility and happens inside SupportService.addAttachmentAsStaff().
  @Post('tickets/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  addAttachment(@Param('id') id: string, @UploadedFile() file: UploadedFileLike, @Body() dto: AttachmentBodyDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.addAttachmentAsStaff(admin.id, id, file, dto.visibility === 'INTERNAL' ? 'INTERNAL' : 'PUBLIC', dto.body)
  }

  // Baseline permission here too; RESOLVED/CLOSED targets additionally
  // require support.tickets.resolve / support.tickets.close respectively,
  // checked inside the service since it depends on the target status.
  @Patch('tickets/:id/status')
  @RequirePermissions('support.tickets.update')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.updateStatus(admin.id, id, dto.status, dto.reason)
  }

  @Patch('tickets/:id/priority')
  @RequirePermissions('support.tickets.update')
  updatePriority(@Param('id') id: string, @Body() dto: UpdatePriorityDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.updatePriority(admin.id, id, dto.priority, dto.reason)
  }

  @Post('tickets/:id/assign')
  @RequirePermissions('support.tickets.assign')
  assign(@Param('id') id: string, @Body() dto: AssignTicketDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.assignTicket(admin.id, id, dto.agentId, dto.reason)
  }

  @Get('tickets/:id/assignments')
  @RequirePermissions('support.tickets.assign')
  listAssignments(@Param('id') id: string) {
    return this.support.listAssignmentHistory(id)
  }

  @Get('agents')
  @RequirePermissions('support.tickets.assign')
  listAgents() {
    return this.support.listAssignableAgents()
  }

  @Get('categories')
  @RequirePermissions('support.categories.manage')
  listCategories() {
    return this.support.listAllCategories()
  }

  @Post('categories')
  @RequirePermissions('support.categories.manage')
  createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.createCategory(dto, admin.id)
  }

  @Patch('categories/:id')
  @RequirePermissions('support.categories.manage')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.support.updateCategory(id, dto, admin.id)
  }
}
