"""Independent standard-library reader for the authorized browser takeoff fixture."""
import csv
import json
import math
import sys

with open(sys.argv[1], encoding="utf-8", newline="") as source:
    rows = list(csv.DictReader(source))
assert len(rows) == 2
assert {row['Label'] for row in rows} == {'Main run', 'Slab'}
for row in rows:
    assert None not in row and all(value is not None for value in row.values())
    points = json.loads(row['Points JSON'])
    reference = json.loads(row['Reference points JSON'])
    meters = float(row['Reference distance']) * 0.3048 / math.dist(*reference)
    assert math.isclose(meters, float(row['Meters per PDF unit']), rel_tol=1e-14)
    assert row['Page'] == '1'
    if row['Type'] == 'length':
        expected = math.dist(*points) * meters / 0.3048
        assert row['Unit'] == 'ft'
    else:
        assert row['Type'] == 'area' and row['Unit'] == 'ft²'
        area = abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1]))) / 2
        expected = area * (meters / 0.3048)**2
    assert math.isclose(float(row['Value']), expected, rel_tol=1e-12)
print('Independent CSV reader: two quantities and calibration evidence verified.')
