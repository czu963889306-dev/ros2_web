"""Print the local image exclusively referenced by one ROS map, if any."""
import os
from pathlib import Path
import sys

import yaml


def image_of(file):
    if file.is_symlink() or file.stat().st_size > 1024 * 1024:
        raise ValueError("unreadable map metadata")
    data = yaml.safe_load(file.read_text(encoding="utf-8"))
    image = data["image"]
    if not isinstance(image, str) or not image:
        raise ValueError("invalid image")
    return file.parent / image


def private_image(metadata):
    try:
        image = image_of(metadata)
        if image.is_symlink() or not image.is_file():
            return None
        image = image.resolve()
        if image.parent != metadata.parent or image.suffix.lower() not in {
            ".pgm", ".png", ".ppm", ".bmp", ".jpg", ".jpeg"
        }:
            return None
        for other in metadata.parent.glob("*.yaml"):
            if other != metadata and image_of(other).resolve() == image:
                return None
        return image.name
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError, RuntimeError):
        # An unreadable map might refer to the same image.
        return None


if __name__ == "__main__":
    name = private_image(Path(sys.argv[1]))
    if name:
        sys.stdout.buffer.write(os.fsencode(name))
