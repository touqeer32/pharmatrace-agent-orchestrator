import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { JsonObject } from '../common/json';
import { hederaNetwork, hederaRpcUrl, hederaSignerPrivateKey, mirrorNodeUrl, pharmatraceManagerAddress, pharmatraceMirrorNodeUrl } from '../common/hedera-config';
import { McpServer } from '../mcp/mcp.types';
import { KeycloakAuthService } from './keycloak-auth.service';

const MANAGER_ABI = [
  'function isOperator(address operator) view returns (bool)',
  'function verifyLot(bytes32 lotKey) view returns (bool)',
  'function actionFee(bytes4 selector) view returns (uint256)',
  'function feeToken() view returns (address)',
  'function feeExempt(address account) view returns (bool)',
  'function createLot(bytes32 lotKey, bytes32 lotRoot, bytes32 fabricSeal)',
];
const TOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const CREATE_LOT_SELECTOR = '0x591a3a3e';

interface AnchorLot {
  lotId: string;
  lotKey: string;
  merkleRoot: string;
  fabricSeal: string;
  hedera?: { txHash?: string; kind?: string; status?: string } | null;
}

@Injectable()
export class LotAnchorService {
  private readonly logger = new Logger(LotAnchorService.name);

  constructor(private readonly auth: KeycloakAuthService) {}

  async anchorLots(server: McpServer, lotIds: string[]): Promise<JsonObject> {
    try {
      if (!Array.isArray(lotIds)) {
        throw new BadRequestException('lotIds must contain at least one lot UUID');
      }
      if (!lotIds.length) {
        this.logger.log('No unconfirmed lots to anchor', {
          tenantId: server.tenant_id,
          status: 'NOOP',
        });
        return {
          status: 'COMPLETED',
          operation: 'NOOP',
          reason: 'No unconfirmed lots were returned by list_batch_lots',
          totalRequested: 0,
          lotsPushed: 0,
          lotsSkipped: 0,
          lotsFailed: 0,
          results: [],
        };
      }
      const rpcUrl = hederaRpcUrl();
      const managerAddress = pharmatraceManagerAddress();
      this.assertAddress(managerAddress, 'PHARMATRACE_MANAGER_ADDRESS');
      this.logger.log('Lot anchor configuration', {
        network: hederaNetwork(),
        rpcUrl,
        managerAddress,
        lotCount: lotIds.length,
        signerConfigured: Boolean(hederaSignerPrivateKey()),
      });

      const provider = new JsonRpcProvider(rpcUrl);
      const signer = new Wallet(hederaSignerPrivateKey(), provider);
      const manager = new Contract(managerAddress, MANAGER_ABI, signer);
      const walletAddress = await signer.getAddress();
      this.logger.log('Lot anchor wallet resolved', { walletAddress, managerAddress });
      if (!(await manager.isOperator(walletAddress))) {
        throw new BadRequestException('Configured wallet is not an allowed manager operator');
      }

      const results: JsonObject[] = [];
      for (const lotId of lotIds) {
        results.push(await this.anchorOne(server, manager, walletAddress, lotId));
      }
      return {
        status: 'COMPLETED',
        network: hederaNetwork(),
        walletAddress,
        totalRequested: lotIds.length,
        lotsPushed: results.filter((item) => item.status === 'CONFIRMED').length,
        lotsSkipped: results.filter((item) => item.status === 'SKIPPED').length,
        lotsFailed: results.filter((item) => item.status === 'FAILED').length,
        results,
      };
    } catch (error) {
      this.logger.error('Lot anchor initialization failed', {
        error: error instanceof Error ? error.message : String(error),
        network: hederaNetwork(),
        rpcUrl: (() => { try { return hederaRpcUrl(); } catch { return null; } })(),
        managerAddress: (() => { try { return pharmatraceManagerAddress(); } catch { return null; } })(),
        signerConfigured: Boolean(process.env.HEDERA_SIGNER_PRIVATE_KEY || process.env.HEDERA_SIGNER_PRIVATE_KEY_MAINNET || process.env.HEDERA_SIGNER_PRIVATE_KEY_TESTNET),
      });
      throw error;
    }
  }

