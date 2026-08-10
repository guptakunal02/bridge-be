-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';
