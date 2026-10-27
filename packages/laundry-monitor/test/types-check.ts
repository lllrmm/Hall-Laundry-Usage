/**
 * 类型声明文件的自检：`npm run typecheck`
 * 这个文件不会被发布（files 字段只包含 index.js / index.d.ts / src / bin / README.md）。
 */

import {
  LaundryAuthError,
  LaundryClient,
  createClient,
  formatRemaining,
  isAvailable,
  parseMachineNumber,
  type GetMachinesOptions,
  type Machine,
  type MachineStatus,
  type RawMachinesResponse,
} from '../src/machines/index.js';

const client: LaundryClient = createClient({ token: 'test-token', timeoutMs: 5000 });

const options: GetMachinesOptions = { now: Date.now() };

async function demo(): Promise<void> {
  const status: MachineStatus = await client.getMachines(options);
  const raw: RawMachinesResponse = await client.getMachinesRaw();

  const free: Machine[] = status.machines.filter((machine: Machine) => machine.available);
  const first: Machine | undefined = free[0];
  const remaining: number | null = first?.remainingSeconds ?? null;

  console.log(status.counts.total, status.byKind.dryer?.available, free.length, formatRemaining(remaining));
  console.log(isAvailable({ status: 'enabled', state: 'available' }), parseMachineNumber('UG4 Dryer (52)'));
  console.log(raw.data.laundry_room_machines.length);
}

async function demoError(): Promise<void> {
  try {
    await client.getMachines();
  } catch (error) {
    if (error instanceof LaundryAuthError) {
      console.error('token 失效', error.code);
    } else {
      throw error;
    }
  }
}

void demo;
void demoError;
