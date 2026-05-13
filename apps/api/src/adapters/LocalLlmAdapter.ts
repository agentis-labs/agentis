import { HermesAdapter, type HermesAdapterOptions } from './HermesAdapter.js';

export type LocalLlmAdapterOptions = Omit<HermesAdapterOptions, 'adapterType' | 'networkAccess' | 'apiKey'>;

export class LocalLlmAdapter extends HermesAdapter {
  constructor(opts: LocalLlmAdapterOptions) {
    super({ ...opts, adapterType: 'local_llm', networkAccess: 'local' });
  }
}