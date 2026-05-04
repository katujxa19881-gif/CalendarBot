"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDatabase = connectDatabase;
exports.runHealthcheckProbe = runHealthcheckProbe;
exports.disconnectDatabase = disconnectDatabase;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
exports.prisma = prisma;
async function connectDatabase() {
    await prisma.$connect();
}
async function runHealthcheckProbe() {
    await prisma.$queryRawUnsafe("SELECT 1");
}
async function disconnectDatabase() {
    await prisma.$disconnect();
}