  private async anchorOne(
    server: McpServer,
    manager: Contract,
    walletAddress: string,
    lotId: string,
  ): Promise<JsonObject> {
    try {
      const lot = await this.getLot(server, lotId);
      if (this.isAnchored(lot)) {
        return { lotId, status: 'SKIPPED', reason: 'Already confirmed on Hedera' };
      }
      this.assertBytes32(lot.lotKey, 'lotKey');
      this.assertBytes32(lot.merkleRoot, 'merkleRoot');
      this.assertBytes32(lot.fabricSeal, 'fabricSeal');
      if (await manager.verifyLot(lot.lotKey)) {
        return { lotId, status: 'SKIPPED', reason: 'Lot already exists on-chain' };
      }

      const feeAmount = await manager.actionFee(CREATE_LOT_SELECTOR);
      const feeTokenAddress = await manager.feeToken();
      this.assertAddress(feeTokenAddress, 'feeToken');
      this.logger.log('Lot anchor fee resolved', {
        lotId,
        walletAddress,
        feeTokenAddress,
        feeAmount: feeAmount.toString(),
      });
      let approvalTransactionHash: string | null = null;
      if (!(await manager.feeExempt(walletAddress)) && feeAmount > 0n) {
        const token = new Contract(feeTokenAddress, TOKEN_ABI, manager.runner);
        if ((await token.balanceOf(walletAddress)) < feeAmount) {
          throw new Error('Insufficient payment token balance to pay manager fee');
        }
        const managerAddress = await manager.getAddress();
        if ((await token.allowance(walletAddress, managerAddress)) < feeAmount) {
          this.logger.log('Lot anchor approval started', { lotId, managerAddress, feeTokenAddress });
          const approval = await token.approve(managerAddress, feeAmount);
          approvalTransactionHash = approval.hash;
          await approval.wait();
          this.logger.log('Lot anchor approval confirmed', { lotId, approvalTransactionHash });
        }
      }

      this.logger.log('Lot create transaction started', { lotId, lotKey: lot.lotKey });
      const transaction = await manager.createLot(lot.lotKey, lot.merkleRoot, lot.fabricSeal);
      const receipt = await transaction.wait();
      if (!receipt || receipt.status !== 1) throw new Error('createLot transaction did not succeed');
      this.logger.log('Lot create transaction confirmed', {
        lotId,
        transactionHash: transaction.hash,
        blockNumber: receipt.blockNumber,
      });
      const mirror = await this.getMirrorReceipt(transaction.hash);
      this.logger.log('Lot Mirror Node lookup completed', {
        lotId,
        transactionHash: transaction.hash,
        found: Boolean(mirror),
      });
      await this.saveAnchor(server, {
        lotId, txHash: transaction.hash, kind: 'CREATE_LOT', from: walletAddress,
        createdAtISO: new Date().toISOString(), mirror, anchorId: lot.lotKey,
      });
      this.logger.log('Lot anchor persisted', { lotId, transactionHash: transaction.hash });
      return { lotId, status: 'CONFIRMED', transactionHash: transaction.hash, approvalTransactionHash, mirror };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Lot anchor failed', { lotId, error: message });
      return { lotId, status: 'FAILED', error: message };
    }
  }

