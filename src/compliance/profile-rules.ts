export type ProfileRuleFamily = 'SERIAL_NUMBER_PROFILE' | 'SSCC_PROFILE' | 'GDTI_PROFILE';

export interface ProfileRule {
  ruleId: string;
  title: string;
  field?: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  requiresResolution: boolean;
  userCanFix: boolean;
  check: (profile: Record<string, unknown>) => string | null;
}

export interface ProfileRuleDefinition {
  ruleId: string;
  title: string;
  field?: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  requiresResolution: boolean;
  userCanFix: boolean;
  validationType: 'DETERMINISTIC' | 'CONTEXTUAL';
  remediationAction: string;
  remediationTarget: string;
  allowedAssessments: Array<'CONFIRMED' | 'DISPUTED' | 'NEEDS_CONTEXT'>;
  severityWhenRfidEnabled?: 'HIGH' | 'MEDIUM' | 'INFO';
  severityWhenRfidDisabled?: 'HIGH' | 'MEDIUM' | 'INFO';
}

const text = (value: unknown): string => value === null || value === undefined ? '' : String(value).trim();
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const integer = (value: unknown): number | null => {
  const parsed = numeric(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};
const bigInteger = (value: unknown): bigint | null => {
  const raw = text(value);
  if (!/^-\d+$|^\d+$/.test(raw)) return null;
  try { return BigInt(raw); } catch { return null; }
};
const positive = (value: unknown): boolean => {
  const parsed = integer(value);
  return parsed !== null && parsed > 0;
};

const rule = (
  ruleId: string,
  title: string,
  field: string,
  severity: ProfileRule['severity'],
  requiresResolution: boolean,
  userCanFix: boolean,
  check: ProfileRule['check'],
): ProfileRule => ({ ruleId, title, field, severity, requiresResolution, userCanFix, check });

function gdtiRules(): ProfileRule[] {
  const maxGdti96 = 2_199_023_255_551n;
  return [
    rule('GDTI-NAME-001', 'GDTI name is missing', 'name', 'HIGH', true, true, p => text(p.name) ? null : 'Name is required.'),
    rule('GDTI-NAME-002', 'GDTI name is too long', 'name', 'HIGH', true, true, p => text(p.name).length <= 100 ? null : 'Name must be 100 characters or fewer.'),
    rule('GDTI-NAME-003', 'GDTI name contains surrounding whitespace', 'name', 'MEDIUM', false, true, p => String(p.name ?? '') === text(p.name) ? null : `Trim the profile name to "${text(p.name)}".`),
    rule('GDTI-START-001', 'Start number must be an integer', 'startNumber', 'HIGH', true, true, p => integer(p.startNumber) === null ? 'startNumber must be an integer.' : null),
    rule('GDTI-START-002', 'Start number must be non-negative', 'startNumber', 'HIGH', true, true, p => { const n = integer(p.startNumber); return n !== null && n >= 0 ? null : 'startNumber must be zero or greater.'; }),
    rule('GDTI-START-003', 'Start number exceeds GDTI-96 limit', 'startNumber', 'HIGH', true, true, p => { const n = bigInteger(p.startNumber); return n !== null && n >= 0n && n <= maxGdti96 ? null : 'startNumber exceeds the GDTI-96 maximum.'; }),
    rule('GDTI-INCREMENT-001', 'Increment must be a positive integer', 'incrementBy', 'HIGH', true, true, p => positive(p.incrementBy) ? null : 'incrementBy must be an integer greater than zero.'),
    rule('GDTI-INCREMENT-003', 'GDTI range overflows GDTI-96', 'incrementBy', 'HIGH', true, true, p => {
      const start = bigInteger(p.startNumber); const increment = bigInteger(p.incrementBy); const size = bigInteger(p.numberRangeSize);
      if (start === null || increment === null || size === null || size < 1n) return null;
      return start + ((size - 1n) * increment) <= maxGdti96 ? null : 'The configured range exceeds the GDTI-96 maximum.';
    }),
    rule('GDTI-CURRENT-001', 'Current number must be an integer', 'currentNumber', 'HIGH', true, true, p => integer(p.currentNumber) === null ? 'currentNumber must be an integer.' : null),
    rule('GDTI-CURRENT-002', 'Current number is before the start number', 'currentNumber', 'HIGH', true, true, p => { const current = integer(p.currentNumber); const start = integer(p.startNumber); return current !== null && start !== null && current >= start ? null : 'currentNumber must not be before startNumber.'; }),
    rule('GDTI-CURRENT-003', 'Current number is not aligned to the increment', 'currentNumber', 'HIGH', true, true, p => { const current = integer(p.currentNumber); const start = integer(p.startNumber); const increment = integer(p.incrementBy); return current !== null && start !== null && increment && (current - start) % increment === 0 ? null : 'currentNumber must be reachable from startNumber using incrementBy.'; }),
    rule('GDTI-CURRENT-004', 'Current number exceeds GDTI-96 limit', 'currentNumber', 'HIGH', true, true, p => { const current = bigInteger(p.currentNumber); return current !== null && current >= 0n && current <= maxGdti96 ? null : 'currentNumber exceeds the GDTI-96 maximum.'; }),
    rule('GDTI-RANGE-001', 'Number range size must be a positive integer', 'numberRangeSize', 'HIGH', true, true, p => positive(p.numberRangeSize) ? null : 'numberRangeSize must be an integer greater than zero.'),
    rule('GDTI-RANGE-003', 'Number range size is too large', 'numberRangeSize', 'HIGH', true, true, p => { const size = integer(p.numberRangeSize); return size !== null && size <= 99_999_999 ? null : 'numberRangeSize must not exceed 99,999,999.'; }),
    rule('GDTI-RANGE-004', 'GDTI range contains only one serial', 'numberRangeSize', 'MEDIUM', false, true, p => integer(p.numberRangeSize) === 1 ? 'Consider a larger range to reduce allocation requests.' : null),
    rule('GDTI-REMAINING-001', 'Remaining number must be a non-negative integer', 'remaining', 'HIGH', true, false, p => { const remaining = integer(p.remaining); return remaining !== null && remaining >= 0 ? null : 'remaining must be a non-negative integer.'; }),
    rule('GDTI-REMAINING-002', 'Remaining number exceeds the range', 'remaining', 'HIGH', true, false, p => { const remaining = integer(p.remaining); const size = integer(p.numberRangeSize); return remaining !== null && size !== null && remaining <= size ? null : 'remaining must not exceed numberRangeSize.'; }),
    rule('GDTI-REMAINING-003', 'GDTI range is exhausted', 'remaining', 'HIGH', true, false, p => integer(p.remaining) === 0 ? 'The current serial-number range is exhausted; request replenishment before generating.' : null),
    rule('GDTI-THRESHOLD-001', 'Threshold percentage is invalid', 'thresholdPercentage', 'HIGH', true, true, p => { const threshold = integer(p.thresholdPercentage); return threshold !== null && threshold >= 0 && threshold <= 100 ? null : 'thresholdPercentage must be an integer from 0 through 100; zero disables threshold alerts.'; }),
    rule('GDTI-THRESHOLD-003', 'GDTI range is at or below its threshold', 'remaining', 'MEDIUM', false, false, p => { const remaining = integer(p.remaining); const size = integer(p.numberRangeSize); const threshold = integer(p.thresholdPercentage); if (remaining === null || size === null || threshold === null || threshold === 0) return null; return remaining * 100 <= size * threshold ? 'Remaining capacity is at or below the configured replenishment threshold.' : null; }),
    rule('GDTI-INDEX-001', 'GDTI index must be a non-negative integer', 'index', 'HIGH', true, false, p => { const index = integer(p.index); return index !== null && index >= 0 ? null : 'index must be a non-negative integer.'; }),
    rule('GDTI-INDEX-003', 'GDTI index does not reconcile with current number', 'index', 'HIGH', true, false, p => { const index = integer(p.index); const current = integer(p.currentNumber); const start = integer(p.startNumber); const increment = integer(p.incrementBy); if ([index, current, start, increment].some(v => v === null)) return null; return start! + (index! * increment!) === current || start! + ((index! - 1) * increment!) === current ? null : 'Index does not reconcile with currentNumber under the supported zero-based or one-based definitions.'; }),
    rule('GDTI-PREFIX-001', 'GS1 Company Prefix is missing', 'companyPrefix', 'HIGH', true, true, p => text(p.companyPrefix) ? null : 'Select an assigned numeric GS1 Company Prefix.'),
    rule('GDTI-PREFIX-002', 'GS1 Company Prefix is not numeric', 'companyPrefix', 'HIGH', true, true, p => /^[0-9]+$/.test(text(p.companyPrefix)) ? null : 'Company Prefix must resolve to an assigned numeric GS1 Company Prefix.'),
    rule('GDTI-PREFIX-005', 'GS1 Company Prefix length is unsupported', 'companyPrefix', 'HIGH', true, true, p => { const prefix = text(p.companyPrefix); return prefix.length >= 6 && prefix.length <= 12 ? null : 'Company Prefix must contain 6 through 12 digits for the configured encoder.'; }),
    rule('GDTI-DOC-001', 'GDTI document reference is missing', 'documentType', 'HIGH', true, true, p => text(p.documentType) ? null : 'Document Type must be provided.'),
    rule('GDTI-DOC-002', 'GDTI document reference is not numeric', 'documentType', 'HIGH', true, true, p => /^[0-9]+$/.test(text(p.documentType)) ? null : 'Document Type must resolve to a numeric document reference.'),
    rule('GDTI-DOC-003', 'GDTI base key does not contain 12 digits', 'documentType', 'HIGH', true, true, p => { const prefix = text(p.companyPrefix); const document = text(p.documentType); return /^\d+$/.test(prefix) && /^\d+$/.test(document) && prefix.length + document.length === 12 ? null : 'Company Prefix plus document reference must contain exactly 12 digits.'; }),
    rule('GDTI-FILTER-001', 'GDTI EPC filter configuration is unsupported', 'epcFilterValue', 'MEDIUM', false, true, p => ['0', '1'].includes(text(p.epcFilterValue)) ? null : 'For EPC/RFID encoding, use filter 0 (All Others) or filter 1 (Travel Document). This advisory does not invalidate the numeric (253) GDTI.'),
    rule('GDTI-FILTER-002', 'GDTI EPC filter 1 lacks travel-document context', 'epcFilterValue', 'MEDIUM', false, true, p => text(p.epcFilterValue) === '1' && !/travel/i.test(text(p.documentType)) ? 'Filter 1 is configured, but the supplied profile does not verify that this is a travel document. Confirm the document classification; keep filter 1 for a verified travel document, otherwise change epcFilterValue to 0. This does not affect numeric (253) GDTI validity.' : null),
    rule('GDTI-STATUS-002', 'Active GDTI profile has no remaining serials', 'status', 'HIGH', true, false, p => /active/i.test(text(p.status)) && integer(p.remaining) === 0 ? 'Active profile is exhausted and must be replenished before generation.' : null),
  ];
}

function ssccRules(): ProfileRule[] {
  return [
    rule('SSCC-NAME-001', 'SSCC profile name is missing', 'ssccProfileName', 'HIGH', true, true, p => text(p.ssccProfileName) ? null : 'An SSCC profile must have a name.'),
    rule('SSCC-NAME-002', 'SSCC profile name is too long', 'ssccProfileName', 'HIGH', true, true, p => text(p.ssccProfileName).length <= 100 ? null : 'Name must be 100 characters or fewer.'),
    rule('SSCC-NAME-004', 'SSCC profile name contains surrounding whitespace', 'ssccProfileName', 'MEDIUM', false, true, p => String(p.ssccProfileName ?? '') === text(p.ssccProfileName) ? null : 'Trim the profile name.'),
    rule('SSCC-START-001', 'SSCC start number must be an integer', 'startNumber', 'HIGH', true, true, p => integer(p.startNumber) === null ? 'startNumber must be an integer.' : null),
    rule('SSCC-START-002', 'SSCC start number must be non-negative', 'startNumber', 'HIGH', true, true, p => { const value = integer(p.startNumber); return value !== null && value >= 0 ? null : 'startNumber must be zero or greater.'; }),
    rule('SSCC-INCREMENT-001', 'SSCC increment is invalid', 'incrementBy', 'HIGH', true, true, p => positive(p.incrementBy) ? null : 'incrementBy must be a positive integer.'),
    rule('SSCC-RANGE-001', 'SSCC range size is invalid', 'numberRangeSize', 'HIGH', true, true, p => positive(p.numberRangeSize) ? null : 'numberRangeSize must be a positive integer.'),
    rule('SSCC-PREFIX-001', 'SSCC company prefix is missing', 'companyPrefix', 'HIGH', true, true, p => text(p.companyPrefix) ? null : 'Select an assigned numeric GS1 Company Prefix.'),
    rule('SSCC-PREFIX-002', 'SSCC company prefix is not numeric', 'companyPrefix', 'HIGH', true, true, p => /^[0-9]+$/.test(text(p.companyPrefix)) ? null : 'Company Prefix must resolve to an assigned numeric GS1 Company Prefix.'),
    rule('SSCC-PREFIX-006', 'SSCC serial-reference capacity is invalid', 'companyPrefix', 'HIGH', true, true, p => { const prefix = text(p.companyPrefix); return prefix.length >= 6 && prefix.length <= 12 ? null : 'Company Prefix must contain 6 through 12 digits so the serial reference can fit in an SSCC.'; }),
    rule('SSCC-RANGE-003', 'SSCC range exceeds serial-reference capacity', 'numberRangeSize', 'HIGH', true, true, p => {
      const prefix = text(p.companyPrefix); const start = integer(p.startNumber); const increment = integer(p.incrementBy); const size = integer(p.numberRangeSize);
      if (!/^\d{6,12}$/.test(prefix) || start === null || increment === null || size === null || size < 1) return null;
      const maxReference = 10 ** (16 - prefix.length) - 1;
      return start + ((size - 1) * increment) <= maxReference ? null : 'The configured SSCC range does not fit the available serial-reference digits.';
    }),
    rule('SSCC-CURRENT-001', 'SSCC current number must be a non-negative integer', 'currentNumber', 'HIGH', true, true, p => { const value = integer(p.currentNumber); return value !== null && value >= 0 ? null : 'currentNumber must be a non-negative integer.'; }),
    rule('SSCC-CURRENT-002', 'SSCC current number is before start number', 'currentNumber', 'HIGH', true, true, p => { const current = integer(p.currentNumber); const start = integer(p.startNumber); return current !== null && start !== null && current >= start ? null : 'currentNumber must not be before startNumber.'; }),
    rule('SSCC-CURRENT-003', 'SSCC current number is not aligned to increment', 'currentNumber', 'HIGH', true, true, p => { const current = integer(p.currentNumber); const start = integer(p.startNumber); const increment = integer(p.incrementBy); return current !== null && start !== null && increment && (current - start) % increment === 0 ? null : 'currentNumber must be reachable from startNumber using incrementBy.'; }),
    rule('SSCC-CURRENT-004', 'SSCC current number exceeds the allocated range', 'currentNumber', 'HIGH', true, true, p => { const current = integer(p.currentNumber); const start = integer(p.startNumber); const increment = integer(p.incrementBy); const size = integer(p.numberRangeSize); if ([current, start, increment, size].some(v => v === null) || size! < 1) return null; return current! <= start! + ((size! - 1) * increment!) ? null : 'currentNumber exceeds the configured range.'; }),
    rule('SSCC-THRESHOLD-001', 'SSCC threshold percentage is invalid', 'thresholdPercentage', 'HIGH', true, true, p => { const value = integer(p.thresholdPercentage); return value !== null && value >= 0 && value <= 100 ? null : 'thresholdPercentage must be an integer from 0 through 100.'; }),
    rule('SSCC-THRESHOLD-003', 'SSCC low-capacity notifications are disabled', 'thresholdPercentage', 'MEDIUM', false, true, p => integer(p.thresholdPercentage) === 0 ? 'Set a positive threshold to receive low-capacity notifications.' : null),
    rule('SSCC-THRESHOLD-004', 'SSCC range is at or below its threshold', 'remaining', 'MEDIUM', false, false, p => { const remaining = integer(p.remaining); const size = integer(p.numberRangeSize); const threshold = integer(p.thresholdPercentage); if (remaining === null || size === null || threshold === null || threshold === 0) return null; return remaining <= Math.ceil(size * threshold / 100) ? 'Remaining capacity is at or below the configured replenishment threshold.' : null; }),
    rule('SSCC-INDEX-001', 'SSCC index must be a non-negative integer', 'index', 'HIGH', true, false, p => { const value = integer(p.index); return value !== null && value >= 0 ? null : 'index must be a non-negative integer.'; }),
    rule('SSCC-INDEX-003', 'SSCC index does not reconcile with current number', 'index', 'HIGH', true, false, p => { const index = integer(p.index); const current = integer(p.currentNumber); const start = integer(p.startNumber); const increment = integer(p.incrementBy); if ([index, current, start, increment].some(v => v === null)) return null; return start! + (index! * increment!) === current || (index! > 0 && start! + ((index! - 1) * increment!) === current) ? null : 'Index does not reconcile with currentNumber.'; }),
    rule('SSCC-INDEX-004', 'SSCC remaining count does not reconcile with index', 'remaining', 'HIGH', true, false, p => { const index = integer(p.index); const remaining = integer(p.remaining); const size = integer(p.numberRangeSize); if ([index, remaining, size].some(v => v === null)) return null; return remaining === size! - index! ? null : 'remaining is inconsistent with numberRangeSize and the consumed index.'; }),
    rule('SSCC-REMAINING-001', 'SSCC remaining number is invalid', 'remaining', 'HIGH', true, false, p => { const value = integer(p.remaining); return value !== null && value >= 0 ? null : 'remaining must be a non-negative integer.'; }),
    rule('SSCC-REMAINING-002', 'SSCC remaining number exceeds the range', 'remaining', 'HIGH', true, false, p => { const remaining = integer(p.remaining); const size = integer(p.numberRangeSize); return remaining !== null && size !== null && remaining <= size ? null : 'remaining must not exceed numberRangeSize.'; }),
    rule('SSCC-REMAINING-004', 'SSCC range is exhausted', 'remaining', 'HIGH', true, false, p => integer(p.remaining) === 0 ? 'The SSCC range is exhausted and must be replenished before generation.' : null),
    rule('SSCC-REMOTE-001', 'SSCC remote system is missing', 'externalSystem', 'HIGH', true, true, p => text(p.externalSystem) ? null : 'Select an active SSCC-compatible Remote System.'),
    rule('SSCC-EPC-FILTER-001', 'SSCC EPC filter is invalid', 'epcFilterValue', 'HIGH', true, true, p => [0, 2, 6].includes(integer(p.epcFilterValue) ?? -1) ? null : 'For SSCC-96 EPC/RFID encoding, use a supported non-reserved filter: 0 (All Others), 2 (Full Case), or 6 (Unit Load). The filter is not part of the 18-digit SSCC or its Mod-10 check digit.'),
    rule('SSCC-EXTENSION-001', 'SSCC extension digit is invalid', 'extensionDigit', 'HIGH', true, true, p => { const value = integer(p.extensionDigit); return value !== null && value >= 0 && value <= 9 ? null : 'extensionDigit must be one digit from 0 through 9.'; }),
    rule('SSCC-STATUS-002', 'Active SSCC profile has no remaining serials', 'status', 'MEDIUM', false, true, p => /active/i.test(text(p.status)) && integer(p.remaining) === 0 ? 'This profile is active but exhausted; generation must remain blocked until replenishment.' : null),
  ];
}

/** Returns the deterministic rule set selected by the profile agent family. */
export function getProfileRules(family: ProfileRuleFamily): ProfileRule[] {
  switch (family) {
    case 'GDTI_PROFILE': return gdtiRules();
    case 'SSCC_PROFILE': return ssccRules();
    case 'SERIAL_NUMBER_PROFILE': return [];
  }
}

/** Public, model-safe representation of the rules used for a profile review. */
export function getProfileRuleDefinitions(family: ProfileRuleFamily): ProfileRuleDefinition[] {
  return getProfileRules(family).map(({ check: _check, ...definition }) => {
    // Resolution policy and epistemic certainty are different concepts. An
    // informational deterministic rule is still proven by the profile. Only
    // rules that require business context are contextual; currently this is
    // the GDTI travel-document filter rule.
    const contextual = /^GDTI-FILTER-00[12]$/.test(definition.ruleId);
    const id = definition.ruleId;
    let remediationAction = definition.userCanFix ? 'UPDATE_PROFILE_FIELD' : 'ESCALATE_TO_RANGE_OR_MASTER_DATA_OWNER';
    let remediationTarget = definition.userCanFix ? 'PROFILE_CONFIGURATION' : 'MASTER_DATA_OR_ALLOCATION';
    if (/REMAINING|THRESHOLD|STATUS/.test(id)) {
      remediationAction = 'REPLENISH_NUMBER_RANGE';
      remediationTarget = 'RANGE_ALLOCATION';
    } else if (/INDEX/.test(id)) {
      remediationAction = 'RECONCILE_GENERATOR_STATE';
      remediationTarget = 'GENERATOR_STATE';
    } else if (/GENERATION|GS1-ENGINE|OUTPUT/.test(id)) {
      remediationAction = 'INVESTIGATE_GENERATOR';
      remediationTarget = 'GENERATOR_OUTPUT';
    } else if (/NAME/.test(id) && /WHITESPACE/.test(definition.title.toUpperCase())) {
      remediationAction = 'TRIM_PROFILE_FIELD';
      remediationTarget = 'PROFILE_CONFIGURATION';
    } else if (contextual) {
      remediationAction = 'REQUEST_CONTEXT';
      remediationTarget = 'PROFILE_CONFIGURATION';
    }
    return {
      ...definition,
      validationType: contextual ? 'CONTEXTUAL' : 'DETERMINISTIC',
      remediationAction,
      remediationTarget,
      allowedAssessments: contextual
        ? ['CONFIRMED', 'DISPUTED', 'NEEDS_CONTEXT']
        : ['CONFIRMED'],
      ...(definition.ruleId === 'SSCC-EPC-FILTER-001'
        ? { severityWhenRfidEnabled: 'HIGH' as const, severityWhenRfidDisabled: 'INFO' as const }
        : {}),
    };
  });
}
