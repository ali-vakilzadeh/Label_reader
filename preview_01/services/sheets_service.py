import asyncio
import json

import flet as ft  # Keeps this app service colocated with Flet integration.
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

from models.record import FIELDS

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


async def append_record(settings: dict[str, str], record: dict[str, str]) -> None:
    spreadsheet_id = settings.get("spreadsheet_id", "").strip()
    service_account_json = settings.get("service_account_json", "").strip()
    worksheet = settings.get("worksheet_name", "Inventory").strip() or "Inventory"
    if not spreadsheet_id or not service_account_json:
        raise ValueError("Add a Spreadsheet ID and service-account JSON in Settings.")

    def write_row() -> None:
        info = json.loads(service_account_json)
        credentials = Credentials.from_service_account_info(info, scopes=SCOPES)
        service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        values = [[record.get(field, "") for field in FIELDS] + [record.get("timestamp", "")]]
        service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=f"{worksheet}!A:I",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": values},
        ).execute()

    await asyncio.to_thread(write_row)
