from dataclasses import asdict, dataclass
from datetime import datetime, timezone

FIELDS = [
    "garment_type",
    "brand",
    "country_of_origin",
    "material",
    "color",
    "size",
    "care_instructions",
    "notes",
]

FIELD_SCHEMA = {
    "type": "object",
    "properties": {
        "value": {"type": ["string", "null"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["value", "confidence"],
}

JSON_SCHEMA = {
    "type": "object",
    "properties": {
        **{field: FIELD_SCHEMA for field in FIELDS},
        "needs_review": {"type": "boolean"},
    },
    "required": FIELDS + ["needs_review"],
}

PROMPT = """You extract clothing inventory data from the supplied label photo.
Read only visible text. Never infer or guess missing values. Return JSON that
matches the exact schema. For every field, return an object with a value and a
confidence from 0 to 1. Estimate confidence based on how legible and explicit
the evidence is in the photo: use low confidence for blurry, partial, ambiguous,
or uncertain text; use null for values that are not visible or readable. Set
needs_review to true if any field confidence is below 0.8; otherwise false.
Fields: garment_type, brand, country_of_origin, material, color, size,
care_instructions, notes."""


def extraction_value(values: dict[str, object], field: str) -> str:
    item = values.get(field)
    if isinstance(item, dict):
        item = item.get("value")
    return str(item or "")


def extraction_confidence(values: dict[str, object], field: str) -> float:
    item = values.get(field)
    confidence = item.get("confidence") if isinstance(item, dict) else 0
    try:
        return min(1.0, max(0.0, float(confidence)))
    except (TypeError, ValueError):
        return 0.0


@dataclass
class InventoryRecord:
    garment_type: str = ""
    brand: str = ""
    country_of_origin: str = ""
    material: str = ""
    color: str = ""
    size: str = ""
    care_instructions: str = ""
    notes: str = ""
    timestamp: str = ""
    image_path: str = ""

    @classmethod
    def from_extraction(cls, values: dict[str, object]) -> "InventoryRecord":
        cleaned = {field: extraction_value(values, field) for field in FIELDS}
        return cls(
            **cleaned,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    @classmethod
    def from_dict(cls, values: dict[str, object]) -> "InventoryRecord":
        return cls(**{key: str(values.get(key) or "") for key in cls.__annotations__})

    def to_dict(self) -> dict[str, str]:
        return asdict(self)
