import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator'

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

export class CreateTicketDto {
  @IsUUID()
  categoryId!: string

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string

  // The customer's requested priority — informational only, never trusted
  // as the authoritative internal priority. See SupportTicket.requestedPriority.
  @IsOptional()
  @IsIn(PRIORITIES)
  requestedPriority?: (typeof PRIORITIES)[number]
}

// Admin-initiated conversation (Customer Support: "contact any user" —
// the mirror image of CreateTicketDto: same shape, but the caller
// specifies WHO the ticket belongs to instead of it always being the
// authenticated caller themselves. categoryId is optional here since the
// customer never picks one either in the current chat-first design (see
// SupportService.createTicketAsStaff() for the same "first active
// category" default).
export class CreateStaffTicketDto {
  @IsUUID()
  userId!: string

  @IsOptional()
  @IsUUID()
  categoryId?: string

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string
}

export class CreateMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string

  // Only meaningful for staff — ignored/forced to PUBLIC for a customer
  // caller, enforced server-side in SupportService, never trusted from the
  // request alone.
  @IsOptional()
  @IsIn(['PUBLIC', 'INTERNAL'])
  visibility?: 'PUBLIC' | 'INTERNAL'
}

// Staff editing one of their OWN previously-sent messages. Same length bounds
// as CreateMessageDto.body; deliberately no `visibility` field — an edit can
// never move a message between PUBLIC and INTERNAL.
export class EditMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string
}

// Support Audit — soft-deleting one message (SUPER_ADMIN only; see
// SupportService.deleteStaffMessage). A written reason is required, same
// bound as every other reason field in this file — this one also becomes
// part of the MESSAGE_DELETED audit record.
export class DeleteMessageDto {
  @IsString()
  @MinLength(3)
  reason!: string
}

export class UpdateStatusDto {
  @IsIn(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'])
  status!: string

  @IsOptional()
  @IsString()
  @MinLength(3)
  reason?: string
}

export class UpdatePriorityDto {
  @IsIn(PRIORITIES)
  priority!: (typeof PRIORITIES)[number]

  @IsOptional()
  @IsString()
  @MinLength(3)
  reason?: string
}

export class AssignTicketDto {
  @IsUUID()
  agentId!: string

  @IsOptional()
  @IsString()
  @MinLength(3)
  reason?: string
}

// Multipart upload (Phase 4, Part 15) — the file itself is handled by
// FileInterceptor, this only validates the accompanying text field. When
// omitted, SupportService fills in a default body from the filename so the
// message the attachment lives on is never empty.
export class AttachmentBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string

  @IsOptional()
  @IsIn(['PUBLIC', 'INTERNAL'])
  visibility?: 'PUBLIC' | 'INTERNAL'
}

export class MarkNotificationsReadDto {
  @IsOptional()
  @IsUUID('4', { each: true })
  ids?: string[]
}
