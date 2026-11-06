import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AuditDatabaseService } from './audit-database.service';
import { AgentAuditService } from '../execution/agent-audit.service';

@Global()
@Module({
  providers: [DatabaseService, AuditDatabaseService, AgentAuditService],
  exports: [DatabaseService, AuditDatabaseService, AgentAuditService],
})
export class DatabaseModule {}
