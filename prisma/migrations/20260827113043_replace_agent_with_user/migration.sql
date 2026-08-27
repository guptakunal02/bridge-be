/*
  Warnings:

  - You are about to drop the column `assignedAgentId` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `authorAgentId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `agentId` on the `RefreshToken` table. All the data in the column will be lost.
  - You are about to drop the `Agent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AgentChannel` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Invitation` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `userId` to the `RefreshToken` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ONLINE', 'AWAY', 'OFFLINE');

-- DropForeignKey
ALTER TABLE "AgentChannel" DROP CONSTRAINT "AgentChannel_agentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentChannel" DROP CONSTRAINT "AgentChannel_assignedByAgentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentChannel" DROP CONSTRAINT "AgentChannel_channelId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_assignedAgentId_fkey";

-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_invitedById_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_authorAgentId_fkey";

-- DropForeignKey
ALTER TABLE "RefreshToken" DROP CONSTRAINT "RefreshToken_agentId_fkey";

-- DropIndex
DROP INDEX "Conversation_assignedAgentId_status_lastMessageAt_idx";

-- DropIndex
DROP INDEX "RefreshToken_agentId_revokedAt_idx";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "assignedAgentId",
ADD COLUMN     "assignedUserId" UUID;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "authorAgentId",
ADD COLUMN     "authorUserId" UUID;

-- AlterTable
ALTER TABLE "RefreshToken" DROP COLUMN "agentId",
ADD COLUMN     "userId" UUID NOT NULL;

-- DropTable
DROP TABLE "Agent";

-- DropTable
DROP TABLE "AgentChannel";

-- DropTable
DROP TABLE "Invitation";

-- DropEnum
DROP TYPE "AgentRole";

-- DropEnum
DROP TYPE "AgentStatus";

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "photoUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'OFFLINE',
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserChannel" (
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "assignedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserChannel_pkey" PRIMARY KEY ("userId","channelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isApproved_deactivatedAt_idx" ON "User"("role", "isApproved", "deactivatedAt");

-- CreateIndex
CREATE INDEX "UserChannel_channelId_idx" ON "UserChannel"("channelId");

-- CreateIndex
CREATE INDEX "UserChannel_userId_idx" ON "UserChannel"("userId");

-- CreateIndex
CREATE INDEX "Conversation_assignedUserId_status_lastMessageAt_idx" ON "Conversation"("assignedUserId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_idx" ON "RefreshToken"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChannel" ADD CONSTRAINT "UserChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChannel" ADD CONSTRAINT "UserChannel_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChannel" ADD CONSTRAINT "UserChannel_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
