import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaLibSql } from "@prisma/adapter-libsql";

// Prisma 7's Rust-free client no longer bundles a built-in SQLite engine,
// so an explicit driver adapter is required even for local SQLite files.
// This wraps PrismaClient as a NestJS provider so it can be injected
// anywhere, connecting/disconnecting in step with the app's lifecycle.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
	const adapter = new PrismaLibSql({ url: "file:./dev.db" });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
