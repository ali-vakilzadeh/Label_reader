import asyncio
import json

import flet as ft  # Keeps this app service colocated with Flet integration.
from google import genai
from google.genai import types

from models.record import JSON_SCHEMA, PROMPT


async def extract_label(api_key: str, image_bytes: bytes) -> dict[str, object]:
    if not api_key.strip():
        raise ValueError("Add a Gemini API key in Settings before scanning.")

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_json_schema=JSON_SCHEMA,
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = await asyncio.to_thread(
                client.models.generate_content,
                model="gemini-2.5-flash",
                contents=[PROMPT, types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
                config=config,
            )
            return json.loads(response.text)
        except Exception as exc:
            last_error = exc
            if "429" not in str(exc) or attempt == 2:
                break
            await asyncio.sleep(2 ** attempt)
    raise RuntimeError(f"Gemini could not read this label: {last_error}")
