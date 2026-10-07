import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AccountId,
  Client,
  PrivateKey,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import { DatabaseService } from '../database/database.service';
import { hederaAgentAccountId, hederaAgentKeyType, hederaAgentPrivateKey, hederaNetwork, hederaTopicId, mirrorNodeUrl } from '../common/hedera-config';

@Injectable()
export class ComplianceHcsService {
  private readonly logger = new Logger(ComplianceHcsService.name);

  constructor(private readonly db: DatabaseService) {}

  isConfigured(): boolean {
    try {
      return Boolean(hederaTopicId() && hederaAgentAccountId() && hederaAgentPrivateKey());
    } catch {
      return false;
    }
  }

  async submitReportCreated(tenantId: string, reportId: string) {
    if (!this.isConfigured()) {
      return { submitted: false, reason: 'Agent Hedera signer is not configured' };
    }

    const attestation = await this.db.one<any>(
      `SELECT * FROM compliance_attestations
       WHERE tenant_id = $1 AND report_id = $2 AND attestation_type = 'REPORT_CREATED'
       ORDER BY prepared_at DESC LIMIT 1`,
      [tenantId, reportId],
    );
    if (!attestation) throw new Error('REPORT_CREATED attestation was not found');
    if (attestation.status === 'SUBMITTED' || attestation.status === 'CONFIRMED') {
      return { submitted: true, alreadySubmitted: true, attestation };
    }

    const network = hederaNetwork();
    const topicId = hederaTopicId();
    let client: Client | undefined;
    try {
      const accountId = hederaAgentAccountId();
      if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
        throw new Error(`Invalid AGENT_HEDERA_ACCOUNT_ID '${accountId}'. Expected format 0.0.123`);
      }
      const parsedAccountId = AccountId.fromString(accountId);
      const keyType = hederaAgentKeyType();
      const privateKey = keyType === 'ECDSA'
        ? PrivateKey.fromStringECDSA(hederaAgentPrivateKey())
        : keyType === 'ED25519'
          ? PrivateKey.fromStringED25519(hederaAgentPrivateKey())
          : PrivateKey.fromStringDer(hederaAgentPrivateKey());
      this.logger.log({
        accountId,
        keyType,
        publicKey: privateKey.publicKey.toString(),
        evmAddress: keyType === 'ECDSA' ? `0x${privateKey.publicKey.toEvmAddress()}` : null,
      });
      const agent = {
        accountId,
        keyType,
        publicKey: privateKey.publicKey.toString(),
        evmAddress: keyType === 'ECDSA' ? `0x${privateKey.publicKey.toEvmAddress()}` : null,
      };
      const payload = this.compactReportPayload(attestation.payload ?? {}, agent);
      const message = JSON.stringify(payload);
      const messageBytes = Buffer.byteLength(message, 'utf8');
      if (messageBytes > 1024) {
        throw new Error(`HCS report payload is ${messageBytes} bytes; maximum is 1024 bytes`);
      }
      const payloadDigest = createHash('sha256').update(message).digest('hex');
      await this.db.query(
        `UPDATE compliance_attestations
         SET payload = $1, payload_digest = $2
         WHERE id = $3 AND tenant_id = $4`,
        [payload, payloadDigest, attestation.id, tenantId],
      );
      client = Client.forName(network);
      client.setOperator(parsedAccountId, privateKey);
      const transaction = await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .execute(client);
      const receipt = await transaction.getReceipt(client);
      const transactionId = transaction.transactionId?.toString() ?? null;
      const sequenceNumber = receipt.topicSequenceNumber?.toString() ?? null;

      const updated = await this.db.one<any>(
        `UPDATE compliance_attestations
         SET status = 'SUBMITTED', topic_id = $1, transaction_id = $2,
             sequence_number = $3, submitted_at = NOW(), last_error = NULL
         WHERE id = $4 AND tenant_id = $5
         RETURNING *`,
        [topicId, transactionId, sequenceNumber, attestation.id, tenantId],
      );
      updated.payload = payload;
      updated.payload_digest = payloadDigest;
      const mirror = transactionId ? await this.lookupMirrorTransaction(transactionId) : null;
      if (mirror?.result === 'SUCCESS' && mirror.consensus_timestamp) {
        const confirmed = await this.db.one<any>(
          `UPDATE compliance_attestations
           SET status = 'CONFIRMED', consensus_timestamp = $1, confirmed_at = NOW()
           WHERE id = $2 AND tenant_id = $3 RETURNING *`,
          [mirror.consensus_timestamp, attestation.id, tenantId],
        );
        this.logger.log({ reportId, tenantId, topicId, transactionId, sequenceNumber, consensusTimestamp: mirror.consensus_timestamp, network });
        return { submitted: true, confirmed: true, attestation: confirmed };
      }

      this.logger.log({ reportId, tenantId, topicId, transactionId, sequenceNumber, network, mirrorIndexed: false });
      return { submitted: true, confirmed: false, attestation: updated };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `UPDATE compliance_attestations SET status = 'FAILED', last_error = $1
         WHERE id = $2 AND tenant_id = $3`,
        [messageText, attestation.id, tenantId],
      );
      this.logger.error({ reportId, tenantId, topicId, network, error: messageText });
      throw error;
    } finally {
      client?.close();
    }
  }

  async submitPreparedAttestation(tenantId: string, attestationId: string) {
    if (!this.isConfigured()) {
      return { submitted: false, reason: 'Agent Hedera signer is not configured' };
    }
    const attestation = await this.db.one<any>(
      `SELECT * FROM compliance_attestations WHERE id = $1 AND tenant_id = $2`,
      [attestationId, tenantId],
    );
    if (!attestation) throw new Error('Prepared attestation was not found');
    if (['SUBMITTED', 'CONFIRMED'].includes(attestation.status)) {
      return { submitted: true, alreadySubmitted: true, attestation };
    }

    const network = hederaNetwork();
    const topicId = hederaTopicId();
    let client: Client | undefined;
    try {
      const accountId = hederaAgentAccountId();
      const parsedAccountId = AccountId.fromString(accountId);
      const keyType = hederaAgentKeyType();
      const privateKey = keyType === 'ECDSA'
        ? PrivateKey.fromStringECDSA(hederaAgentPrivateKey())
        : keyType === 'ED25519'
          ? PrivateKey.fromStringED25519(hederaAgentPrivateKey())
          : PrivateKey.fromStringDer(hederaAgentPrivateKey());
      const payload = this.compactReportPayload(attestation.payload ?? {}, {
        accountId,
        keyType,
        publicKey: privateKey.publicKey.toString(),
        evmAddress: keyType === 'ECDSA' ? `0x${privateKey.publicKey.toEvmAddress()}` : null,
      });
      const message = JSON.stringify(payload);
      if (Buffer.byteLength(message, 'utf8') > 1024) {
        throw new Error('HCS attestation payload exceeds 1024 bytes');
      }
      const payloadDigest = createHash('sha256').update(message).digest('hex');
      await this.db.query(
        `UPDATE compliance_attestations SET payload = $1, payload_digest = $2 WHERE id = $3 AND tenant_id = $4`,
        [payload, payloadDigest, attestationId, tenantId],
      );
      client = Client.forName(network);
      client.setOperator(parsedAccountId, privateKey);
      const transaction = await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .execute(client);
      const receipt = await transaction.getReceipt(client);
      const transactionId = transaction.transactionId?.toString() ?? null;
      const sequenceNumber = receipt.topicSequenceNumber?.toString() ?? null;
      const updated = await this.db.one<any>(
        `UPDATE compliance_attestations
         SET status = 'SUBMITTED', topic_id = $1, transaction_id = $2,
             sequence_number = $3, submitted_at = NOW(), last_error = NULL
         WHERE id = $4 AND tenant_id = $5 RETURNING *`,
        [topicId, transactionId, sequenceNumber, attestationId, tenantId],
      );
      const mirror = transactionId ? await this.lookupMirrorTransaction(transactionId) : null;
      if (mirror?.result === 'SUCCESS' && mirror.consensus_timestamp) {
        const confirmed = await this.db.one<any>(
          `UPDATE compliance_attestations
           SET status = 'CONFIRMED', consensus_timestamp = $1, confirmed_at = NOW()
           WHERE id = $2 AND tenant_id = $3 RETURNING *`,
          [mirror.consensus_timestamp, attestationId, tenantId],
        );
        return { submitted: true, confirmed: true, attestation: confirmed };
      }
      return { submitted: true, confirmed: false, attestation: updated };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `UPDATE compliance_attestations SET status = 'FAILED', last_error = $1 WHERE id = $2 AND tenant_id = $3`,
        [messageText, attestationId, tenantId],
      );
      throw error;
    } finally {
      client?.close();
    }
  }

  private async lookupMirrorTransaction(transactionId: string): Promise<{ result?: string; consensus_timestamp?: string } | null> {
    const mirrorUrl = mirrorNodeUrl();
    if (!mirrorUrl) return null;
    const mirrorId = transactionId.replace('@', '-');
    try {
      const response = await fetch(`${mirrorUrl.replace(/\/$/, '')}/api/v1/transactions/${encodeURIComponent(mirrorId)}`);
      if (!response.ok) return null;
      const body = await response.json() as { transactions?: Array<{ result?: string; consensus_timestamp?: string }> };
      return body.transactions?.[0] ?? null;
    } catch (error) {
      this.logger.warn(`Mirror Node lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private compactReportPayload(payload: Record<string, any>, agent: Record<string, unknown>) {
    // The complete report remains in PostgreSQL. HCS stores a compact,
    // independently verifiable proof so the message stays below 1,024 bytes.
    const compact = {
      payloadType: 'COMPLIANCE_REPORT_CREATED',
      payloadVersion: 2,
      reportId: payload.reportId,
      reportVersion: payload.reportVersion,
      reportType: payload.reportType,
      recordType: payload.recordType,
      recordId: payload.recordId,
      resultStatus: payload.resultStatus,
      severity: payload.severity,
      issueFingerprint: payload.issueFingerprint,
      reportDigest: payload.reportDigest,
      evidenceDigest: payload.evidenceDigest,
      recordFingerprint: payload.recordFingerprint,
      creator: payload.creator,
      agent,
    };

    // Do not serialize null/empty optional fields. They waste HCS capacity and
    // were the reason older report-created payloads crossed the 1,024-byte
    // limit even though the actual proof data was small.
    const withoutEmptyValues = JSON.parse(JSON.stringify(compact, (_key, value) => {
      if (value === null || value === undefined || value === '') return undefined;
      return value;
    }));

    // Keep a deterministic safety margin for future metadata additions. The
    // fallback still contains the fields required to verify the report,
    // record, fingerprints, creator, and signing agent.
    if (Buffer.byteLength(JSON.stringify(withoutEmptyValues), 'utf8') <= 960) {
      return withoutEmptyValues;
    }

    const safePayload = {
      payloadType: 'COMPLIANCE_REPORT_CREATED',
      payloadVersion: 2,
      reportId: payload.reportId,
      reportVersion: payload.reportVersion,
      recordType: payload.recordType,
      recordId: payload.recordId,
      resultStatus: payload.resultStatus,
      issueFingerprint: payload.issueFingerprint,
      reportDigest: payload.reportDigest,
      evidenceDigest: payload.evidenceDigest,
      recordFingerprint: payload.recordFingerprint,
      creator: payload.creator ? {
        id: payload.creator.id,
        name: payload.creator.name,
        publicKey: payload.creator.publicKey,
      } : undefined,
      agent: {
        accountId: agent.accountId,
        keyType: agent.keyType,
        publicKey: agent.publicKey,
      },
    };
    const result = JSON.parse(JSON.stringify(safePayload, (_key, value) => {
      if (value === null || value === undefined || value === '') return undefined;
      return value;
    }));
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > 1024) {
      throw new Error(`HCS compact report payload is ${bytes} bytes; maximum is 1024 bytes`);
    }
    return result;
  }
}
