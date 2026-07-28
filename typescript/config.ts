import { createAn5Adapter, type AnyAdapter } from './an5Adapter';

export interface LlmConfigData {
  provider: string;
  apiKey: string;
  model?: string;
  endpoint?: string;
}

export interface EmbeddingConfigData {
  provider: string;
  apiKey: string;
  model?: string;
  endpoint?: string;
}

let _adapter: AnyAdapter | null = null;

function getAdapter(): AnyAdapter | null {
  if (_adapter) return _adapter;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    _adapter = createAn5Adapter({ connectionString: url });
    return _adapter;
  } catch {
    return null;
  }
}

export function resetAdapter(): void {
  _adapter = null;
}

export async function getLlmConfig(): Promise<LlmConfigData | null> {
  const adapter = getAdapter();
  if (!adapter) return null;
  try {
    const rows = await adapter.table<LlmConfigData>('LlmConfig').findMany({
      where: { isActive: true },
    });
    if (rows.length > 0) {
      const c = rows[0] as any;
      return { provider: c.provider, apiKey: c.apiKey, model: c.model, endpoint: c.endpoint };
    }
  } catch {}
  return null;
}

export async function setLlmConfig(data: LlmConfigData): Promise<void> {
  const adapter = getAdapter();
  if (!adapter) throw new Error('DATABASE_URL not configured');
  const existing = await adapter.table('LlmConfig').findFirst({ where: { isActive: true } });
  if (existing) {
    await adapter.table('LlmConfig').update({
      where: { id: (existing as any).id },
      data: { ...data, updatedAt: new Date() },
    });
  } else {
    await adapter.table('LlmConfig').create({
      data: { ...data, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    });
  }
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfigData | null> {
  const adapter = getAdapter();
  if (!adapter) return null;
  try {
    const rows = await adapter.table<EmbeddingConfigData>('EmbeddingConfig').findMany({
      where: { isActive: true },
    });
    if (rows.length > 0) {
      const c = rows[0] as any;
      return { provider: c.provider, apiKey: c.apiKey, model: c.model, endpoint: c.endpoint };
    }
  } catch {}
  return null;
}

export async function setEmbeddingConfig(data: EmbeddingConfigData): Promise<void> {
  const adapter = getAdapter();
  if (!adapter) throw new Error('DATABASE_URL not configured');
  const existing = await adapter.table('EmbeddingConfig').findFirst({ where: { isActive: true } });
  if (existing) {
    await adapter.table('EmbeddingConfig').update({
      where: { id: (existing as any).id },
      data: { ...data, updatedAt: new Date() },
    });
  } else {
    await adapter.table('EmbeddingConfig').create({
      data: { ...data, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    });
  }
}
