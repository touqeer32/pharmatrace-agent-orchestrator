import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AuditDatabaseService } from './audit-database.service';

@Global()
@Module({
  providers: [DatabaseService, AuditDatabaseService],
  exports: [DatabaseService, AuditDatabaseService],
})
export class DatabaseModule {}
