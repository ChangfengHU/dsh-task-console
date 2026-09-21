#!/usr/bin/env python3
"""Validate safe environment metadata returned by IP intelligence services."""

from __future__ import annotations

import argparse
import json
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def exit_timezone(value: object) -> str:
    if not isinstance(value, dict):
        raise ValueError("IP intelligence response must be a JSON object")
    timezone = value.get("timezone")
    if not isinstance(timezone, str) or not timezone or len(timezone) > 128:
        raise ValueError("IP intelligence response has no valid timezone")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("IP intelligence response contains an unknown timezone") from exc
    return timezone


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("exit-timezone",))
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        if args.command == "exit-timezone":
            print(exit_timezone(payload))
    except (json.JSONDecodeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
