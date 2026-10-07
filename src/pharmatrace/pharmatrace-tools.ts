import { McpToolDefinition } from '../mcp/mcp.types';

const uuidProperty = (description: string) => ({
  type: 'string',
  format: 'uuid',
  description,
});

export const PHARMATRACE_TOOLS: McpToolDefinition[] = [
  {
    name: 'push_lots_to_hedera',
    description: 'Anchor the supplied unconfirmed lot IDs on Hedera Testnet and persist each confirmed transaction back to PharmaTrace. This is the only write tool and performs validation, fee payment, contract submission, Mirror Node lookup, and backend persistence as one operation.',
    operationName: 'anchorUnconfirmedLots',
    entityType: 'batch_lot',
    inputSchema: {
      type: 'object',
      properties: {
        lotIds: { type: 'array', items: uuidProperty('Batch lot UUID.') },
      },
      required: ['lotIds'],
      additionalProperties: false,
    },
    keywords: ['hedera', 'anchor', 'create lot', 'write', 'submit'],
    capabilities: ['hedera_write', 'lot_anchor'],
    relatedToolNames: ['list_batch_lots'],
  },
  {
    name: 'list_batch_lots',
    description: 'List pharmaceutical batch lots with pagination and optional status filtering.',
    operationName: 'getAllBatchLot',
    entityType: 'batch_lot',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: 'One-based page number.' },
        size: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size.' },
        search: { type: 'string', description: 'Optional lot search text.' },
        sortBy: { type: 'string', description: 'Optional sort field.' },
      },
      required: ['page', 'size'],
      additionalProperties: false,
    },
    keywords: ['lots', 'batch', 'recall', 'pagination'],
    capabilities: ['lot_listing', 'lot_status', 'recall_discovery'],
    relatedToolNames: ['get_batch_lot', 'get_lot_items'],
  },
  {
    name: 'get_batch_lot',
    description: 'Get a batch lot including recall, Fabric, Merkle-root, and Hedera anchor data.',
    operationName: 'getBatchLotById',
    entityType: 'batch_lot',
    inputSchema: {
      type: 'object',
      properties: { lotId: uuidProperty('Batch lot UUID.') },
      required: ['lotId'],
      additionalProperties: false,
    },
    keywords: ['lot', 'batch', 'recall', 'fabric', 'hedera', 'merkle'],
    capabilities: ['lot_status', 'recall_status', 'hedera_anchor', 'fabric_transaction'],
    relatedToolNames: ['get_lot_items', 'get_product', 'get_company'],
  },
  {
    name: 'get_lot_items',
    description: 'Get items, deliveries, containers, and statuses for one batch lot.',
    operationName: 'getItemsByLotId',
    entityType: 'lot_item',
    inputSchema: {
      type: 'object',
      properties: { lotId: uuidProperty('Batch lot UUID.') },
      required: ['lotId'],
      additionalProperties: false,
    },
    keywords: ['items', 'deliveries', 'containers', 'recall'],
    capabilities: ['lot_items', 'delivery_traceability', 'item_status'],
    relatedToolNames: ['get_batch_lot'],
  },
  {
    name: 'get_product',
    description: 'Get a pharmaceutical product and its associated drug identifier.',
    operationName: 'getProductById',
    entityType: 'product',
    inputSchema: {
      type: 'object',
      properties: { productId: uuidProperty('Product UUID.') },
      required: ['productId'],
      additionalProperties: false,
    },
    keywords: ['product', 'medicine', 'drug'],
    capabilities: ['product_details', 'drug_reference'],
    relatedToolNames: ['get_drug'],
  },
  {
    name: 'get_drug',
    description: 'Get drug information and regulatory identifiers.',
    operationName: 'getDrugById',
    entityType: 'drug',
    inputSchema: {
      type: 'object',
      properties: { drugId: uuidProperty('Drug UUID.') },
      required: ['drugId'],
      additionalProperties: false,
    },
    keywords: ['drug', 'medicine', 'identifiers'],
    capabilities: ['drug_details', 'drug_identifiers'],
    relatedToolNames: ['get_product'],
  },
  {
    name: 'get_company',
    description: 'Get a manufacturing company or manufacturing-site record.',
    operationName: 'getById',
    entityType: 'company',
    inputSchema: {
      type: 'object',
      properties: { companyId: uuidProperty('Company or manufacturing-site UUID.') },
      required: ['companyId'],
      additionalProperties: false,
    },
    keywords: ['company', 'manufacturer', 'manufacturing site'],
    capabilities: ['company_details', 'manufacturing_site'],
    relatedToolNames: ['get_batch_lot'],
  },
];

