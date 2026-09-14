import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // allow the Vite dev server on a different port to call this API
  await app.listen(3000);
}
bootstrap();