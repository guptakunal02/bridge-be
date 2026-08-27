import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
  const googleSub = requireEnv('SEED_ADMIN_GOOGLE_SUB');
  const name = process.env.SEED_ADMIN_NAME ?? 'Admin';

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`[seed] Admin already exists (${email}); leaving untouched.`);
      return;
    }

    const admin = await prisma.user.create({
      data: {
        email,
        googleSub,
        name,
        role: UserRole.ADMIN,
        isApproved: true,
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
