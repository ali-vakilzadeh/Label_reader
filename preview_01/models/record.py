from dataclasses import asdict, dataclass
from datetime import datetime, timezone

FIELDS = [
    "brand",
    "size",
    "gender",
    "material",
    "country_of_origin",
    "sku",
    "care_instructions",
]

JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": ["string", "null"]},
        "size": {"type": ["string", "null"]},
        "gender": {"type": ["string", "null"], "enum": ["Men", "Women", "Unisex", "Kids", None]},
        "material": {"type": ["string", "null"]},
        "country_of_origin": {"type": ["string", "null"]},
        "sku": {"type": ["string", "null"]},
        "care_instructions": {"type": ["string", "null"]},
    },
    "required": FIELDS,
}

PROMPT = """You extract clothing inventory data from the supplied label photo.
Read only visible text. Never infer missing values. Return JSON with the exact
schema. gender must be Men, Women, Unisex, Kids, or null. Fields: brand, size,
gender, material, country_of_origin, sku, care_instructions."""


@dataclass
class InventoryRecord:
    brand: str = ""
    size: str = ""
    gender: str = ""
    material: str = ""
    country_of_origin: str = ""
    sku: str = ""
    care_instructions: str = ""
    timestamp: str = ""
    image_path: str = ""

    @classmethod
    def from_extraction(cls, values: dict[str, object]) -> "InventoryRecord":
        cleaned = {field: str(values.get(field) or "") for field in FIELDS}
        return cls(
            **cleaned,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    @classmethod
    def from_dict(cls, values: dict[str, object]) -> "InventoryRecord":
        return cls(**{key: str(values.get(key) or "") for key in cls.__annotations__})

    def to_dict(self) -> dict[str, str]:
        return asdict(self)
