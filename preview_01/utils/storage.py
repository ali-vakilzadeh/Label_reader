import json

import flet as ft

SETTINGS_KEY = "label_ledger.settings"
RECORDS_KEY = "label_ledger.records"


async def load_json(page: ft.Page, key: str, default: object) -> object:
    raw = await page.shared_preferences.get(key)
    if not raw:
        return default
    try:
        return json.loads(str(raw))
    except json.JSONDecodeError:
        return default


async def save_json(page: ft.Page, key: str, value: object) -> None:
    await page.shared_preferences.set(key, json.dumps(value))
