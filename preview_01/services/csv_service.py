import csv
import io

import flet as ft  # Keeps this app service colocated with Flet integration.
from models.record import FIELDS


def records_as_csv(records: list[dict[str, str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=FIELDS + ["timestamp"], extrasaction="ignore")
    writer.writeheader()
    writer.writerows(records)
    return buffer.getvalue().encode("utf-8")
