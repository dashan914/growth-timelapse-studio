"""Package already validated PNG frames with the standard library on every OS."""
import pathlib
import re
import sys
import zipfile

destination = pathlib.Path(sys.argv[1])
names = sys.stdin.read().splitlines()
if not names or len(names) > 72000 or any(not re.fullmatch(r"frame_\d{6}\.png", name) for name in names):
    raise ValueError("Invalid PNG frame list")
with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_STORED) as archive:
    for name in names:
        archive.write(name, arcname=name)
