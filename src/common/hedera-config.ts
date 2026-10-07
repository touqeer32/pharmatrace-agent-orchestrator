export type HederaNetwork = 'testnet' | 'mainnet';

export function hederaNetwork(env: NodeJS.ProcessEnv = process.env): HederaNetwork {
  const value = (env.HEDERA_NETWORK ?? 'testnet').toLowerCase();
  if (value !== 'testnet' && value !== 'mainnet') {
    throw new Error('HEDERA_NETWORK must be testnet or mainnet');
  }
  return value;
}

export function hederaTopicId(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  const selected = network === 'mainnet' ? env.HEDERA_TOPIC_ID_MAINNET : env.HEDERA_TOPIC_ID_TESTNET;
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error(`HEDERA_TOPIC_ID_${network.toUpperCase()} is required`);
    return selected;
  }
  if (!env.HEDERA_TOPIC_ID?.trim()) throw new Error(`HEDERA_TOPIC_ID_${network.toUpperCase()} or HEDERA_TOPIC_ID is required`);
  return env.HEDERA_TOPIC_ID;
}

export function mirrorNodeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  const selected = network === 'mainnet' ? env.MIRROR_NODE_URL_MAINNET : env.MIRROR_NODE_URL_TESTNET;
  return (selected ?? env.MIRROR_NODE_URL ?? `https://${network}.mirrornode.hedera.com`).replace(/\/$/, '');
}

export function hederaRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  const selected = network === 'mainnet' ? env.HEDERA_RPC_URL_MAINNET : env.HEDERA_RPC_URL_TESTNET;
  return (selected ?? env.HEDERA_RPC_URL ?? `https://${network}.hashio.io/api`).replace(/\/$/, '');
}

export function pharmatraceMirrorNodeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  const selected = network === 'mainnet'
    ? env.PHARMATRACE_MIRROR_NODE_URL_MAINNET
    : env.PHARMATRACE_MIRROR_NODE_URL_TESTNET;
  return (selected ?? env.PHARMATRACE_MIRROR_NODE_URL ?? mirrorNodeUrl(env)).replace(/\/$/, '');
}

export function pharmatraceManagerAddress(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  const selected = network === 'mainnet'
    ? env.PHARMATRACE_MANAGER_ADDRESS_MAINNET
    : env.PHARMATRACE_MANAGER_ADDRESS_TESTNET;
  const address = selected ?? env.PHARMATRACE_MANAGER_ADDRESS;
  if (!address) throw new Error(`PHARMATRACE_MANAGER_ADDRESS_${network.toUpperCase()} or PHARMATRACE_MANAGER_ADDRESS is required`);
  return address;
}

function networkSecret(env: NodeJS.ProcessEnv, baseName: string, network: HederaNetwork): string {
  const selected = env[`${baseName}_${network.toUpperCase()}`];
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error(`${baseName}_${network.toUpperCase()} is required`);
    return selected;
  }
  if (!env[baseName]?.trim()) throw new Error(`${baseName} is required`);
  return env[baseName] as string;
}

export function hederaAgentAccountId(env: NodeJS.ProcessEnv = process.env): string {
  return networkSecret(env, 'AGENT_HEDERA_ACCOUNT_ID', hederaNetwork(env));
}

export function hederaAgentPrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  return networkSecret(env, 'AGENT_HEDERA_PRIVATE_KEY', hederaNetwork(env));
}

export function hederaAgentKeyType(env: NodeJS.ProcessEnv = process.env): string {
  const network = hederaNetwork(env);
  return (env[`AGENT_HEDERA_KEY_TYPE_${network.toUpperCase()}`] ?? env.AGENT_HEDERA_KEY_TYPE ?? 'ED25519').toUpperCase();
}

export function hederaSignerPrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  return networkSecret(env, 'HEDERA_SIGNER_PRIVATE_KEY', hederaNetwork(env));
}
