-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "channelIds" UUID[] DEFAULT ARRAY[]::UUID[];
