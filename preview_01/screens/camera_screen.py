import flet as ft
from flet_camera import Camera, CameraLensDirection


class CameraScreen:
    def __init__(self, app):
        self.app = app
        self.camera = Camera()
        self.status = ft.Text(app.notice or "Starting rear camera…")
        self.photo_hint = ft.Text()
        self.photo_strip = ft.Row(controls=[])

    def view(self) -> ft.Control:
        if self.app.notice:self.status.value = self.app.notice; self.app.notice = ""
        self.refresh_photo_strip()
        return ft.Column(
            controls=[
                ft.Text("Photograph the label", size=22, weight=ft.FontWeight.BOLD),
                ft.Text("Capture up to four photos: labels, care tags, or an overview."),
                self.camera,
                ft.Button(
                    content="Capture photo",
                    icon=ft.Icons.PHOTO_CAMERA,
                    bgcolor=ft.Colors.YELLOW_700,
                    color=ft.Colors.BLACK,
                    on_click=self.capture,
                ),
                ft.Button(
                    content="Choose a photo from gallery",
                    icon=ft.Icons.UPLOAD_FILE,
                    on_click=self.choose_photo,
                ),
                self.photo_hint,
                self.photo_strip,
                ft.Button(
                    content="Continue to review",
                    icon=ft.Icons.ARROW_FORWARD,
                    bgcolor=ft.Colors.YELLOW_700,
                    color=ft.Colors.BLACK,
                    on_click=self.continue_to_review,
                ),
                self.status,
            ],
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def refresh_photo_strip(self) -> None:
        count = len(self.app.captured_images)
        self.photo_hint.value = f"{count}/4 photos captured. Remove any photo before reviewing."
        self.photo_strip.controls = [
            ft.Column(
                controls=[
                    ft.Image(src=image, fit=ft.BoxFit.CONTAIN, width=72, height=72),
                    ft.IconButton(
                        icon=ft.Icons.REMOVE_CIRCLE,
                        on_click=self.remove_handler(index),
                    ),
                ]
            )
            for index, image in enumerate(self.app.captured_images)
        ]

    def remove_handler(self, index: int):
        async def handler(_event) -> None:
            self.app.remove_photo(index)
            self.refresh_photo_strip()
            self.status.value = "Photo removed."
            self.app.page.update()

        return handler

    async def start(self) -> None:
        try:
            cameras = await self.camera.get_available_cameras()
            rear = next((item for item in cameras if item.lens_direction == CameraLensDirection.BACK), None)
            if rear is None and cameras:
                rear = cameras[0]
            if rear is None:
                self.status.value = "No camera found. You may choose a photo from the gallery."
            else:
                await self.camera.initialize(rear)
                self.status.value = "Rear camera ready."
        except Exception as exc:
            self.status.value = f"Camera unavailable: {exc}. Choose a photo instead."
        self.app.page.update()

    async def capture(self, _event) -> None:
        try:
            image = await self.camera.take_picture()
            self.add_captured_photo(image)
        except Exception as exc:
            self.status.value = f"Could not capture photo: {exc}"
            self.app.page.update()

    async def choose_photo(self, _event) -> None:
        files = await self.app.picker.pick_files(file_type=ft.FilePickerFileType.IMAGE, with_data=True)
        if files and files[0].bytes:
            self.add_captured_photo(files[0].bytes)
        elif files:
            self.status.value = "The selected image could not be read. Please try another photo."
            self.app.page.update()

    def add_captured_photo(self, image: bytes) -> None:
        if not self.app.add_photo(image):
            self.status.value = "You can capture a maximum of four photos per garment."
        else:
            self.refresh_photo_strip()
            self.status.value = "Photo added. Add another photo or continue to review."
        self.app.page.update()

    async def continue_to_review(self, _event) -> None:
        if not self.app.captured_images:
            self.status.value = "Capture at least one photo before reviewing the label."
            self.app.page.update()
            return
        await self.app.process_images()
