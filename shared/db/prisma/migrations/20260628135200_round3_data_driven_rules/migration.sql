/*
  Warnings:

  - You are about to drop the `iap_purchases` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "iap_purchases" DROP CONSTRAINT "iap_purchases_gameId_fkey";

-- DropForeignKey
ALTER TABLE "iap_purchases" DROP CONSTRAINT "iap_purchases_userId_fkey";

-- AlterTable
ALTER TABLE "rewards" ADD COLUMN     "criteria" JSONB;

-- DropTable
DROP TABLE "iap_purchases";
