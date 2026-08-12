import flet as ft

from models.record import FIELDS, InventoryRecord, extraction_confidence, extraction_value


class ReviewScreen:
    def __init__(self, app):
        self.app = app
        self.fields: dict[str, ft.TextField] = {}

    def thumbnails(self) -> ft.Row:
        return ft.Row(
            controls=[
                ft.Image(src=image, fit=ft.BoxFit.CONTAIN, width=96, height=96)
                for image in self.app.captured_images
            ]
        )

    def view(self) -> ft.Control:
        if self.app.loading:
            controls: list[ft.Control] = [
                ft.Text("Photos captured", size=22, weight=ft.FontWeight.BOLD)
            ]
            if self.app.captured_images:
                controls.append(self.thumbnails())
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
        controls: list[ft.Control] = [
            ft.Text("Review label details", size=22, weight=ft.FontWeight.BOLD),
            ft.Text("Edit anything that is missing or needs checking before saving."),
        ]
        if self.app.captured_images:
            controls.append(self.thumbnails())

        for field in FIELDS:
            value = extraction_value(self.app.extraction, field)
            confidence = extraction_confidence(self.app.extraction, field)
            needs_check = confidence < 0.8 or not value
            field_input = ft.TextField(
                value=getattr(record, field),
                multiline=field in {"care_instructions", "notes"},
                border_color=ft.Colors.AMBER_700 if needs_check else None,
                focused_border_color=ft.Colors.AMBER_700 if needs_check else None,
            )
            self.fields[field] = field_input
            controls.append(ft.Text(field.replace("_", " ").title(), weight=ft.FontWeight.BOLD))
            controls.append(ft.Text(f"Confidence: {confidence:.0%}"))
            controls.append(field_input)
            if needs_check:
                controls.append(ft.Text("Check this — unclear or missing label data.", color=ft.Colors.AMBER_700))

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
        values = {
            field: (input_field.value or "").strip()
            for field, input_field in self.fields.items()
        }
        await self.app.save_record(InventoryRecord.from_extraction(values))

    async def retake(self, _event) -> None:
        self.app.navigate("/")
