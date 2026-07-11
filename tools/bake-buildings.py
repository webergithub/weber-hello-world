#!/usr/bin/env python3
"""Overture Maps 真实建筑轮廓 -> data/buildings-<city>.js
数据源: s3://overturemaps-us-west-2 (Overture Maps Foundation 开放数据, 免 key)
用法: python3 tools/bake-buildings.py [city ...]   # 缺省全部五城
"""
import json, sys, time
import s3fs, pyarrow.dataset as ds, pyarrow.compute as pc
from shapely import wkb
import mapbox_earcut as earcut
import numpy as np

RELEASE = '2026-06-17.0'
S = 0.24
CITIES = {
    #        lonMin   lonMax   latMin  latMax   LON0     LAT0     地标排除(lon,lat)
    'london':   (-0.155, -0.065, 51.493, 51.521, -0.11, 51.507,
        [(-0.12462,51.50072),(-0.1252,51.4998),(-0.1273,51.4993),(-0.11964,51.50333),(-0.09833,51.51384),(-0.08652,51.50452),(-0.08033,51.51442),(-0.07594,51.50811),(-0.12796,51.50776),(-0.14189,51.50139)]),
    'shanghai': (121.440, 121.545, 31.195, 31.260, 121.4925, 31.2275,
        [(121.4898,31.2365),(121.4995,31.2415),(121.5055,31.2335),(121.5045,31.2365),(121.5075,31.2350),(121.4920,31.2262),(121.4903,31.2448),(121.4700,31.2320)]),
    'istanbul': (28.930, 29.040, 40.985, 41.045, 28.985, 41.015,
        [(28.9800,41.0086),(28.9768,41.0054),(28.9741,41.0256),(28.9840,41.0118),(29.0000,41.0392),(28.9750,41.0060)]),
    'newyork':  (-74.025, -73.955, 40.700, 40.775, -73.99, 40.7375,
        [(-73.9857,40.7484),(-74.0133,40.7127),(-73.9755,40.7516),(-73.9787,40.7587),(-73.9822,40.7532),(-73.9820,40.7683)]),
    'dubai':    (55.255, 55.315, 25.175, 25.235, 55.285, 25.205,
        [(55.2744,25.1972),(55.2795,25.1985),(55.2828,25.2178),(55.2845,25.2158),(55.2870,25.2205),(55.2885,25.2255)]),
}

fs = s3fs.S3FileSystem(anon=True)
path = f'overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/'
files = [f for f in fs.ls(path) if f.endswith('.parquet')]
dataset = ds.dataset(files, filesystem=fs, format='parquet')

for city in (sys.argv[1:] or CITIES.keys()):
    lon0, lon1, lat0_, lat1, LON0, LAT0, landmarks = CITIES[city]
    t = time.time()
    flt = ((pc.field('bbox', 'xmin') > lon0) & (pc.field('bbox', 'xmax') < lon1) &
           (pc.field('bbox', 'ymin') > lat0_) & (pc.field('bbox', 'ymax') < lat1))
    tbl = dataset.to_table(filter=flt, columns=['geometry', 'height', 'num_floors'])
    mlon = 111320 * np.cos(np.radians(LAT0)) * S
    mlat = 111132 * S
    lmxz = [((lx - LON0) * mlon / S / S if False else (lx - LON0) * mlon, -(ly - LAT0) * mlat) for lx, ly in landmarks]
    out = []
    skipped = 0
    for i in range(tbl.num_rows):
        try:
            geom = wkb.loads(tbl['geometry'][i].as_py())
        except Exception:
            continue
        if geom.geom_type == 'MultiPolygon':
            geom = max(geom.geoms, key=lambda g: g.area)
        if geom.geom_type != 'Polygon':
            continue
        # 面积过滤（平方米近似）
        area_m2 = geom.area * (111320 * np.cos(np.radians(LAT0))) * 111132
        if area_m2 < 45:
            skipped += 1
            continue
        geom = geom.simplify(2.0 / 111132, preserve_topology=True)  # ~2m
        ring = list(geom.exterior.coords)[:-1]
        if len(ring) < 3 or len(ring) > 80:
            continue
        # 投影到游戏坐标
        pts = [((x - LON0) * mlon, -(y - LAT0) * mlat) for x, y in ring]
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        if any((cx - lx) ** 2 + (cz - lz) ** 2 < 30 ** 2 for lx, lz in lmxz):
            continue  # 让位给手工地标模型
        h = tbl['height'][i].as_py()
        nf = tbl['num_floors'][i].as_py()
        if h is None:
            h = (nf * 3.4) if nf else (6 + (int(abs(cx * 7 + cz * 13)) % 9))
        h = max(3.0, min(float(h), 350.0)) * 0.6  # 高度系数 0.6：与水平压缩视觉协调
        # 屋顶三角化
        arr = np.array(pts, dtype=np.float32).reshape(-1, 2)
        try:
            idx = earcut.triangulate_float32(arr, np.array([len(pts)], dtype=np.uint32)).tolist()
        except Exception:
            continue
        flat = []
        for x, z in pts:
            flat += [round(x, 1), round(z, 1)]  # pts 已含比例 S
        out.append([round(h, 1), flat, idx])
    payload = json.dumps({'b': out}, separators=(',', ':'))
    with open(f'data/buildings-{city}.js', 'w') as f:
        f.write('window.CITY_BUILDINGS=Object.assign(window.CITY_BUILDINGS||{},{"%s":%s});\n' % (city, payload))
    print(f'{city}: {len(out)} buildings ({skipped} tiny skipped), {len(payload)//1024}KB, {time.time()-t:.0f}s', file=sys.stderr)
