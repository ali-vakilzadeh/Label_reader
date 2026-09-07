import Dexie, { type Table } from 'dexie';
import type { DailyLedgerEntity, GarmentFields, ScanEntity } from '../types/models';
import { emptyGarmentFields } from '../types/models';
import type { ReferenceSnapshot } from './referenceTables';

/** One row, id 'tables' - the cached copy of GET /api/v1/reference-tables. */
export interface ReferenceCacheRow extends ReferenceSnapshot {
  id: string;
  cachedAt: number;
}

/** Shape of the v1 records, needed only by the upgrade below. */
interface LegacyFlatRecord {
  extractedCategory?: string;
  extractedSubCategory?: string;
  extractedGender?: string;
  extractedSeason?: string;
  extractedBrandName?: string;
  extractedCountryOfOrigin?: string;
  extractedSize?: string;
  extractedColor?: string;
  extractedMaterial?: string;
  extractedOriginalPrice?: string;
  extractedNetto?: string;
  extractedBrutto?: string;
  category?: string;
  subCategory?: string;
  gender?: string;
  season?: string;
  brandName?: string;
  countryOfOrigin?: string;
  size?: string;
  color?: string;
  material?: string;
  originalPrice?: string;
  netto?: string;
  brutto?: string;
}

export class ApparelDatabase extends Dexie {
  scans!: Table<ScanEntity, string>;
  dailyLedger!: Table<DailyLedgerEntity, string>;
  reference!: Table<ReferenceCacheRow, string>;

  constructor() {
    super('ApparelVisionDatabase');

    this.version(1).stores({
      scans: 'apparelId, userId, timestamp, status, processingStatus, serverStored',
      dailyLedger: 'apparelId, userId, timestamp, createdDate, submittedToCsv, exportBatchId'
    });

    // v2 (contract v1.4): the twelve flat extracted* columns collapse into one
    // `fields` object of thirteen, care_info joins them, and PackageCode / SetSize
    // appear as device-only columns. Existing rows are migrated rather than dropped -
    // a device mid-shift must not lose a day's scans to an app update.
    this.version(2)
      .stores({
        scans: 'apparelId, userId, timestamp, status, processingStatus, serverStored',
        dailyLedger: 'apparelId, userId, timestamp, createdDate, submittedToCsv, exportBatchId',
        reference: 'id'
      })
      .upgrade(async (tx) => {
        await tx
          .table('scans')
          .toCollection()
          .modify((scan: ScanEntity & LegacyFlatRecord) => {
            scan.extracted = {
              ...emptyGarmentFields(),
              brandName: scan.extractedBrandName ?? '',
              countryOfOrigin: scan.extractedCountryOfOrigin ?? '',
              size: scan.extractedSize ?? '',
              color: scan.extractedColor ?? '',
              material: scan.extractedMaterial ?? '',
              originalPrice: scan.extractedOriginalPrice ?? '',
              netto: scan.extractedNetto ?? '',
              brutto: scan.extractedBrutto ?? '',
              category: scan.extractedCategory ?? '',
              subCategory: scan.extractedSubCategory ?? '',
              gender: scan.extractedGender ?? '',
              season: scan.extractedSeason ?? ''
            };
            scan.armenian = {};
            scan.packageCode = '';
            scan.setSize = 1;
            scan.suggestedKeyPhotoIndex = null;

            delete scan.extractedBrandName;
            delete scan.extractedCountryOfOrigin;
            delete scan.extractedSize;
            delete scan.extractedColor;
            delete scan.extractedMaterial;
            delete scan.extractedOriginalPrice;
            delete scan.extractedNetto;
            delete scan.extractedBrutto;
            delete scan.extractedCategory;
            delete scan.extractedSubCategory;
            delete scan.extractedGender;
            delete scan.extractedSeason;
          });

        await tx
          .table('dailyLedger')
          .toCollection()
          .modify((item: DailyLedgerEntity & LegacyFlatRecord) => {
            item.fields = {
              ...emptyGarmentFields(),
              brandName: item.brandName ?? '',
              countryOfOrigin: item.countryOfOrigin ?? '',
              size: item.size ?? '',
              color: item.color ?? '',
              material: item.material ?? '',
              originalPrice: item.originalPrice ?? '',
              netto: item.netto ?? '',
              brutto: item.brutto ?? '',
              category: item.category ?? '',
              subCategory: item.subCategory ?? '',
              gender: item.gender ?? '',
              season: item.season ?? ''
            };
            item.packageCode = '';
            item.setSize = 1;

            delete item.brandName;
            delete item.countryOfOrigin;
            delete item.size;
            delete item.color;
            delete item.material;
            delete item.originalPrice;
            delete item.netto;
            delete item.brutto;
            delete item.category;
            delete item.subCategory;
            delete item.gender;
            delete item.season;
          });
      });
  }
}

