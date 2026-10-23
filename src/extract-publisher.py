"""Extract report data only. The trusted Node caller verifies the ZIP digest first."""
import os
import stat
import sys
import zipfile

archive, output = sys.argv[1:]
head = {'capture.json', 'manifest.json', 'head.json', 'head.html'}
comparison = head | {'base.json', 'base.html', 'compare.json', 'compare.html', 'compare-shim-receipt.json'}
allowed = head, comparison, {'capture.json'}
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    names = [e.filename for e in entries]
    assert len(entries) <= 9 and len(names) == len(set(names)), 'Duplicate or excessive entries'
    assert set(names) in allowed, 'Unexpected archive inventory'
    assert sum(e.file_size for e in entries) <= 450 * 1024 * 1024, 'Expanded archive exceeds bound'
    for e in entries:
        limit = 65536 if e.filename in {'capture.json', 'manifest.json', 'compare-shim-receipt.json'} else 64 * 1024 * 1024
        assert 0 < e.file_size <= limit and not e.flag_bits & 1, 'Invalid report size or encryption'
        assert stat.S_IFMT(e.external_attr >> 16) in (0, stat.S_IFREG) and not e.is_dir(), 'Nonregular member'
    os.mkdir(output)
    for e in entries:
        with z.open(e) as src, open(os.path.join(output, e.filename), 'xb') as dst:
            remaining = e.file_size
            while remaining:
                data = src.read(min(remaining, 65536))
                assert data, 'Truncated report'
                dst.write(data)
                remaining -= len(data)
            assert not src.read(1), 'Oversized report'
