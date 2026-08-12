import asyncio

import flet as ft

from models.record import InventoryRecord
from screens.camera_screen import CameraScreen
from screens.history_screen import HistoryScreen
from screens.review_screen import ReviewScreen
from screens.settings_screen import SettingsScreen
from services.gemini_service import extract_label
from services.sheets_service import append_record
from utils.storage import RECORDS_KEY, SETTINGS_KEY, load_json, save_json


class WarehouseApp:
    def __init__(self, page: ft.Page):
        self.page = page
        self.picker = ft.FilePicker()
        self.settings: dict[str, str] = {}
        self.records: list[dict[str, str]] = []
        self.captured_images: list[bytes] = []
        self.extraction: dict[str, object] = {}
        self.loading = False
        self.notice = ""
        self.camera_screen = CameraScreen(self)

    async def start(self) -> None:
        self.page.theme = ft.Theme(
            color_scheme=ft.ColorScheme(
                primary=ft.Colors.YELLOW_700,
                on_primary=ft.Colors.BLACK,
                surface=ft.Colors.WHITE,
                on_surface=ft.Colors.BLACK,
            ),
            scaffold_bgcolor=ft.Colors.WHITE,
        )
        loaded_settings = await load_json(self.page, SETTINGS_KEY, {})
        loaded_records = await load_json(self.page, RECORDS_KEY, [])
        self.settings = loaded_settings if isinstance(loaded_settings, dict) else {}
        self.records = loaded_records if isinstance(loaded_records, list) else []
        self.page.on_route_change = self.route_change
        self.route_change(None)

    def app_bar(self) -> ft.AppBar:
        return ft.AppBar(
            title="Label Ledger",
            bgcolor=ft.Colors.BLACK,
            color=ft.Colors.WHITE,
            actions=[
                ft.IconButton(icon=ft.Icons.PHOTO_CAMERA, on_click=lambda _event: self.navigate("/")),
                ft.IconButton(icon=ft.Icons.HISTORY, on_click=lambda _event: self.navigate("/history")),
                ft.IconButton(icon=ft.Icons.SETTINGS, on_click=lambda _event: self.navigate("/settings")),
            ],
        )

    def route_change(self, _event) -> None:
        route = self.page.route or "/"
        if route == "/settings":
            body = SettingsScreen(self).view()
        elif route == "/history":
            body = HistoryScreen(self).view()
        elif route == "/review" and (self.captured_images or self.loading):
            body = ReviewScreen(self).view()
        else:
            route = "/"
            body = self.camera_screen.view()
        self.page.views.clear()
        self.page.views.append(
            ft.View(
                route=route,
                appbar=self.app_bar(),
                controls=[body],
                services=[self.picker],
                bgcolor=ft.Colors.WHITE,
            )
        )
        self.page.update()
        if route == "/" and not self.loading:
            asyncio.create_task(self.camera_screen.start())

    def navigate(self, route: str) -> None:
        self.page.navigate(route)

    def add_photo(self, image: bytes) -> bool:
        if len(self.captured_images) >= 4:
            return False
        self.captured_images.append(image)
        self.extraction = {}
        return True

    def remove_photo(self, index: int) -> None:
        if 0 <= index < len(self.captured_images):
            self.captured_images.pop(index)
            self.extraction = {}

    def retake_photos(self) -> None:
        self.captured_images.clear()
        self.extraction = {}

    async def process_images(self) -> None:
        if not self.captured_images:
            self.notice = "Capture at least one photo before reviewing the label."
            return
        if not self.settings.get("api_key", "").strip():
            self.notice = "Add your Gemini API key in Settings before scanning."
            self.navigate("/settings")
            return
        self.extraction = {}
        self.loading = True
        self.navigate("/review")
        try:
            self.extraction = await extract_label(self.settings["api_key"], self.captured_images)
        except Exception as exc:
            self.notice = str(exc)
            self.navigate("/")
        finally:
            self.loading = False
        if self.captured_images and self.extraction:
            self.navigate("/review")

    async def save_record(self, record: InventoryRecord) -> None:
        saved = record.to_dict()
        self.records.append(saved)
        await self.persist_records()
        try:
            if self.settings.get("spreadsheet_id") and self.settings.get("service_account_json"):
                await append_record(self.settings, saved)
                self.notice = "Record saved on this device and added to Google Sheets."
            else:
                self.notice = "Record saved on this device. Configure Sheets in Settings to sync it."
        except Exception as exc:
            self.notice = f"Saved on this device, but Google Sheets failed: {exc}"
        self.retake_photos()
        self.navigate("/history")

    async def persist_settings(self) -> None:
        await save_json(self.page, SETTINGS_KEY, self.settings)

    async def persist_records(self) -> None:
        await save_json(self.page, RECORDS_KEY, self.records)


async def main(page: ft.Page):
    app = WarehouseApp(page)
    await app.start()


ft.run(main)