export const db = new ApparelDatabase();

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
    return db.scans.filter((s) => !s.serverStored && (s.status === 0 || s.status === 3)).toArray();
  },

  async getScansNeedingPolling(): Promise<ScanEntity[]> {
    return db.scans.filter((s) => s.serverStored && s.processingStatus === 'PENDING_AI').toArray();
  },

  /** Persists the operator's in-progress edits without confirming the record. */
  async saveDraft(apparelId: string, draft: GarmentFields): Promise<void> {
    await db.scans.update(apparelId, { draft, draftSavedAt: Date.now() });
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

  /**
   * Applies operator edits to a row that has not been exported. Refuses once an
   * exportBatchId is stamped: that row is already inside a file on someone's disk,
   * and silently diverging from it is worse than refusing the edit.
   */
  async updateLedgerItem(
    apparelId: string,
    changes: Partial<Pick<DailyLedgerEntity, 'fields' | 'packageCode' | 'setSize' | 'keyPhotoIndex' | 'photos'>>
  ): Promise<'updated' | 'locked' | 'missing'> {
    const item = await db.dailyLedger.get(apparelId);
    if (!item) return 'missing';
    if (item.exportBatchId || item.submittedToCsv) return 'locked';
    await db.dailyLedger.update(apparelId, { ...changes, editedByUser: true });
    return 'updated';
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

  /** Rows that have never been written into a file, i.e. the next export's contents. */
  async getUnexportedLedger(): Promise<DailyLedgerEntity[]> {
    return db.dailyLedger
      .filter((item) => !item.submittedToCsv && !item.exportBatchId)
      .reverse()
      .sortBy('timestamp');
  },

  async getAllLedgerHistory(): Promise<DailyLedgerEntity[]> {
    return db.dailyLedger.toCollection().reverse().sortBy('timestamp');
  },

  async stampExportBatch(apparelIds: string[], timestamp: number, batchId: string): Promise<void> {
    await db.transaction('rw', db.dailyLedger, async () => {
      for (const apparelId of apparelIds) {
        await db.dailyLedger.update(apparelId, { exportedAt: timestamp, exportBatchId: batchId });
      }
    });
  },

  async confirmBatchSubmission(batchId: string, timestamp: number): Promise<void> {
    const items = await db.dailyLedger.where('exportBatchId').equals(batchId).toArray();
    await db.transaction('rw', db.dailyLedger, async () => {
      for (const item of items) {
        await db.dailyLedger.update(item.apparelId, { submittedToCsv: true, submittedAt: timestamp });
      }
    });
  },

  async clearAllLedger(): Promise<void> {
    await db.dailyLedger.clear();
  }
};

export const ReferenceDao = {
  async load(): Promise<ReferenceCacheRow | undefined> {
    return db.reference.get('tables');
  },

  async save(snapshot: ReferenceSnapshot): Promise<void> {
    await db.reference.put({ ...snapshot, id: 'tables', cachedAt: Date.now() });
  },

  async clear(): Promise<void> {
    await db.reference.clear();
  }
};