export const PROFILE_COMPLIANCE_TOOLS: McpToolDefinition[] = [
  {
    name: 'run_recall_pattern_compliance',
    description: 'Authenticate with Keycloak, fetch real product recall requests, group repeated recall patterns by product and drug, create one deduplicated compliance report per pattern, and submit agent-created reports to HCS.',
    operationName: 'runRecallPatternCompliance', entityType: 'recall_pattern',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, minEvents: { type: 'integer', minimum: 2, maximum: 100 }, windowDays: { type: 'integer', minimum: 1, maximum: 3650 }, resetReports: { type: 'boolean', description: 'Test-only: remove existing pattern reports before processing.' } }, additionalProperties: false },
    keywords: ['recall', 'pattern', 'product', 'drug', 'compliance', 'report'], capabilities: ['recall_read', 'pattern_analysis', 'compliance_report', 'hedera_write'], relatedToolNames: [],
  },
  {
    name: 'run_shortage_pattern_compliance',
    description: 'Authenticate with Keycloak, fetch real product shortages, group repeated shortage patterns by product and drug, create one deduplicated compliance report per pattern, and submit agent-created reports to HCS.',
    operationName: 'runShortagePatternCompliance', entityType: 'shortage_pattern',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, minEvents: { type: 'integer', minimum: 2, maximum: 100 }, windowDays: { type: 'integer', minimum: 1, maximum: 3650 }, resetReports: { type: 'boolean', description: 'Test-only: remove existing pattern reports before processing.' } }, additionalProperties: false },
    keywords: ['shortage', 'pattern', 'product', 'drug', 'compliance', 'report'], capabilities: ['shortage_read', 'pattern_analysis', 'compliance_report', 'hedera_write'], relatedToolNames: [],
  },
  {
    name: 'run_serial_profile_compliance',
    description: 'Authenticate with Keycloak, fetch real serial-number profiles, validate them, generate optional test numbers, create compliance reports, and submit each agent-created report to HCS.',
    operationName: 'runSerialProfileCompliance', entityType: 'serial_profile',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, generateDemoNumbers: { type: 'boolean' }, demoNumberCount: { type: 'integer', minimum: 1, maximum: 10 }, resetReports: { type: 'boolean', description: 'Test-only: remove existing reports for fetched profiles before processing.' } }, additionalProperties: false },
    keywords: ['serial', 'profile', 'GS1', 'compliance', 'report'], capabilities: ['profile_read', 'compliance_report', 'hedera_write'], relatedToolNames: [],
  },
  {
    name: 'run_sscc_profile_compliance',
    description: 'Authenticate with Keycloak, fetch real SSCC profiles, validate them, generate optional test numbers, create compliance reports, and submit each agent-created report to HCS.',
    operationName: 'runSsccProfileCompliance', entityType: 'sscc_profile',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, generateDemoNumbers: { type: 'boolean' }, demoNumberCount: { type: 'integer', minimum: 1, maximum: 10 }, resetReports: { type: 'boolean', description: 'Test-only: remove existing reports for fetched profiles before processing.' } }, additionalProperties: false },
    keywords: ['SSCC', 'profile', 'GS1', 'compliance', 'report'], capabilities: ['profile_read', 'compliance_report', 'hedera_write'], relatedToolNames: [],
  },
  {
    name: 'run_gdti_profile_compliance',
    description: 'Authenticate with Keycloak, fetch real GDTI profiles, validate them, generate optional test numbers, create compliance reports, and submit each agent-created report to HCS.',
    operationName: 'runGdtiProfileCompliance', entityType: 'gdti_profile',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, generateDemoNumbers: { type: 'boolean' }, demoNumberCount: { type: 'integer', minimum: 1, maximum: 10 }, resetReports: { type: 'boolean', description: 'Test-only: remove existing reports for fetched profiles before processing.' } }, additionalProperties: false },
    keywords: ['GDTI', 'profile', 'GS1', 'compliance', 'report'], capabilities: ['profile_read', 'compliance_report', 'hedera_write'], relatedToolNames: [],
  },
];

// Actual upstream GraphQL schemas differ between PharmaTrace deployments.
// Override any document through mcp_servers.metadata.graphqlDocuments[toolName].
export const DEFAULT_GRAPHQL_DOCUMENTS: Record<string, string> = {
  list_batch_lots: `
    query getAllBatchLot($pageInput: PageInput) {
      getAllBatchLot(page: $pageInput) {
        data {
          lotId
          lotKey
          lotNumber
          drugId
          manufacturingDate
          expirationDate
          processedTime
          status
          productId
          manufacturingSite
          lotType
          createdAt
          createdAtISO
          createdBy
          updatedAt
          updatedBy
          txID
          batchLotData
          count
          itemsCount
          merkleRoot
          fabricSeal
          deliveredItemsCount
          proofedItemsCount
          pendingProofItemsCount
          hedera {
            txHash
            kind
            from
            createdAtISO
            anchorId
            status
            mirror {
              timestamp
              gasUsed
              result
              contractId
              logsCount
            }
          }
          recall {
            mode
            recalledWholeLotTxHash
            recalledAtISO
            recalledBy
            recallRoot
            recallMetadata
            recallRootSetTxHash
            recalledItemsCount
          }
        }
        page {
          currentPage
          currentSearch
          currentSortBy
          currentSortWith
          size
          totalElements
          totalPages
        }
      }
    }
  `,
  get_batch_lot: `
    query GetBatchLot($id: String!) {
      getBatchLotById(id: $id)
    }
  `,
  get_lot_items: `
    query GetLotItems($lotId: String!) {
      getItemsByLotId(lotId: $lotId) {
        itemId
        status
        count
        deliveryNumber
        containerId
      }
    }
  `,
  get_product: `
    query GetProduct($id: String!) {
      getProductById(id: $id) {
        id
        identifier
        name
        description
        regulatoryCompliance
        productData
        drugId
      }
    }
  `,
  get_drug: `
    query GetDrug($id: String!) {
      getDrugById(id: $id) {
        id
        name
        description
        drugIdentifiers
        drugData
      }
    }
  `,
  get_company: `
    query GetCompany($companyId: String!) {
      getById(id: $companyId) {
        id
        name
      }
    }
  `,
};
