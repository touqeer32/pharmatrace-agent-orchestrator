import { PharmaTraceNormalizerService } from './pharmatrace-normalizer.service';

describe('PharmaTraceNormalizerService', () => {
  const service = new PharmaTraceNormalizerService();

  it('unwraps the JSON-string batch lot response', () => {
    expect(service.normalize('get_batch_lot', '{"status":200,"data":{"lotId":"lot-1"}}')).toEqual({
      lotId: 'lot-1',
    });
  });

  it('removes the count-only pseudo item', () => {
    expect(
      service.normalize('get_lot_items', [
        { itemId: 'item-1', status: 'RECALLED' },
        { count: 4 },
      ]),
    ).toEqual({
      items: [{ itemId: 'item-1', status: 'RECALLED' }],
      totalCount: 4,
    });
  });

  it('normalizes the literal null drug identifier', () => {
    expect(service.normalize('get_product', { productId: 'product-1', drugId: 'null' })).toEqual({
      productId: 'product-1',
      drugId: null,
    });
  });
});
