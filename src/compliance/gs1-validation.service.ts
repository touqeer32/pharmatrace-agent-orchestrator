import { Injectable } from '@nestjs/common';
import type * as Gs1EncoderModule from 'gs1encoder';

// gs1encoder is ESM-only, while this Nest application is emitted as
// CommonJS. TypeScript rewrites a normal import() to require() under the
// CommonJS compiler target, so use the native runtime import explicitly.
const loadGs1Encoder = new Function(
  'modulePath',
  'return import(modulePath)',
) as (modulePath: string) => Promise<typeof Gs1EncoderModule>;

export type Gs1ProfileFamily = 'SERIAL_NUMBER_PROFILE' | 'GDTI_PROFILE' | 'SSCC_PROFILE';

export interface Gs1ValidationResult {
  value: string;
  valid: boolean;
  normalizedValue?: string;
  hri?: string[];
  error?: string;
  errorMarkup?: string;
}

@Injectable()
export class Gs1ValidationService {
  async validateValues(values: string[]): Promise<Gs1ValidationResult[]> {
    const { GS1encoder } = await loadGs1Encoder('gs1encoder');
    const encoder = await GS1encoder.create();
    try {
      return values.map((value) => {
        try {
          encoder.aiDataStr = value;
          return {
            value,
            valid: true,
            normalizedValue: String(encoder.aiDataStr),
            hri: [...encoder.hri],
          };
        } catch (error) {
          return {
            value,
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown GS1 validation error',
            errorMarkup: String(encoder.errMarkup ?? ''),
          };
        }
      });
    } finally {
      encoder.free();
    }
  }

  buildValues(
    family: Gs1ProfileFamily,
    generatedValues: string[],
    profile: Record<string, unknown>,
  ): { values: string[]; preparationErrors: string[] } {
    const values: string[] = [];
    const preparationErrors: string[] = [];
    for (const generated of generatedValues) {
      const value = String(generated).trim();
      try {
        if (family === 'SERIAL_NUMBER_PROFILE') {
          const gtin = this.text(profile.gtin14 ?? profile.gtin14Number ?? profile.gtin);
          if (!/^\d{14}$/.test(gtin)) throw new Error('A valid GTIN-14 is required to build AI (01) and AI (21).');
          values.push(`(01)${gtin}(21)${this.unwrap(value, '21')}`);
        } else if (family === 'GDTI_PROFILE') {
          const base = this.gdtiBase(profile);
          if (!base) throw new Error('A valid 13-digit GDTI base is required to build AI (253).');
          values.push(`(253)${base}${this.unwrap(value, '253')}`);
        } else {
          const sscc = this.unwrap(value, '00');
          if (!/^\d{18}$/.test(sscc)) throw new Error('Generated SSCC must be an 18-digit numeric value.');
          values.push(`(00)${sscc}`);
        }
      } catch (error) {
        preparationErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { values, preparationErrors };
  }

  private unwrap(value: string, ai: string): string {
    const wrapped = value.match(new RegExp(`^\\(${ai}\\)(.*)$`));
    if (wrapped) return wrapped[1];
    if (value.startsWith(ai)) return value.slice(ai.length);
    return value;
  }

  private gdtiBase(profile: Record<string, unknown>): string | null {
    const explicit = this.text(profile.gdtiBase13 ?? profile.gdti_base13);
    if (/^\d{13}$/.test(explicit)) return explicit;
    const prefix = this.text(profile.companyPrefix);
    const document = this.text(profile.documentType);
    const base = `${prefix}${document}`;
    if (!/^\d{12}$/.test(base)) return null;
    const body = base.slice(0, -1);
    const sum = [...body].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
    return `${base}${(10 - (sum % 10)) % 10}`;
  }

  private text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim();
  }
}
