import Dexie, { type Table } from 'dexie';
import type { ScanEntity, DailyLedgerEntity } from '../types/models';

export class ApparelDatabase extends Dexie {
  scans!: Table<ScanEntity, string>;
  dailyLedger!: Table<DailyLedgerEntity, string>;

  constructor() {
    super('ApparelVisionDatabase');
    this.version(1).stores({
      scans: 'apparelId, userId, timestamp, status, processingStatus, serverStored',
      dailyLedger: 'apparelId, userId, timestamp, createdDate, submittedToCsv, exportBatchId'
    });
  }
}

export const db = new ApparelDatabase();

// DAO Helper Functions
export const ScanDao = {
  async insertScan(scan: ScanEntity): Promise<string> {
    return db.scans.put(scan);
  },

  async updateScan(scan: ScanEntity): Promise<string> {
    return db.scans.put(scan);
  },

  async getScanById(apparelId: string): Promise<ScanEntity | undefined> {
    return db.scans.get(apparelId);
  },

  async deleteScan(apparelId: string): Promise<void> {
    await db.scans.delete(apparelId);
  },

  async getPendingAndFailedScans(): Promise<ScanEntity[]> {
    return db.scans
      .filter((s) => s.status === 0 || s.status === 3)
      .reverse()
      .sortBy('timestamp');
  },

  async getUnverifiedScans(): Promise<ScanEntity[]> {
    return db.scans
      .filter((s) => s.status === 1)
      .reverse()
      .sortBy('timestamp');
  },

  async getScansNeedingUpload(): Promise<ScanEntity[]> {
    return db.scans
      .filter((s) => !s.serverStored && (s.status === 0 || s.status === 3))
      .toArray();
  },

  async getScansNeedingPolling(): Promise<ScanEntity[]> {
    return db.scans
      .filter((s) => s.serverStored && s.processingStatus === 'PENDING_AI')
      .toArray();
  },

  async getAllScans(): Promise<ScanEntity[]> {
    return db.scans.toArray();
  },

  async clearAllScans(): Promise<void> {
    await db.scans.clear();
  }
};

export const LedgerDao = {
  async insertLedgerItem(item: DailyLedgerEntity): Promise<string> {
    return db.dailyLedger.put(item);
  },

  async getLedgerItemById(apparelId: string): Promise<DailyLedgerEntity | undefined> {
    return db.dailyLedger.get(apparelId);
  },

  async deleteLedgerItem(apparelId: string): Promise<void> {
    await db.dailyLedger.delete(apparelId);
  },

  async getActiveLedger(): Promise<DailyLedgerEntity[]> {
    return db.dailyLedger
      .filter((item) => !item.submittedToCsv)
      .reverse()
      .sortBy('timestamp');
  },

  async getAllLedgerHistory(): Promise<DailyLedgerEntity[]> {
    return db.dailyLedger
      .toCollection()
      .reverse()
      .sortBy('timestamp');
  },

  async stampExportBatch(timestamp: number, batchId: string): Promise<void> {
    const active = await this.getActiveLedger();
    await db.transaction('rw', db.dailyLedger, async () => {
      for (const item of active) {
        await db.dailyLedger.update(item.apparelId, {
          exportedAt: timestamp,
          exportBatchId: batchId
        });
      }
    });
  },

  async confirmBatchSubmission(batchId: string, timestamp: number): Promise<void> {
    const items = await db.dailyLedger.where('exportBatchId').equals(batchId).toArray();
    await db.transaction('rw', db.dailyLedger, async () => {
      for (const item of items) {
        await db.dailyLedger.update(item.apparelId, {
          submittedToCsv: true,
          submittedAt: timestamp
        });
      }
    });
  },

  async confirmAllActiveSubmitted(timestamp: number): Promise<void> {
    const active = await this.getActiveLedger();
    await db.transaction('rw', db.dailyLedger, async () => {
      for (const item of active) {
        await db.dailyLedger.update(item.apparelId, {
          submittedToCsv: true,
          submittedAt: timestamp
        });
      }
    });
  },

  async clearAllLedger(): Promise<void> {
    await db.dailyLedger.clear();
  }
};
