#!/usr/bin/env python3
"""Assemble the Gate 1 comparison table from existing run outputs.

Repo-only preparation: this script reads whatever *.metrics.log files the
drivers have already written under results/llamacpp/ and results/mlc/ and
renders results/comparison.auto.md. It claims nothing about any device: an
empty table means no runs exist yet, and every value is carried verbatim
from the logs (missing values stay null). No adb, no network, no downloads.

Usage: assemble_comparison.py [--results DIR] [--out FILE]
"""
import argparse
from pathlib import Path

COLUMNS = [
    ("run_id", "run_id"),
    ("exit_code", "exit_code"),
    ("peak_rss_kb", "peak_rss_kb"),
    ("peak_pss_kB_max", "peak_pss_kB_max"),
    ("battery_level", "battery_level"),
    ("thermal_before_c", "thermal_before_c"),
    ("thermal_after_c", "thermal_after_c"),
]

NOTE = (
    "Assembled automatically from completed run outputs under results/. "
    "No device measurement is claimed by this script; an empty table means "
    "no runs have happened yet. Every value is carried verbatim from the "
    "run's own metrics log; missing values stay null."
)


def parse_metrics_log(path):
    """First occurrence of each key=value line wins; everything else ignored."""
    data = {}
    for line in path.read_text(errors="replace").splitlines():
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in data:
            data[key] = value.strip()
    return data


def cell(data, key):
    value = data.get(key)
    return value if value not in (None, "") else "null"


def collect(results_dir):
    rows = []
    for sub, source in (("llamacpp", "llamacpp"), ("mlc", "mlc")):
        d = results_dir / sub
        if not d.is_dir():
            continue
        for log in sorted(d.glob("*.metrics.log")):
            data = parse_metrics_log(log)
            data.setdefault("run_id", log.stem.replace(".metrics", ""))
            data["source"] = source
            rows.append((log.name, data))
    rows.sort(key=lambda r: r[0])
    return rows


def render(rows):
    lines = [
        "# Gate 1 comparison (auto-assembled)",
        "",
        NOTE,
        "",
    ]
    if not rows:
        lines.append("_No run outputs found yet._")
        lines.append("")
        return "\n".join(lines)
    header = "| " + " | ".join(label for _, label in COLUMNS) + " | source |"
    sep = "|" + "|".join("---" for _ in COLUMNS) + "|---|"
    lines.append(header)
    lines.append(sep)
    for _, data in rows:
        cells = [cell(data, key) for key, _ in COLUMNS]
        cells.append(data.get("source", "null"))
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


def main():
    here = Path(__file__).resolve().parent
    default_results = here.parent / "results"
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=default_results)
    ap.add_argument("--out", type=Path, default=default_results / "comparison.auto.md")
    args = ap.parse_args()
    rows = collect(args.results)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(rows))
    print(f"assembled {len(rows)} run row(s) -> {args.out}")


if __name__ == "__main__":
    main()
