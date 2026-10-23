"""Bounded, inventory-only ZIP extraction; invoked only after archive SHA verification."""
import os
import stat
import sys
import zipfile

archive, output, mode = sys.argv[1:]
allowed = {'head.json', 'head.html', 'manifest.json', 'capture.json'}
assert mode in ('head', 'baseline')
os.mkdir(output)
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    assert len(entries) == 4 and {e.filename for e in entries} == allowed, 'Unexpected archive inventory'
    assert len({e.filename for e in entries}) == len(entries), 'Duplicate archive entry'
    assert sum(e.file_size for e in entries) <= 130 * 1024 * 1024, 'Archive too large'
    for e in entries:
        assert 0 < e.file_size <= (65536 if e.filename in ('manifest.json', 'capture.json') else 64 * 1024 * 1024)
        kind = stat.S_IFMT(e.external_attr >> 16)
        assert kind in (0, stat.S_IFREG) and not e.is_dir() and not e.flag_bits & 1, 'Unsafe archive member'
        with z.open(e) as src, open(os.path.join(output, e.filename), 'xb') as dst:
            remaining = e.file_size
            while remaining:
                chunk = src.read(min(remaining, 65536))
                assert chunk, 'Truncated entry'
                dst.write(chunk)
                remaining -= len(chunk)
            assert not src.read(1), 'Oversized entry'
