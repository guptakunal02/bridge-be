import { UserRole } from '../../database/enums';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';

export interface TeamMemberSummary {
  userId: string;
  name: string;
  email: string | null;
  role: UserRole;
  pausedInTeam: boolean;
}

export interface TeamResponse {
  id: string;
  name: string;
  isDefault: boolean;
  assignmentPaused: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDetail extends TeamResponse {
  members: TeamMemberSummary[];
}

export function toTeamResponse(team: Team, memberCount: number): TeamResponse {
  return {
    id: team.id,
    name: team.name,
    isDefault: team.is_default,
    assignmentPaused: team.assignment_paused,
    memberCount,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

export function toTeamDetail(team: Team, members: TeamMember[]): TeamDetail {
  return {
    ...toTeamResponse(team, members.length),
    members: members.map((m) => ({
      userId: m.user_id,
      name: m.user?.name ?? '(unknown)',
      email: m.user?.email ?? null,
      role: m.user?.role ?? UserRole.MEMBER,
      pausedInTeam: m.paused_in_team,
    })),
  };
}
