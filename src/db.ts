import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function runHealthcheckProbe(): Promise<void> {
  await prisma.$queryRawUnsafe("SELECT 1");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
