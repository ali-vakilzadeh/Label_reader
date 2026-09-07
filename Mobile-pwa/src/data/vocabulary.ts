/**
 * The live vocabulary the pickers read from.
 *
 * This used to be 1,472 lines of hardcoded English arrays. api_contract.md section 4.6
 * forbids that outright - the tables grow, a supervisor can add a row mid-shift, and a
 * shipped copy silently goes stale. It is now a three-tier store (see referenceTables.ts):
 * server, then IndexedDB cache, then the CSVs compiled in from the client's own files.
 *
 * Everything here is keyed on the English value. Armenian is only ever a label.
 */
import { useEffect, useState } from 'react';
import { ReferenceDao } from './db';
import {
  getBundledTables,
  mergeServerTables,
  searchTable,
  toArmenian,
  type RefTable,
  type ReferenceSnapshot,
  type TableName
} from './referenceTables';
import { VisionApiService } from '../services/visionApiService';

type Listener = (snapshot: ReferenceSnapshot) => void;

class VocabularyStore {
  /** Starts on the bundle so the very first render already has all 1,479 entries. */
  private snapshot: ReferenceSnapshot = getBundledTables();
  private listeners = new Set<Listener>();
  private hydrated = false;
  private inFlight: Promise<ReferenceSnapshot> | null = null;

  get current(): ReferenceSnapshot {
    return this.snapshot;
  }

  table(name: TableName): RefTable {
    return this.snapshot.tables[name];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(snapshot: ReferenceSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((l) => {
      try {
        l(snapshot);
      } catch (err) {
        console.error('Vocabulary listener error:', err);
      }
    });
  }

  /** Promotes the cached copy over the bundle. Called once at startup. */
  async hydrateFromCache(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const row = await ReferenceDao.load();
      if (row && row.origin === 'server') {
        this.set({
          version: row.version,
          generatedAt: row.generatedAt,
          origin: row.origin,
          tables: row.tables
        });
      }
    } catch (err) {
      console.warn('Reference cache unreadable, staying on the bundled tables:', err);
    }
  }

  /**
   * Asks the server for a newer vocabulary. `If-None-Match` makes the usual answer a
   * bodyless 304, so this is cheap enough to call at every login.
   *
   * A failure here is never an error the operator has to act on: contract section 4.6
   * rule 3 says a stale vocabulary is not an error, and dev.outfit.am is on v1.2 and
   * has no such endpoint at all, so 404 is the expected answer today.
   */
  async refreshFromServer(): Promise<{ status: 'updated' | 'unchanged' | 'unavailable'; version: string; message?: string }> {
    if (this.inFlight) {
      await this.inFlight;
      return { status: 'unchanged', version: this.snapshot.version };
    }

    const cachedVersion = this.snapshot.origin === 'server' ? this.snapshot.version : undefined;
    const result = await VisionApiService.fetchReferenceTables(cachedVersion);

    if (result.notModified) {
      return { status: 'unchanged', version: this.snapshot.version };
    }

    if (!result.ok || !result.payload) {
      return {
        status: 'unavailable',
        version: this.snapshot.version,
        message: result.error || 'Server did not serve reference tables.'
      };
    }

    const merged = mergeServerTables(result.payload);
    this.set(merged);
    try {
      await ReferenceDao.save(merged);
    } catch (err) {
      console.warn('Could not cache reference tables:', err);
    }
    return { status: 'updated', version: merged.version };
  }

  /** Reverts to the compiled-in tables, e.g. after a storage purge. */
  async resetToBundle(): Promise<void> {
    await ReferenceDao.clear();
    this.set(getBundledTables());
  }
}

export const vocabulary = new VocabularyStore();

/** Re-renders a component whenever the vocabulary is replaced. */
export function useVocabulary(): ReferenceSnapshot {
  const [snapshot, setSnapshot] = useState(vocabulary.current);
  useEffect(() => vocabulary.subscribe(setSnapshot), []);
  return snapshot;
}

/** The English keys of one table, for a picker that is still English-only. */
export function optionsFor(name: TableName): string[] {
  return vocabulary.table(name).entries.map((e) => e.en);
}

/** Armenian label for an English key, falling back to the key itself. */
export function labelFor(name: TableName, en: string): string {
  return toArmenian(vocabulary.table(name), en);
}

export function suggestionsFor(name: TableName, query: string, limit = 8) {
  return searchTable(vocabulary.table(name), query, limit);
}

/**
 * Type-ahead over a plain string list. Kept for the components that still hold their
 * own arrays; they move onto the bilingual pickers in a later step.
 */
export function searchVocabulary(list: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);

  const prefix: string[] = [];
  const contains: string[] = [];

  for (const item of list) {
    const lower = item.toLowerCase();
    if (lower.startsWith(q)) {
      prefix.push(item);
      if (prefix.length >= limit) break;
    } else if (lower.includes(q) && contains.length < limit) {
      contains.push(item);
    }
  }

  return [...prefix, ...contains].slice(0, limit);
}
