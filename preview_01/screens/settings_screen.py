import json

import flet as ft


class SettingsScreen:
    def __init__(self, app):
        self.app = app
        settings = app.settings
        self.api_key = ft.TextField(value=settings.get("api_key", ""), password=True, can_reveal_password=True)
        self.spreadsheet_id = ft.TextField(value=settings.get("spreadsheet_id", ""))
        self.worksheet = ft.TextField(value=settings.get("worksheet_name", "Inventory"))
        self.service_json = ft.TextField(value=settings.get("service_account_json", ""), multiline=True, min_lines=4, max_lines=8)
        self.status = ft.Text(app.notice)

    def view(self) -> ft.Control:
        return ft.ListView(
            controls=[
                ft.Text("Settings", size=22, weight=ft.FontWeight.BOLD),
                ft.Text("Gemini API key"), self.api_key,
                ft.Text("Google Sheets spreadsheet ID"), self.spreadsheet_id,
                ft.Text("Worksheet name"), self.worksheet,
                ft.Text("Service-account JSON (stored securely in app settings for this MVP)"), self.service_json,
                ft.Button(content="Choose service-account JSON", icon=ft.Icons.UPLOAD_FILE, on_click=self.pick_json),
                ft.Button(content="Save settings", icon=ft.Icons.SAVE, bgcolor=ft.Colors.YELLOW_700, color=ft.Colors.BLACK, on_click=self.save),
                self.status,
            ],
            spacing=10,
        )

    async def pick_json(self, _event) -> None:
        files = await self.app.picker.pick_files(
            file_type=ft.FilePickerFileType.CUSTOM,
            allowed_extensions=["json"],
            with_data=True,
        )
        if not files or not files[0].bytes:
            return
        try:
            self.service_json.value = files[0].bytes.decode("utf-8")
            json.loads(self.service_json.value)
            self.status.value = "Service-account JSON loaded from device storage."
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.status.value = "That file is not valid service-account JSON."
        self.app.page.update()

    async def save(self, _event) -> None:
        self.app.settings = {
            "api_key": self.api_key.value.strip(),
            "spreadsheet_id": self.spreadsheet_id.value.strip(),
            "worksheet_name": self.worksheet.value.strip() or "Inventory",
            "service_account_json": self.service_json.value.strip(),
        }
        await self.app.persist_settings()
        self.status.value = "Settings saved on this device."
        self.app.page.update()
