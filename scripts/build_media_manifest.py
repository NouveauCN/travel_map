from __future__ import annotations

import json
import math
import shutil
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any

import piexif
from PIL import Image, ImageOps

SOURCE_DIRECTORY = Path("test_src_with_metadata")
FALLBACK_SOURCE_DIRECTORY = Path("test_src")
PUBLIC_DIRECTORY = Path("public")
DATA_DIRECTORY = PUBLIC_DIRECTORY / "data"
MEDIA_DIRECTORY = PUBLIC_DIRECTORY / "media"
FULL_MEDIA_DIRECTORY = MEDIA_DIRECTORY / "full"
THUMBNAIL_DIRECTORY = MEDIA_DIRECTORY / "thumbnails"
THUMBNAIL_SIZE = (720, 900)
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov"}
CHINA_MIN_LATITUDE = 0.8293
CHINA_MAX_LATITUDE = 55.8271
CHINA_MIN_LONGITUDE = 72.004
CHINA_MAX_LONGITUDE = 137.8347
WGS84_A = 6378245.0
WGS84_EE = 0.006693421622965943
PI = math.pi


def main() -> None:
    source_directory = SOURCE_DIRECTORY if SOURCE_DIRECTORY.exists() else FALLBACK_SOURCE_DIRECTORY
    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    FULL_MEDIA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    THUMBNAIL_DIRECTORY.mkdir(parents=True, exist_ok=True)

    media_items = []
    for source_path in sorted(iter_media_paths(source_directory)):
        media_item = build_media_item(source_path, source_directory)
        media_items.append(media_item)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_directory": str(source_directory),
        "media": media_items,
    }

    output_path = DATA_DIRECTORY / "media_manifest.json"
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {output_path} with {len(media_items)} media item(s)")


def iter_media_paths(source_directory: Path) -> list[Path]:
    if not source_directory.exists():
        raise FileNotFoundError(f"source directory not found: {source_directory}")

    media_paths = []
    for source_path in source_directory.iterdir():
        if source_path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS | SUPPORTED_VIDEO_EXTENSIONS:
            media_paths.append(source_path)
    return media_paths


def build_media_item(source_path: Path, source_directory: Path) -> dict[str, Any]:
    media_type = get_media_type(source_path)
    output_name = normalize_output_name(source_path)
    full_path = FULL_MEDIA_DIRECTORY / output_name
    thumbnail_path = THUMBNAIL_DIRECTORY / f"{source_path.stem}.jpg"
    shutil.copy2(source_path, full_path)

    if media_type == "image":
        image_metadata = build_image_thumbnail_and_metadata(source_path, thumbnail_path)
    else:
        image_metadata = build_video_placeholder_metadata(source_path, thumbnail_path)

    latitude = image_metadata["latitude"]
    longitude = image_metadata["longitude"]
    map_latitude = None
    map_longitude = None
    if latitude is not None and longitude is not None:
        map_latitude, map_longitude = wgs84_to_gcj02(latitude, longitude)

    title, place = infer_title_and_place(source_path, latitude, longitude)
    coordinates = format_coordinates(latitude, longitude)
    map_coordinates = format_coordinates(map_latitude, map_longitude)
    dimensions = format_dimensions(image_metadata["width"], image_metadata["height"])

    brief_metadata = {
        "place": place,
        "captured_at": image_metadata["date_time_original"],
        "coordinates": coordinates,
        "dimensions": dimensions,
    }

    full_metadata = {
        "file": output_name,
        "source_file": str(source_path.relative_to(source_directory)),
        "media_type": media_type,
        "place": place,
        "captured_at": image_metadata["date_time_original"],
        "offset_time_original": image_metadata["offset_time_original"],
        "coordinates": coordinates,
        "map_coordinates": map_coordinates,
        "dimensions": dimensions,
    }

    return {
        "id": source_path.stem,
        "title": title,
        "place": place,
        "media_type": media_type,
        "full_src": f"/media/full/{output_name}",
        "thumbnail_src": f"/media/thumbnails/{thumbnail_path.name}",
        "latitude": latitude,
        "longitude": longitude,
        "map_latitude": map_latitude,
        "map_longitude": map_longitude,
        "date_time_original": image_metadata["date_time_original"],
        "offset_time_original": image_metadata["offset_time_original"],
        "width": image_metadata["width"],
        "height": image_metadata["height"],
        "brief_metadata": brief_metadata,
        "full_metadata": full_metadata,
    }


def get_media_type(source_path: Path) -> str:
    if source_path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
        return "video"
    return "image"


def normalize_output_name(source_path: Path) -> str:
    safe_stem = "".join(character if character.isalnum() else "_" for character in source_path.stem.lower())
    safe_stem = "_".join(part for part in safe_stem.split("_") if part)
    return f"{safe_stem}{source_path.suffix.lower()}"


def build_image_thumbnail_and_metadata(source_path: Path, thumbnail_path: Path) -> dict[str, Any]:
    with Image.open(source_path) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail(THUMBNAIL_SIZE)
        image.convert("RGB").save(thumbnail_path, format="JPEG", quality=82, optimize=True)

    exif_dict = piexif.load(str(source_path))
    latitude, longitude = extract_gps_coordinates(exif_dict.get("GPS", {}))
    exif_ifd = exif_dict.get("Exif", {})
    date_time_original = decode_exif_text(exif_ifd.get(piexif.ExifIFD.DateTimeOriginal))
    offset_time_original = decode_exif_text(exif_ifd.get(piexif.ExifIFD.OffsetTimeOriginal))

    with Image.open(source_path) as image:
      width, height = image.size

    return {
        "latitude": latitude,
        "longitude": longitude,
        "date_time_original": date_time_original,
        "offset_time_original": offset_time_original,
        "width": width,
        "height": height,
    }


