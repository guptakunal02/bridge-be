-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('INSTAGRAM', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalId" TEXT,
    "credentialsEncrypted" TEXT,
    "status" "ChannelStatus" NOT NULL DEFAULT 'CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChannel" (
    "agentId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "assignedByAgentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChannel_pkey" PRIMARY KEY ("agentId","channelId")
);

-- CreateIndex
CREATE INDEX "Channel_type_status_idx" ON "Channel"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_type_externalId_key" ON "Channel"("type", "externalId");

-- CreateIndex
CREATE INDEX "Contact_channelId_updatedAt_idx" ON "Contact"("channelId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_channelId_externalId_key" ON "Contact"("channelId", "externalId");

-- CreateIndex
CREATE INDEX "AgentChannel_channelId_idx" ON "AgentChannel"("channelId");

-- CreateIndex
CREATE INDEX "AgentChannel_agentId_idx" ON "AgentChannel"("agentId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannel" ADD CONSTRAINT "AgentChannel_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannel" ADD CONSTRAINT "AgentChannel_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannel" ADD CONSTRAINT "AgentChannel_assignedByAgentId_fkey" FOREIGN KEY ("assignedByAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
