-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MEMBER', 'ADMIN', 'BOT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ONLINE', 'AWAY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('INSTAGRAM', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_FOLLOWUP', 'WAITING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('SENT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "TicketActivity" AS ENUM ('CREATED', 'ASSIGNED_TO_BOT', 'ASSIGNED_TO_AGENT', 'REASSIGNED_TO_AGENT', 'PUT_INTO_FOLLOWUP', 'PUT_INTO_WAITING', 'MARKED_RESOLVED', 'REOPENED', 'NOTES_ADDED', 'SENT_BACK_TO_QUEUE');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "googleSub" TEXT,
    "email" TEXT,
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
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "inbox_contact" TEXT,
    "credentials_encrypted" TEXT,
    "credentialsVerifiedAt" TIMESTAMP(3),
    "status" "ChannelStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" BIGSERIAL NOT NULL,
    "channel_id" UUID NOT NULL,
    "channel_type" "ChannelType" NOT NULL,
    "assignee" UUID NOT NULL,
    "status" "TicketStatus" NOT NULL,
    "is_reopened" BOOLEAN NOT NULL DEFAULT false,
    "refund_related" BOOLEAN NOT NULL DEFAULT false,
    "thread_key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "subject" TEXT,
    "type" "MessageDirection" NOT NULL,
    "content" TEXT NOT NULL,
    "sender" TEXT,
    "receiver" TEXT[],
    "ticket_id" BIGINT NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketActivityLog" (
    "id" UUID NOT NULL,
    "ticket_id" BIGINT NOT NULL,
    "event" "TicketActivity" NOT NULL,
    "log" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isApproved_deactivatedAt_idx" ON "User"("role", "isApproved", "deactivatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_displayName_key" ON "Channel"("displayName");

-- CreateIndex
CREATE INDEX "Ticket_assignee_status_idx" ON "Ticket"("assignee", "status");

-- CreateIndex
CREATE INDEX "Ticket_status_updatedAt_idx" ON "Ticket"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_channel_id_thread_key_key" ON "Ticket"("channel_id", "thread_key");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_external_message_id_key" ON "EmailMessage"("external_message_id");

-- CreateIndex
CREATE INDEX "EmailMessage_channelId_createdAt_idx" ON "EmailMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_ticket_id_createdAt_idx" ON "EmailMessage"("ticket_id", "createdAt");

-- CreateIndex
CREATE INDEX "TicketActivityLog_ticket_id_createdAt_idx" ON "TicketActivityLog"("ticket_id", "createdAt");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignee_fkey" FOREIGN KEY ("assignee") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketActivityLog" ADD CONSTRAINT "TicketActivityLog_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
