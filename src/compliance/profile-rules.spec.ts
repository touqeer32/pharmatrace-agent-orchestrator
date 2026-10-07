import { getProfileRules } from './profile-rules';

describe('profile rule sets', () => {
  it('classifies the supplied exhausted GDTI profile as invalid', () => {
    const profile = {
      id: '66676389-19e4-4945-b32d-f7dae851663a',
      name: ' GDTI-01',
      incrementBy: 1,
      currentNumber: 21,
      startNumber: 1,
      numberRangeSize: 1,
      thresholdPercentage: 1,
      externalSystem: '2c7883bf-136c-48b2-956b-9b1f09c6a814',
      status: 'Active',
      index: 1,
      remaining: 0,
      companyPrefix: ' GS1',
      epcFilterValue: 1,
      documentType: 'Document-01',
    };

    const findings = getProfileRules('GDTI_PROFILE')
      .filter((rule) => rule.check(profile))
      .map((rule) => rule.ruleId);

    expect(findings).toEqual(expect.arrayContaining([
      'GDTI-NAME-003',
      'GDTI-REMAINING-003',
      'GDTI-PREFIX-002',
      'GDTI-DOC-002',
      'GDTI-FILTER-002',
    ]));
  });

  it('rejects an exhausted inconsistent SSCC profile', () => {
    const profile = {
      id: '1c74671d-955b-4918-b3f5-d6a7475bd12d',
      ssccProfileName: 'SSCC-01',
      startNumber: 1,
      incrementBy: 1,
      numberRangeSize: 10000,
      thresholdPercentage: 0,
      externalSystem: '4962404d-6721-4d57-9652-a7a48841d950',
      status: 'active',
      index: 1,
      companyPrefix: ' GS1',
      epcFilterValue: 0,
      extensionDigit: 0,
      remaining: 0,
      currentNumber: 1,
    };

    const findings = getProfileRules('SSCC_PROFILE')
      .filter((rule) => rule.check(profile))
      .map((rule) => rule.ruleId);

    expect(findings).toEqual(expect.arrayContaining([
      'SSCC-PREFIX-002',
      'SSCC-REMAINING-004',
      'SSCC-INDEX-004',
      'SSCC-THRESHOLD-003',
    ]));
  });
});
