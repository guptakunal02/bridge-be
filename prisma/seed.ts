import 'dotenv/config';
import { AgentRole, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required env for seed: ${key}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const email = requireEnv('SEED_ADMIN_EMAIL').toLowerCase();
  const password = requireEnv('SEED_ADMIN_PASSWORD');
  const name = process.env.SEED_ADMIN_NAME ?? 'Admin';

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const existing = await prisma.agent.findUnique({ where: { email } });
    if (existing) {
      console.log(`[seed] Admin already exists (${email}); leaving password untouched.`);
      return;
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const admin = await prisma.agent.create({
      data: {
        email,
        name,
        passwordHash,
        role: AgentRole.ADMIN,
      },
    });
    console.log(`[seed] Created admin ${admin.email} (id=${admin.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
