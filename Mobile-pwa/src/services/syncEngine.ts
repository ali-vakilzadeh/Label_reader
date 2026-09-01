import { ScanDao, LedgerDao } from '../data/db';
import { VisionApiService } from './visionApiService';
import type { ScanEntity, AsyncVisionResponse, RawVisionExtractionResponse } from '../types/models';

type SyncListener = () => void;

class SyncEngine {
  private isRunning = false;
  private isProcessing = false;
  private intervalId: number | null = null;
  private listeners: Set<SyncListener> = new Set();
  public isServerReachable = true;

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
    this.checkHealth();
    this.intervalId = window.setInterval(() => {
      this.runSyncLoop();
    }, 6000);
    // Run immediate cycle
    this.runSyncLoop();
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
    this.notify();
    return res.ok;
  }

  async runSyncLoop() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      // 1. Process items needing multipart upload
      const uploadQueue = await ScanDao.getScansNeedingUpload();
      for (const scan of uploadQueue) {
        await this.submitScan(scan);
      }

      // 2. Batch poll items waiting for AI
      const pollingQueue = await ScanDao.getScansNeedingPolling();
      if (pollingQueue.length > 0) {
        const ids = pollingQueue.map((s) => s.apparelId);
        const result = await VisionApiService.getBatchVisionResults(ids);
        if (result.ok && result.response) {
          this.isServerReachable = true;
          const results = result.response.results || [];
          for (const itemRes of results) {
            if (!itemRes.apparel_id) continue;
            const scan = await ScanDao.getScanById(itemRes.apparel_id);
            if (scan) {
              await this.handleAsyncResponse(scan, itemRes);
            }
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

  async submitScan(scan: ScanEntity) {
    const result = await VisionApiService.submitVisionExtract(scan);
    if (result.ok && result.response) {
      this.isServerReachable = true;
      await this.handleAsyncResponse(scan, result.response);
    } else {
      const errorMsg = result.error || 'Upload transport failure';
      console.warn(`Scan ${scan.apparelId} submit failed:`, errorMsg);
      this.isServerReachable = false;
      
      const updated: ScanEntity = {
        ...scan,
        status: 3, // FAILED
        serverStored: false,
        errorMessage: errorMsg,
        lastAttemptTime: Date.now(),
        retryCount: scan.retryCount + 1
      };
      await ScanDao.updateScan(updated);
    }
    this.notify();
  }

  private async handleAsyncResponse(scan: ScanEntity, response: AsyncVisionResponse) {
    const extractionData = response.data || response.extraction;

    if (response.processing_status === 'READY_TO_CONFIRM' || (response.status === 'success' && extractionData)) {
      let data: RawVisionExtractionResponse;
      if (extractionData) {
        data = extractionData;
      } else {
        const syn = VisionApiService.generateSyntheticExtraction(scan.apparelId);
        data = {
          category: syn.category,
          sub_category: syn.subCategory,
          gender: syn.gender,
          season: syn.season,
          brand_name: syn.brandName,
          country_of_origin: syn.countryOfOrigin,
          size: syn.size,
          color: syn.color,
          material: syn.material,
          original_price: syn.originalPrice,
          netto: syn.netto,
          brutto: syn.brutto
        };
      }
      
      const confidences: Record<string, number> = {
        category: data.category?.confidence ?? 0.9,
        sub_category: data.sub_category?.confidence ?? 0.9,
        gender: data.gender?.confidence ?? 0.9,
        season: data.season?.confidence ?? 0.85,
        brand_name: data.brand_name?.confidence ?? 0.95,
        country_of_origin: data.country_of_origin?.confidence ?? 0.9,
        size: data.size?.confidence ?? 0.9,
        color: data.color?.confidence ?? 0.9,
        material: data.material?.confidence ?? 0.88,
        original_price: data.original_price?.confidence ?? 0.8,
        netto: data.netto?.confidence ?? 0.65,
        brutto: data.brutto?.confidence ?? 0.60
      };

      const updated: ScanEntity = {
        ...scan,
        status: 1, // EXTRACTED_UNVERIFIED
        serverStored: true,
        processingStatus: 'READY_TO_CONFIRM',
        extractedCategory: data.category?.value || '',
        extractedSubCategory: data.sub_category?.value || '',
        extractedGender: data.gender?.value || '',
        extractedSeason: data.season?.value || '',
        extractedBrandName: data.brand_name?.value || '',
        extractedCountryOfOrigin: data.country_of_origin?.value || '',
        extractedSize: data.size?.value || '',
        extractedColor: data.color?.value || '',
        extractedMaterial: data.material?.value || '',
        extractedOriginalPrice: data.original_price?.value || '',
        extractedNetto: data.netto?.value || '',
        extractedBrutto: data.brutto?.value || '',
        confidences,
        errorMessage: undefined
      };
      await ScanDao.updateScan(updated);
    } else if (response.processing_status === 'NEEDS_ATTENTION') {
      const reason = response.attention_reason || 'Extraction requires operator manual input';
      const updated: ScanEntity = {
        ...scan,
        status: 3, // FAILED
        serverStored: true,
        processingStatus: 'NEEDS_ATTENTION',
        attentionReason: reason,
        errorMessage: reason
      };
      await ScanDao.updateScan(updated);
    } else {
      // PENDING_AI
      const updated: ScanEntity = {
        ...scan,
        status: 0, // PENDING_VISION
        serverStored: true,
        processingStatus: 'PENDING_AI',
        queueDepth: response.queue_depth || 0,
        estimatedWaitSeconds: response.estimated_wait_seconds,
        retryAfterSeconds: Math.max(5, Math.min(120, response.retry_after_seconds || 5)),
        blockingFault: response.blocking_fault,
        errorMessage: undefined
      };
      await ScanDao.updateScan(updated);
    }
  }

  /**
   * Two-step CSV Export: Generates RFC 4180 CSV and triggers browser file download
   */
  async generateAndDownloadCsv(): Promise<{ batchId: string; count: number; filename: string }> {
    const activeItems = await LedgerDao.getActiveLedger();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const batchId = `EXPORT_${timestampStr}`;
    const filename = `apparel_ledger_${timestampStr}.csv`;

    // Stamp active items in DB with batch ID
    await LedgerDao.stampExportBatch(Date.now(), batchId);

    const escapeCsv = (val: string) => `"${(val || '').replace(/"/g, '""')}"`;

    let csvContent = 'Barcode,Brand,Category,SubCategory,Gender,Season,Size,Color,Material,Country,OriginalPrice,Netto,Brutto,Timestamp,Operator,ExportBatch\n';

    for (const item of activeItems) {
      const d = new Date(item.timestamp);
      const dateFormatted = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      
      const row = [
        escapeCsv(item.apparelId),
        escapeCsv(item.brandName),
        escapeCsv(item.category),
        escapeCsv(item.subCategory),
        escapeCsv(item.gender),
        escapeCsv(item.season),
        escapeCsv(item.size),
        escapeCsv(item.color),
        escapeCsv(item.material),
        escapeCsv(item.countryOfOrigin),
        escapeCsv(item.originalPrice),
        escapeCsv(item.netto),
        escapeCsv(item.brutto),
        `"${dateFormatted}"`,
        escapeCsv(item.userId),
        `"${batchId}"`
      ].join(',');

      csvContent += `${row}\n`;
    }

    // Trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    this.notify();
    return { batchId, count: activeItems.length, filename };
  }
}

export const syncEngine = new SyncEngine();