  private async getLot(server: McpServer, lotId: string): Promise<AnchorLot> {
    const token = await this.auth.getAccessToken(server);
    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: this.headers(token, server.tenant_id),
      body: JSON.stringify({
        // The deployed PharmaTrace schema accepts the inline UUID form used by
        // the UI. Avoid declaring a possibly incompatible variable scalar.
        query: `query { getBatchLotById(id: "${lotId}") }`,
      }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30000)),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 1500);
      this.logger.error('PharmaTrace lot lookup rejected', {
        tenantId: server.tenant_id,
        lotId,
        status: response.status,
        response: details,
      });
      throw new BadGatewayException(
        'PharmaTrace lot lookup returned HTTP ' + response.status + (details ? ': ' + details : ''),
      );
    }
    const payload = await response.json() as {
      data?: { getBatchLotById?: unknown };
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors?.length) {
      throw new BadGatewayException(payload.errors.map((item) => item.message ?? 'GraphQL error').join('; '));
    }
    const raw = payload.data?.getBatchLotById;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) as JsonObject : raw as JsonObject;
    const lot = (parsed?.data ?? parsed) as AnchorLot;
    if (!lot?.lotId || !lot.lotKey || !lot.merkleRoot || !lot.fabricSeal) {
      throw new BadGatewayException('Lot ' + lotId + ' is missing required anchor fields');
    }
    return lot;
  }

  private async saveAnchor(server: McpServer, input: JsonObject): Promise<void> {
    const token = await this.auth.getAccessToken(server);
    const mirror = (input.mirror ?? {}) as JsonObject;
    const quote = (value: unknown) => JSON.stringify(value ?? null);
    const mutation = [
      'mutation setHederaAnchorOnLot {',
      'setHederaAnchorOnLot(',
      'lotId:' + quote(input.lotId),
      'txHash:' + quote(input.txHash),
      'kind:CREATE_LOT',
      'from:' + quote(input.from),
      'createdAtISO:' + quote(input.createdAtISO),
      'anchorId:' + quote(input.anchorId),
      'noItemPushed:0',
      'status:CONFIRMED',
      'mirror:{',
      'timestamp:' + quote(mirror.timestamp),
      'gasUsed:' + Number(mirror.gasUsed ?? 0),
      'result:' + quote(mirror.result),
      'contractId:' + quote(mirror.contractId),
      'logsCount:' + Number(mirror.logsCount ?? 0),
      '}',
      ') }',
    ].join(' ');
    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: this.headers(token, server.tenant_id),
      body: JSON.stringify({ query: mutation }),
      signal: AbortSignal.timeout(Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30000)),
    });
    if (!response.ok) throw new BadGatewayException('PharmaTrace anchor save returned HTTP ' + response.status);
    const payload = await response.json() as { errors?: Array<{ message?: string }> };
    if (payload.errors?.length) {
      throw new BadGatewayException(payload.errors.map((item) => item.message ?? 'GraphQL error').join('; '));
    }
  }

  private async getMirrorReceipt(txHash: string): Promise<JsonObject | null> {
    const base = pharmatraceMirrorNodeUrl();
    if (!base) return null;
    const response = await fetch(base + '/api/v1/contracts/results/' + encodeURIComponent(txHash));
    if (!response.ok) return null;
    const result = await response.json() as JsonObject;
    return {
      timestamp: result.timestamp ?? null,
      gasUsed: Number(result.gas_used ?? 0),
      result: result.result ?? result.status ?? null,
      contractId: result.contract_id ?? result.to ?? null,
      logsCount: Array.isArray(result.logs) ? result.logs.length : 0,
    };
  }

  private headers(token: string, tenantId: string | null): Record<string, string> {
    return {
      Authorization: 'Bearer ' + token,
      tenantid: tenantId ?? '',
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private isAnchored(lot: AnchorLot): boolean {
    return Boolean(lot.hedera?.txHash) &&
      lot.hedera?.kind === 'CREATE_LOT' &&
      lot.hedera?.status === 'CONFIRMED';
  }

  private assertBytes32(value: string, name: string): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new BadRequestException(name + ' must be a 32-byte hex value');
    }
  }

  private assertAddress(value: string, name: string): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new BadRequestException(name + ' must be a valid EVM address');
    }
  }

  private required(name: string): string {
    const value = process.env[name];
    if (!value?.trim()) throw new BadRequestException(name + ' must be configured');
    return value;
  }
}
