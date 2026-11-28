#!/usr/bin/env python3
"""Validate collected Gate 1 result records against results/schema.md.

Repo-only preparation: reads the JSON record files it is given (or every
*/*.json under --dir), checks each against the documented schema, and
prints named violations. It claims nothing about any device: a valid
record means the record is well-formed, not that any device produced it.
No adb, no network, no writes anywhere.

Enforced rules (source of truth: results/schema.md):
  - every documented field is present (a field is never omitted);
  - types are strict (integers are integers, booleans are booleans, and
    a number is never true/false standing in for 1/0);
  - a field the schema marks nullable may be null ONLY when `notes`
    carries an explanation (the schema's own rule: null is never silent);
  - `runtime` is the documented enum (llamacpp / mlc);
  - `run_id` matches <runtime>-<YYYYMMDD-HHMMSS>-<n>;
  - `timestamp_utc` is RFC3339;
  - unknown fields are refused (the record is the documented record).

Usage: validate_results.py FILE [FILE...]  |  validate_results.py --dir DIR
Exit 0 when every record passes, 1 on violations, 2 on usage or IO errors.
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Field table mirroring results/schema.md in order: field -> (type, nullable).
# scripts/selftest.sh carries a two-way sync guard, so this table and the
# document cannot drift apart silently.
FIELDS = {
    'run_id': ('string', False),
    'timestamp_utc': ('string', False),
    'runtime': ('string', False),
    'runtime_version': ('string', False),
    'runtime_license': ('string', False),
    'model_id': ('string', False),
    'model_artifact': ('string', False),
    'model_artifact_sha256': ('string', False),
    'model_quant': ('string', False),
    'model_license': ('string', False),
    'device_model': ('string', False),
    'device_manufacturer': ('string', False),
    'android_api': ('integer', False),
    'abi_list': ('string', False),
    'soc_model': ('string', False),
    'soc_manufacturer': ('string', False),
    'threads': ('integer', False),
    'context_tokens': ('integer', False),
    'repeats': ('integer', False),
    'cold_start_ms': ('number', True),
    'warm_start_ms': ('number', True),
    'ttft_ms': ('number', True),
    'prompt_tokens_per_s': ('number', False),
    'prompt_eval_ms': ('number', True),
    'gen_tokens_per_s': ('number', False),
    'peak_rss_kb': ('number', True),
    'peak_pss_kb': ('number', True),
    'thermal_before_c': ('number', True),
    'thermal_after_c': ('number', True),
    'thermal_units': ('string', False),
    'thermal_raw_max': ('number', True),
    'thermal_source_zone': ('string', True),
    'battery_before_pct': ('number', False),
    'battery_after_pct': ('number', False),
    'battery_charge_counter_before': ('number', True),
    'battery_charge_counter_after': ('number', True),
    'crash': ('boolean', False),
    'crash_excerpt': ('string', True),
    'screen_state': ('string', False),
    'raw_output_path': ('string', False),
    'notes': ('string', False),
}

RUNTIMES = ('llamacpp', 'mlc')
RUN_ID_RE = re.compile(r'^(llamacpp|mlc)-\d{8}-\d{6}-\d+$')
TIMESTAMP_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')


def type_ok(value, kind):
    if kind == 'string':
        return isinstance(value, str)
    if kind == 'integer':
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == 'number':
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == 'boolean':
        return isinstance(value, bool)
    return False


def validate_record(record):
    """Return a list of named violations; an empty list means the record conforms."""
    if not isinstance(record, dict):
        return ['record is not a JSON object']
    problems = []
    notes = record.get('notes')
    notes_explain = isinstance(notes, str) and notes.strip() != ''
    for field, (kind, nullable) in FIELDS.items():
        if field not in record:
            problems.append(f"missing required field '{field}' (a field is never omitted)")
            continue
        value = record[field]
        if value is None:
            if not nullable:
                problems.append(f"'{field}' is null but the schema marks it non-nullable")
            elif not notes_explain:
                problems.append(f"'{field}' is null without an explanation in 'notes' (null is never silent)")
            continue
        if not type_ok(value, kind):
            problems.append(f"'{field}' must be {kind}, got {type(value).__name__}")
    unknown = sorted(set(record) - set(FIELDS))
    if unknown:
        problems.append('unknown field(s): ' + ', '.join(unknown))
    runtime = record.get('runtime')
    if isinstance(runtime, str) and runtime not in RUNTIMES:
        problems.append(f"'runtime' must be one of {', '.join(RUNTIMES)}")
    run_id = record.get('run_id')
    if isinstance(run_id, str) and not RUN_ID_RE.match(run_id):
        problems.append("'run_id' does not match <runtime>-<YYYYMMDD-HHMMSS>-<n>")
    timestamp = record.get('timestamp_utc')
    if isinstance(timestamp, str) and not TIMESTAMP_RE.match(timestamp):
        problems.append("'timestamp_utc' is not an RFC3339 timestamp")
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Validate result records against results/schema.md.')
    parser.add_argument('files', nargs='*', help='JSON record files')
    parser.add_argument('--dir', help='validate every */*.json under DIR')
    args = parser.parse_args(argv)
    paths = [Path(f) for f in args.files]
    if args.dir:
        directory = Path(args.dir)
        if not directory.is_dir():
            print(f'refusing: {args.dir} is not a directory', file=sys.stderr)
            return 2
        paths.extend(sorted(directory.glob('*/*.json')))
    if not paths:
        parser.error('no record files given (pass files or --dir)')
    failures = 0
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            print(f'FAIL {path}: unreadable or not JSON ({exc})')
            failures += 1
            continue
        problems = validate_record(record)
        if problems:
            failures += 1
            print(f'FAIL {path}:')
            for problem in problems:
                print(f'  - {problem}')
        else:
            print(f'OK {path}')
    if failures:
        print(f'{failures} of {len(paths)} record file(s) failed validation')
        return 1
    print(f'{len(paths)} record file(s) valid')
    return 0


if __name__ == '__main__':
    sys.exit(main())
