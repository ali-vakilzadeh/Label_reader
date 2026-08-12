import flet as ft

from services.csv_service import records_as_csv


class HistoryScreen:
    def __init__(self, app):
        self.app = app
        self.status = ft.Text(app.notice)

    def view(self) -> ft.Control:
        controls: list[ft.Control] = [
            ft.Text("Saved records", size=22, weight=ft.FontWeight.BOLD),
            ft.Button(content="Save CSV", icon=ft.Icons.FILE_DOWNLOAD, bgcolor=ft.Colors.YELLOW_700, color=ft.Colors.BLACK, on_click=self.export_csv),
            ft.Button(content="Clear all records", icon=ft.Icons.DELETE, on_click=self.clear_all),
            self.status,
        ]
        if not self.app.records:
            controls.append(ft.Text("No records saved yet."))
        for index, record in enumerate(reversed(self.app.records)):
            original_index = len(self.app.records) - index - 1
            controls.append(
                ft.ListTile(
                    title=ft.Text(f"{record.get('brand') or 'Unbranded'} · {record.get('size') or 'Size missing'}"),
                    subtitle=ft.Text(record.get("timestamp", "")),
                    trailing=ft.IconButton(icon=ft.Icons.DELETE, on_click=self.delete_handler(original_index)),
                )
            )
        return ft.ListView(controls=controls, spacing=10)

    def delete_handler(self, index: int):
        async def handler(_event) -> None:
            await self.delete(index)

        return handler

    async def delete(self, index: int) -> None:
        self.app.records.pop(index)
        await self.app.persist_records()
        self.app.navigate("/history")

    async def clear_all(self, _event) -> None:
        self.app.records.clear()
        await self.app.persist_records()
        self.app.navigate("/history")

    async def export_csv(self, _event) -> None:
        if not self.app.records:
            self.status.value = "There are no records to export."
            self.app.page.update()
            return
        result = await self.app.picker.save_file(
            file_name="label-ledger-records.csv",
            file_type=ft.FilePickerFileType.CUSTOM,
            allowed_extensions=["csv"],
            src_bytes=records_as_csv(self.app.records),
        )
        self.status.value = "CSV saved." if result else "CSV save cancelled."
        self.app.page.update()