def build_video_placeholder_metadata(source_path: Path, thumbnail_path: Path) -> dict[str, Any]:
    placeholder = Image.new("RGB", THUMBNAIL_SIZE, color=(228, 222, 210))
    placeholder.save(thumbnail_path, format="JPEG", quality=82, optimize=True)
    return {
        "latitude": None,
        "longitude": None,
        "date_time_original": None,
        "offset_time_original": None,
        "width": None,
        "height": None,
    }


def extract_gps_coordinates(gps_ifd: dict[int, Any]) -> tuple[float | None, float | None]:
    latitude_value = gps_ifd.get(piexif.GPSIFD.GPSLatitude)
    latitude_ref = gps_ifd.get(piexif.GPSIFD.GPSLatitudeRef)
    longitude_value = gps_ifd.get(piexif.GPSIFD.GPSLongitude)
    longitude_ref = gps_ifd.get(piexif.GPSIFD.GPSLongitudeRef)

    if not latitude_value or not latitude_ref or not longitude_value or not longitude_ref:
        return None, None

    latitude = dms_to_decimal(latitude_value, latitude_ref)
    longitude = dms_to_decimal(longitude_value, longitude_ref)
    return round(latitude, 7), round(longitude, 7)


def dms_to_decimal(dms_value: Any, reference: bytes) -> float:
    degrees = rational_to_float(dms_value[0])
    minutes = rational_to_float(dms_value[1])
    seconds = rational_to_float(dms_value[2])
    decimal_value = degrees + minutes / 60 + seconds / 3600
    if reference in (b"S", b"W"):
        decimal_value *= -1
    return decimal_value


def rational_to_float(value: Any) -> float:
    if isinstance(value, tuple):
        return value[0] / value[1]
    if isinstance(value, Fraction):
        return float(value)
    return float(value)


def decode_exif_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace")
    return str(value)


def wgs84_to_gcj02(latitude: float, longitude: float) -> tuple[float, float]:
    if is_outside_china(latitude, longitude):
        return round(latitude, 7), round(longitude, 7)

    delta_latitude = transform_latitude(longitude - 105.0, latitude - 35.0)
    delta_longitude = transform_longitude(longitude - 105.0, latitude - 35.0)
    radians_latitude = latitude / 180.0 * PI
    magic = math.sin(radians_latitude)
    magic = 1 - WGS84_EE * magic * magic
    sqrt_magic = math.sqrt(magic)
    delta_latitude = (delta_latitude * 180.0) / ((WGS84_A * (1 - WGS84_EE)) / (magic * sqrt_magic) * PI)
    delta_longitude = (delta_longitude * 180.0) / (WGS84_A / sqrt_magic * math.cos(radians_latitude) * PI)
    return round(latitude + delta_latitude, 7), round(longitude + delta_longitude, 7)


def is_outside_china(latitude: float, longitude: float) -> bool:
    return (
        longitude < CHINA_MIN_LONGITUDE
        or longitude > CHINA_MAX_LONGITUDE
        or latitude < CHINA_MIN_LATITUDE
        or latitude > CHINA_MAX_LATITUDE
    )


def transform_latitude(x_value: float, y_value: float) -> float:
    result = -100.0 + 2.0 * x_value + 3.0 * y_value + 0.2 * y_value * y_value
    result += 0.1 * x_value * y_value + 0.2 * math.sqrt(abs(x_value))
    result += (20.0 * math.sin(6.0 * x_value * PI) + 20.0 * math.sin(2.0 * x_value * PI)) * 2.0 / 3.0
    result += (20.0 * math.sin(y_value * PI) + 40.0 * math.sin(y_value / 3.0 * PI)) * 2.0 / 3.0
    result += (160.0 * math.sin(y_value / 12.0 * PI) + 320 * math.sin(y_value * PI / 30.0)) * 2.0 / 3.0
    return result


def transform_longitude(x_value: float, y_value: float) -> float:
    result = 300.0 + x_value + 2.0 * y_value + 0.1 * x_value * x_value
    result += 0.1 * x_value * y_value + 0.1 * math.sqrt(abs(x_value))
    result += (20.0 * math.sin(6.0 * x_value * PI) + 20.0 * math.sin(2.0 * x_value * PI)) * 2.0 / 3.0
    result += (20.0 * math.sin(x_value * PI) + 40.0 * math.sin(x_value / 3.0 * PI)) * 2.0 / 3.0
    result += (150.0 * math.sin(x_value / 12.0 * PI) + 300.0 * math.sin(x_value / 30.0 * PI)) * 2.0 / 3.0
    return result


def infer_title_and_place(source_path: Path, latitude: float | None, longitude: float | None) -> tuple[str, str]:
    source_name = source_path.stem.lower()
    if "beijing" in source_name:
        return "北京测试照片", "北京"
    if "shanghai" in source_name:
        return "上海测试照片", "上海"
    if latitude is not None and longitude is not None:
        return source_path.stem.replace("_", " ").title(), "已定位地点"
    return source_path.stem.replace("_", " ").title(), "待定位"


def format_coordinates(latitude: float | None, longitude: float | None) -> str | None:
    if latitude is None or longitude is None:
        return None
    return f"{latitude:.6f}, {longitude:.6f}"


def format_dimensions(width: int | None, height: int | None) -> str | None:
    if width is None or height is None:
        return None
    return f"{width} × {height}"


if __name__ == "__main__":
    main()
