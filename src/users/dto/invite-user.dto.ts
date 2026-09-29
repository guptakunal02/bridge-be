import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { UserRole } from '../../database/enums';

/**
 * Admin-issued invite. Creates a pre-approved User row shell that
 * gets filled in on the invitee's first Google sign-in. Role is
 * restricted to MEMBER / ADMIN — BOT users are seeded, not invited.
 */
export class InviteUserDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsIn([UserRole.MEMBER, UserRole.ADMIN])
  role!: UserRole.MEMBER | UserRole.ADMIN;
}
