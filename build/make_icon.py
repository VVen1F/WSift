#!/usr/bin/env python3
"""Regenerate build/icon.png and build/icon.ico. Delegates to make_icon.js."""
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
raise SystemExit(subprocess.call(["node", str(here / "make_icon.js")], cwd=here.parent))
