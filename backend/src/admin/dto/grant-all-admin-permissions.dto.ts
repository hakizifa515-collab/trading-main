import { IsEmail, IsString, MinLength } from 'class-validator'

// Target is identified by email (same lookup style as CreateAdminDto /
// create-superadmin.ts), not by URL id — this is a SUPER_ADMIN-only bulk
// action invoked from a small standalone form, not from a row in a list
// (Administrator Accounts now only ever shows the caller's own account).
export class GrantAllAdminPermissionsDto {
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(3)
  reason!: string

  @IsString()
  confirmPassword!: string
}
