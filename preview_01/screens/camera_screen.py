import flet as ft
from flet_camera import Camera, CameraLensDirection


class CameraScreen:
    def __init__(self, app):
        self.app = app
        self.camera = Camera()
        self.status = ft.Text(app.notice or "Starting rear camera…")

    def view(self) -> ft.Control:
        return ft.Column(
            controls=[
                ft.Text("Photograph the label", size=22, weight=ft.FontWeight.BOLD),
                ft.Text("Keep the label flat and readable inside the preview."),
                self.camera,
                ft.Button(
                    content="Capture label",
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
                self.status,
            ],
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

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
            await self.app.process_image(image)
        except Exception as exc:
            self.status.value = f"Could not capture photo: {exc}"
            self.app.page.update()

    async def choose_photo(self, _event) -> None:
        files = await self.app.picker.pick_files(file_type=ft.FilePickerFileType.IMAGE, with_data=True)
        if files and files[0].bytes:
            await self.app.process_image(files[0].bytes)
        elif files:
            self.status.value = "The selected image could not be read. Please try another photo."
            self.app.page.update()
