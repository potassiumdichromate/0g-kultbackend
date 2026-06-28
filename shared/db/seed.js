// Seeds the Game registry with the two existing backends. Run with `npm run seed --workspace=shared/db`.
const { PrismaClient } = require("./generated/client");

const prisma = new PrismaClient();

const GAMES = [
  {
    key: "zerodash",
    name: "ZeroDash",
    integrationMode: "POLLING_ADAPTER",
    backendBaseUrl: process.env.ZERODASH_BACKEND_URL || "https://zerog-zerodash.onrender.com",
  },
  {
    key: "warzone",
    name: "Warzone Warriors",
    integrationMode: "POLLING_ADAPTER",
    backendBaseUrl: process.env.WARZONE_BACKEND_URL || "https://warzone-backend-0g.onrender.com",
  },
];

async function main() {
  for (const game of GAMES) {
    await prisma.game.upsert({
      where: { key: game.key },
      update: { name: game.name, backendBaseUrl: game.backendBaseUrl },
      create: game,
    });
    console.log(`seeded game: ${game.key}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
