import { BadGatewayException, Injectable } from '@nestjs/common';
import { JsonObject } from '../common/json';

@Injectable()
export class PharmaTraceNormalizerService {
  normalize(toolName: string, value: unknown): unknown {
    if (toolName === 'get_batch_lot') {
      return this.normalizeBatchLot(value);
    }

    if (toolName === 'get_lot_items') {
      return this.normalizeLotItems(value);
    }

    if (toolName === 'get_product') {
      return this.normalizeProduct(value);
    }

    return value;
  }

  normalizeBatchLot(raw: unknown): unknown {
    if (!raw) {
      throw new BadGatewayException('Batch lot response is empty');
    }

    const parsed =
      typeof raw === 'string' ? (JSON.parse(raw) as JsonObject) : (raw as JsonObject);

    if ('status' in parsed && Number(parsed.status) !== 200) {
      throw new BadGatewayException(
        typeof parsed.message === 'string' ? parsed.message : 'Batch lot request failed',
      );
    }

    return 'data' in parsed ? parsed.data : parsed;
  }

  normalizeLotItems(raw: unknown): { items: JsonObject[]; totalCount: number } {
    const rows = Array.isArray(raw) ? (raw as JsonObject[]) : [];
    const items = rows.filter((row) => Boolean(row.itemId));
    const countRow = rows.find((row) => !row.itemId && row.count !== undefined);

    return {
      items,
      totalCount: Number(countRow?.count ?? items.length),
    };
  }

  normalizeProduct(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }

    const product = { ...(raw as JsonObject) };

    if (product.drugId === 'null' || product.drugId === '') {
      product.drugId = null;
    }

    return product;
  }
}
