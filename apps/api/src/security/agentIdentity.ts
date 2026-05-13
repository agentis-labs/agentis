import type { AuthService } from '../services/auth.js';

export interface AgentIdentityAgentRow {
  id: string;
  workspaceId: string;
  packageId: string | null;
  name: string;
  adapterType: string;
  capabilityTags: unknown;
  runtimeModel: string | null;
  role: string;
  capabilityVersion: number;
  createdAt: string;
  updatedAt: string;
}

export async function buildAgentIdentityManifest(args: {
  auth: AuthService;
  agent: AgentIdentityAgentRow;
  baseUrl?: string;
}) {
  const issuedAt = new Date().toISOString();
  const identity = {
    schema: 'agentis.agent.identity.v1',
    issuer: 'agentis',
    agentId: args.agent.id,
    workspaceId: args.agent.workspaceId,
    name: args.agent.name,
    role: args.agent.role,
    adapterType: args.agent.adapterType,
    runtimeModel: args.agent.runtimeModel,
    packageId: args.agent.packageId,
    capabilityTags: Array.isArray(args.agent.capabilityTags) ? args.agent.capabilityTags : [],
    capabilityVersion: args.agent.capabilityVersion,
    jwksUri: `${args.baseUrl ?? ''}/.well-known/jwks.json`,
    issuedAt,
    updatedAt: args.agent.updatedAt,
  };
  const [jwks, kid, signatureJwt] = await Promise.all([
    args.auth.jwks(),
    args.auth.kid(),
    args.auth.signAgentIdentity(identity),
  ]);
  return {
    ...identity,
    proof: {
      type: 'JWT',
      alg: 'RS256',
      kid,
      jwt: signatureJwt,
    },
    publicKeys: jwks.keys,
  };
}