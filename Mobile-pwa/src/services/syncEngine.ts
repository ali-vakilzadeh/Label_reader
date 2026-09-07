import { ScanDao } from '../data/db';
import { vocabulary } from '../data/vocabulary';
import { VisionApiService } from './visionApiService';
import { exportLedgerCsv, type ExportOutcome } from './csvExport';
import { AI_FIELDS, type AsyncVisionResponse, type ScanEntity } from '../types/models';

type SyncListener = () => void;

class SyncEngine {
  private isRunning = false;
  private isProcessing = false;
  private intervalId: number | null = null;
  private listeners = new Set<SyncListener>();

  public isServerReachable = true;
  /** Contract revision the server reports, for the banner in Settings. */
  public serverContract: string | null = null;

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch (err) {
        console.error('SyncEngine listener error:', err);
      }
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.checkHealth();
    this.intervalId = window.setInterval(() => void this.runSyncLoop(), 6000);
    void this.runSyncLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkHealth(): Promise<boolean> {
    const res = await VisionApiService.checkHealth();
    this.isServerReachable = res.ok;
    this.serverContract = res.data?.api_contract ?? null;
    this.notify();
    return res.ok;
  }

  async runSyncLoop() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      for (const scan of await ScanDao.getScansNeedingUpload()) {
        await this.submitScan(scan);
      }

      const pollingQueue = await ScanDao.getScansNeedingPolling();
      if (pollingQueue.length > 0) {
        const result = await VisionApiService.getBatchVisionResults(pollingQueue.map((s) => s.apparelId));
        if (result.ok && result.response) {
          this.isServerReachable = true;
          for (const itemRes of result.response.results ?? []) {
            if (!itemRes.apparel_id) continue;
            const scan = await ScanDao.getScanById(itemRes.apparel_id);
            if (scan) await this.handleAsyncResponse(scan, itemRes);
          }
        } else {
          console.warn('Batch poll sync failure:', result.error);
        }
      }
    } catch (err) {
      console.warn('Sync loop error:', err);
    } finally {
      this.isProcessing = false;
      this.notify();
    }
  }

  async triggerManualSync() {
    await this.runSyncLoop();
  }

  async submitScan(scan: ScanEntity, clonedFrom?: string) {
    const result = await VisionApiService.submitVisionExtract(scan, clonedFrom);

    if (result.ok && result.response) {
      this.isServerReachable = true;
      await this.handleAsyncResponse(scan, result.response);
    } else {
      // Per the storage invariant (contract section 2) only a 2xx means the server
      // holds the scan, so anything else leaves the photos in place to resend.
      const errorMessage = result.error || 'Upload transport failure';
      console.warn(`Scan ${scan.apparelId} submit failed:`, errorMessage);
      this.isServerReachable = false;

      await ScanDao.updateScan({
        ...scan,
        status: 3,
        serverStored: false,
        errorMessage,
        lastAttemptTime: Date.now(),
        retryCount: scan.retryCount + 1
      });
    }
    this.notify();
  }

  /**
   * Folds one envelope into the local record.
   *
   * Written to tolerate a server older than the contract: `data` may carry 12 fields
   * instead of 13, and `data_hy` / `suggested_key_photo_index` may be absent entirely.
   * dev.outfit.am is on v1.2 today, so that is the live path, not a corner case. A
   * missing field becomes an empty string with zero confidence - exactly what the
   * contract says an unreadable field looks like - and the operator fills it in.
   */
  private async handleAsyncResponse(scan: ScanEntity, response: AsyncVisionResponse) {
    const data = response.data;

    if (response.processing_status === 'READY_TO_CONFIRM' || (response.status === 'success' && data)) {
      const confidences: ScanEntity['confidences'] = {};
      for (const key of AI_FIELDS) {
        confidences[key] = data?.[key]?.confidence ?? 0;
      }

      const value = (key: (typeof AI_FIELDS)[number]) => data?.[key]?.value ?? '';

      await ScanDao.updateScan({
        ...scan,
        status: 1,
        serverStored: true,
        processingStatus: 'READY_TO_CONFIRM',
        suggestedKeyPhotoIndex: response.suggested_key_photo_index ?? null,
        extracted: {
          brandName: value('brand_name'),
          countryOfOrigin: value('country_of_origin'),
          size: value('size'),
          color: value('color'),
          material: value('material'),
          originalPrice: value('original_price'),
          netto: value('netto'),
          brutto: value('brutto'),
          category: value('category'),
          subCategory: value('sub_category'),
          gender: value('gender'),
          season: value('season'),
          careInfo: value('care_info')
        },
        armenian: response.data_hy ?? {},
        confidences,
        errorMessage: undefined
      });
    } else if (response.processing_status === 'NEEDS_ATTENTION') {
      const reason = response.attention_reason || 'Extraction requires operator manual input';
      await ScanDao.updateScan({
        ...scan,
        status: 3,
        serverStored: true,
        processingStatus: 'NEEDS_ATTENTION',
        attentionReason: reason,
        errorMessage: reason
      });
    } else {
      await ScanDao.updateScan({
        ...scan,
        status: 0,
        serverStored: true,
        processingStatus: 'PENDING_AI',
        queueDepth: response.queue_depth ?? 0,
        estimatedWaitSeconds: response.estimated_wait_seconds ?? undefined,
        // Honour retry_after_seconds, clamped to the contract's 5-120s window.
        retryAfterSeconds: Math.max(5, Math.min(120, response.retry_after_seconds || 5)),
        blockingFault: response.blocking_fault ?? undefined,
        errorMessage: undefined
      });
    }
  }

  /**
   * Refreshes the vocabulary. Called at login; a failure is not an operator-facing
   * error, because a stale vocabulary is explicitly not an error (contract 4.6).
   */
  async refreshVocabulary() {
    return vocabulary.refreshFromServer();
  }

  async generateAndDownloadCsv(): Promise<ExportOutcome> {
    const outcome = await exportLedgerCsv();
    this.notify();
    return outcome;
  }
}

export const syncEngine = new SyncEngine();
