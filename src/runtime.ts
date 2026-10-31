import { resolve, join } from 'node:path';
import { Executor } from './executor.ts';
import { SimulationAdapter } from './adapters/simulation.ts';
import { createDreamdexAdapter } from './adapters/dreamdex.ts';
import { DomainError } from './types.ts';
import type { Mode } from './types.ts';

export async function createRuntime(options: { mode?: Mode; directory?: string } = {}) {
  const mode = options.mode ?? process.env.PERPOPS_MODE ?? 'simulation';
  if (mode !== 'simulation' && mode !== 'dreamdex') throw new DomainError('invalid_mode', 'PERPOPS_MODE must be simulation or dreamdex.');
  const directory = resolve(options.directory ?? process.env.PERPOPS_DATA_DIR ?? `.data/${mode}`);
  const simulation = mode === 'simulation' ? new SimulationAdapter(join(directory, 'exchange.sqlite')) : null;
  const adapter = simulation ?? createDreamdexAdapter({
    ...(process.env.PERPOPS_PRIVATE_KEY ? { privateKey: process.env.PERPOPS_PRIVATE_KEY } : {}),
    ...(process.env.PERPOPS_ACCOUNT ? { account: process.env.PERPOPS_ACCOUNT } : {}),
    ...(process.env.PERPOPS_RPC_URL ? { rpcUrl: process.env.PERPOPS_RPC_URL } : {}),
    allowTrading: process.env.PERPOPS_TESTNET_TRADING === '1',
  });
  try {
    const executor = await Executor.open({ path: join(directory, 'journal.sqlite'), adapter });
    return { mode, directory, executor, simulation };
  } catch (error) { await adapter.close?.(); throw error; }
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
