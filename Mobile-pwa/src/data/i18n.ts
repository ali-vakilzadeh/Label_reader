/**
 * Armenian for the operator, English for everything written down.
 *
 * Two different things are translated here, and it matters that they stay separate:
 *
 *  - **Values** - a colour, a garment type, a season. These are NOT translated. They
 *    are looked up in the reference tables, which carry the client's own Armenian for
 *    each English key, and the English key is what is stored, exported and sent
 *    (api_contract.md section 8.3, csv_export_format.txt section 4). AI results carry
 *    their Armenian ready-made in `data_hy`.
 *  - **Chrome** - field labels and buttons. These are this dictionary. Nothing here
 *    ever reaches the database or the CSV.
 *
 * The rule that governs both: never translate at runtime, look up or show English.
 * A term with no Armenian renders in English, which is correct, not a defect.
 */
import { useEffect, useState } from 'react';
import { loadSettings, saveSettings } from './settingsStorage';
import type { UiLanguage } from '../types/models';

type Dict = Record<string, string>;

/** Armenian chrome. A key absent here falls back to its English text. */
const HY: Dict = {
  // Navigation
  Review: 'Ստուգում',
  Ledger: 'Մատյան',
  Settings: 'Կարգավորումներ',

  // Field labels
  Brand: 'Ապրանքանիշ',
  Category: 'Կատեգորիա',
  'Sub-Category': 'Ենթակատեգորիա',
  Gender: 'Սեռ',
  Season: 'Եղանակ',
  Size: 'Չափս',
  Colour: 'Գույն',
  'Material composition': 'Կազմ',
  'Country of origin': 'Արտադրող երկիր',
  'Original price': 'Սկզբնական գին',
  'Netto weight': 'Զուտ քաշ',
  'Brutto weight': 'Համախառն քաշ',
  'Care info (QR URL)': 'Խնամքի տեղեկատվություն (QR)',
  'Barcode Number': 'Շտրիխկոդ',
  'Package Number': 'Փաթեթի համար',
  'Set of': 'Հավաքածու',

  // Actions
  Cancel: 'Չեղարկել',
  Confirm: 'Հաստատել',
  'Save draft': 'Պահել սևագիրը',
  'Save changes': 'Պահել փոփոխությունները',
  Delete: 'Ջնջել',
  Clone: 'Կրկնօրինակել',
  'Clone Again': 'Կրկնօրինակել կրկին',
  Edit: 'Խմբագրել',
  Retry: 'Կրկնել',
  Scan: 'Սկանավորել',
  'Export CSV': 'Արտահանել CSV',
  Reset: 'Զրոյացնել',

  // Statuses
  Draft: 'Սևագիր',
  Locked: 'Կողպված',
  Exported: 'Արտահանված',
  Incomplete: 'Թերի',
  Unmatched: 'Չհամապատասխանող',
  'Key photo': 'Հիմնական լուսանկար'
};

const DICTS: Record<UiLanguage, Dict> = { en: {}, hy: HY };

type Listener = (language: UiLanguage) => void;
const listeners = new Set<Listener>();

let current: UiLanguage = 'en';
try {
  current = loadSettings().language;
} catch {
  // localStorage can be unavailable; English is the safe default.
}

export function getLanguage(): UiLanguage {
  return current;
}

export function setLanguage(language: UiLanguage): void {
  current = language;
  saveSettings({ language });
  listeners.forEach((l) => l(language));
}

/**
 * Chrome translation. Falls back to the English key, so an untranslated string shows
 * in English rather than as a blank or a raw identifier.
 */
export function t(key: string): string {
  return DICTS[current][key] ?? key;
}

export function useLanguage(): { language: UiLanguage; t: (key: string) => string } {
  const [language, setLanguageState] = useState(current);
  useEffect(() => {
    listeners.add(setLanguageState);
    return () => {
      listeners.delete(setLanguageState);
    };
  }, []);
  return { language, t: (key: string) => DICTS[language][key] ?? key };
}
