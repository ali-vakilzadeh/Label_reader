import flet as ft

from models.record import FIELDS, InventoryRecord


class ReviewScreen:
    def __init__(self, app):
        self.app = app
        self.fields: dict[str, ft.TextField] = {}

    def view(self) -> ft.Control:
        if self.app.loading:
            controls: list[ft.Control] = [
                ft.Text("Photo captured", size=22, weight=ft.FontWeight.BOLD)
            ]
            if self.app.captured_image:
                controls.append(
                    ft.Image(src=self.app.captured_image, fit=ft.BoxFit.CONTAIN, height=220)
                )
            controls.extend(
                [
                    ft.ProgressRing(color=ft.Colors.YELLOW_700),
                    ft.Text("Reading the label with Gemini…"),
                ]
            )
            return ft.Column(
                controls=controls,
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            )
        record = InventoryRecord.from_extraction(self.app.extraction)
        self.fields = {
            field: ft.TextField(value=getattr(record, field), multiline=field == "care_instructions")
            for field in FIELDS
        }
        controls: list[ft.Control] = [
            ft.Text("Review label details", size=22, weight=ft.FontWeight.BOLD),
            ft.Text("Edit anything that is missing or incorrect before saving."),
        ]
        if self.app.captured_image:
            controls.append(ft.Image(src=self.app.captured_image, fit=ft.BoxFit.CONTAIN))
        for field in FIELDS:
            readable = field.replace("_", " ").title()
            controls.append(ft.Text(readable, weight=ft.FontWeight.BOLD))
            controls.append(self.fields[field])
            if not getattr(record, field):
                controls.append(ft.Text("Missing — enter this manually if available.", color=ft.Colors.YELLOW_800))
        controls.extend([
            ft.Button(
                content="Confirm & save",
                icon=ft.Icons.SAVE,
                bgcolor=ft.Colors.YELLOW_700,
                color=ft.Colors.BLACK,
                on_click=self.save,
            ),
            ft.Button(content="Retake photo", icon=ft.Icons.PHOTO_CAMERA, on_click=self.retake),
        ])
        return ft.ListView(controls=controls, spacing=10)

    async def save(self, _event) -> None:
        values = {field: input_field.value.strip() for field, input_field in self.fields.items()}
        await self.app.save_record(InventoryRecord.from_extraction(values))

    async def retake(self, _event) -> None:
        self.app.navigate("/")
