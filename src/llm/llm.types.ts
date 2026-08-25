export type LlmProvider = 'ANTHROPIC' | 'OPENAI' | 'OLLAMA';

export interface LlmConnection {
  id: string;
  tenant_id: string;
  provider: LlmProvider;
  name: string;
  api_key_secret_ref: string;
  api_key_hint: string | null;
  base_url: string | null;
  organization_id: string | null;
  project_id: string | null;
  enabled: boolean;
  last_tested_at: Date | null;
  last_test_succeeded: boolean | null;
  last_test_error: string | null;
}
