from flask import Flask, request, jsonify, send_from_directory, render_template
import math
import requests
from pathlib import Path
import csv
import json
import time
from urllib.parse import urlencode

app = Flask(__name__, static_folder='.', static_url_path='/static')

ROOT = Path(__file__).parent
DATASET_DIR = ROOT / 'dataset'
GEOCODE_CACHE = ROOT / 'geocode_cache.json'
HEATMAP_CACHE_DIR = ROOT / 'cache'

RECAPTCHA_SECRET = ""

def verify_recaptcha(token):
    try:
        response = requests.post(
            "https://www.google.com/recaptcha/api/siteverify",
            data={
                "secret": RECAPTCHA_SECRET,
                "response": token
            },
            timeout=5
        )

        result = response.json()

        return (
            result.get("success", False)
            and result.get("score", 0) >= 0.5
            and result.get("action") == "submit"
        )
    except Exception:
        return False


DATA_POINTS = {}

REGION_BBOXES = {
    '서울특별시': (126.76, 37.40, 127.18, 37.72),
    '부산광역시': (128.80, 35.04, 129.25, 35.30),
    '대구광역시': (128.48, 35.74, 128.78, 35.96),
    '인천광역시': (126.52, 37.37, 126.94, 37.70),
    '광주광역시': (126.70, 35.00, 127.05, 35.25),
    '대전광역시': (127.20, 36.30, 127.55, 36.55),
    '울산광역시': (129.10, 35.40, 129.50, 35.60),
    '세종특별자치시': (127.10, 36.40, 127.35, 36.75),
    '경기도': (126.48, 36.50, 127.80, 38.30),
    '강원도': (127.30, 37.35, 129.60, 39.50),
    '충청북도': (125.50, 36.50, 128.00, 37.30),
    '충청남도': (125.00, 35.00, 127.50, 37.20),
    '전라북도': (124.50, 34.50, 127.50, 36.40),
    '전라남도': (124.00, 33.00, 127.50, 35.50),
    '경상북도': (127.00, 35.50, 129.50, 36.90),
    '경상남도': (127.40, 34.50, 129.60, 35.70),
    '제주특별자치도': (126.10, 33.10, 127.90, 33.70)
}


@app.route('/favicon.ico')
def serve_favicon():
    return send_from_directory('static', 'favicon.ico', mimetype='image/x-icon')


@app.route('/style.css')
def serve_style_css():
    return send_from_directory('static', 'style.css', mimetype='text/css')

@app.route('/')
def index():
    return render_template('index.html')


@app.route("/manifest.json")
def manifest():
    return jsonify({
  "id": "/",
  "name": "SafePath AI - 안전 지도",
  "short_name": "SafePath Ai",
  "description": "SafePath는 안전한 경로 탐색을 위한 지도 서비스입니다. 위험도 지도를 기반으로 최적의 안전 경로를 제공합니다.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#111111",
  "icons": [
    {
      "src": "https://raw.githubusercontent.com/Anion15/anion15.github.io/refs/heads/main/image.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
)

def load_geocode_cache(path=None, *args, **kwargs):
    try:
        if GEOCODE_CACHE.exists():
            return json.loads(GEOCODE_CACHE.read_text(encoding='utf-8'))
    except Exception:
        pass
    return {}


def save_geocode_cache(cache, path=None, *args, **kwargs):
    try:
        GEOCODE_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        pass


def geocode_address(addr, session=None, cache=None):
    """간단한 Nominatim 지오코더 (캐시 사용). 호출이 많아지지 않도록 주의하세요."""
    if not addr:
        return None
    if cache is None:
        cache = load_geocode_cache()
    if addr in cache:
        return cache[addr]

    params = {'q': addr, 'format': 'json', 'limit': 1}
    url = 'https://nominatim.openstreetmap.org/search?' + urlencode(params)
    headers = {'User-Agent': 'SafePathAi/1.0 (+https://example.com)'}
    try:
        r = (session or requests).get(url, headers=headers, timeout=6)
        r.raise_for_status()
        res = r.json()
        if res:
            lat = float(res[0].get('lat'))
            lng = float(res[0].get('lon'))
            cache[addr] = {'lat': lat, 'lng': lng}
            save_geocode_cache(cache)
            time.sleep(1)
            return cache[addr]
    except Exception:
        return None

    return None


def load_point_csv(file_name, lat_col, lng_col, encoding='cp949'):
    path = DATASET_DIR / file_name
    pts = []
    if not path.exists():
        return pts
    try:
        with open(path, 'r', encoding=encoding, errors='ignore') as fh:
            reader = csv.reader(fh)
            headers = next(reader, None)
            for row in reader:
                try:
                    lat_v = row[lat_col - 1].strip()
                    lng_v = row[lng_col - 1].strip()
                    if lat_v and lng_v:
                        lat = float(lat_v)
                        lng = float(lng_v)
                        pts.append((lat, lng))
                except Exception:
                    continue
    except Exception:
        return pts
    return pts


def ensure_heatmap_cache_dir():
    try:
        HEATMAP_CACHE_DIR.mkdir(exist_ok=True)
    except Exception:
        pass


def save_heatmap_cache(key, data):
    ensure_heatmap_cache_dir()
    try:
        p = HEATMAP_CACHE_DIR / f'heatmap_{key}.json'
        p.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass


def load_heatmap_cache(key):
    try:
        p = HEATMAP_CACHE_DIR / f'heatmap_{key}.json'
        if p.exists():
            return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return None
    return None


ROUTE_CACHE_FILE = HEATMAP_CACHE_DIR / 'route_cache.json'
MAX_ROUTE_CACHE_ENTRIES = 60


def load_route_cache():
    ensure_heatmap_cache_dir()
    try:
        if ROUTE_CACHE_FILE.exists():
            data = json.loads(ROUTE_CACHE_FILE.read_text(encoding='utf-8'))
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


def save_route_cache(cache):
    ensure_heatmap_cache_dir()
    try:
        ROUTE_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass


ROUTE_CACHE = load_route_cache()


def haversine_distance(lat1, lng1, lat2, lng2):
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def find_cached_route_entry(start, end, threshold=30):
    best = None
    best_score = None
    for entry in ROUTE_CACHE:
        try:
            start_dist = haversine_distance(start[0], start[1], entry['start']['lat'], entry['start']['lng'])
            end_dist = haversine_distance(end[0], end[1], entry['end']['lat'], entry['end']['lng'])
        except Exception:
            continue
        if start_dist <= threshold and end_dist <= threshold:
            score = start_dist + end_dist
            if best is None or score < best_score:
                best = entry
                best_score = score
    return best


def cache_safe_route(start, end, response):
    entry = {
        'start': {'lat': start[0], 'lng': start[1]},
        'end': {'lat': end[0], 'lng': end[1]},
        'response': response,
        'created_at': time.time()
    }
    ROUTE_CACHE[:] = [existing for existing in ROUTE_CACHE if not (
        haversine_distance(start[0], start[1], existing['start']['lat'], existing['start']['lng']) <= 5 and
        haversine_distance(end[0], end[1], existing['end']['lat'], existing['end']['lng']) <= 5
    )]
    ROUTE_CACHE.insert(0, entry)
    if len(ROUTE_CACHE) > MAX_ROUTE_CACHE_ENTRIES:
        del ROUTE_CACHE[MAX_ROUTE_CACHE_ENTRIES:]
    save_route_cache(ROUTE_CACHE)


def compute_heatmap_cells(bbox, zoom):
    minlng, minlat, maxlng, maxlat = bbox
    key = ','.join([f"{v:.3f}" for v in bbox]) + f'_z{zoom}'
    cached = load_heatmap_cache(key)
    if cached is not None:
        return cached, True

    def compute_cell_size(z):
        if z >= 16:
            return 0.001
        if z == 15:
            return 0.002
        if z == 14:
            return 0.004
        if z == 13:
            return 0.006
        if z == 12:
            return 0.010
        return 0.02

    cell_size = compute_cell_size(zoom)
    grid = {}
    weights = {
        'emergency_bell': 3,
        'safe_place': 2,
        'restroom': 1,
        'cctv': 2,
        'seculight': 1
    }
    datasets_to_use = {
        'emergency_bell': DATA_POINTS.get('emergency_bell', []),
        'safe_place': DATA_POINTS.get('safe_place', []),
        'cctv': DATA_POINTS.get('cctv', [])
    }

    def add_grid_weight(cx, cy, weight):
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                if dx == 0 and dy == 0:
                    factor = 1.0
                elif abs(dx) + abs(dy) == 1:
                    factor = 0.55
                else:
                    factor = 0.22
                keycell = f"{cx + dx},{cy + dy}"
                grid[keycell] = grid.get(keycell, 0) + weight * factor

    for dtype, pts in datasets_to_use.items():
        w = weights.get(dtype, 1)
        for lat, lng in pts:
            if lng < minlng or lng > maxlng or lat < minlat or lat > maxlat:
                continue
            cx = int((lng - minlng) / cell_size)
            cy = int((lat - minlat) / cell_size)
            add_grid_weight(cx, cy, w)

    try:
        params = {
            'service': 'WFS', 'version': '1.1.0', 'request': 'GetFeature',
            'typeName': 'safemap:A2SM_CMMNPOI_SECULIGHT', 'outputFormat': 'application/json',
            'srsName': 'EPSG:4326', 'bbox': ','.join(map(str, bbox)) + ',EPSG:4326', 'maxFeatures': '500'
        }
        r = requests.get('https://www.safemap.go.kr/geoserver_pos/safemap/wfs', params=params, timeout=15)
        if r.status_code == 200:
            data = r.json()
            for feat in data.get('features', []):
                geom = feat.get('geometry')
                if not geom or geom.get('type') != 'Point':
                    continue
                lng, lat = geom.get('coordinates', [None, None])
                if lng is None or lat is None:
                    continue
                if lng < minlng or lng > maxlng or lat < minlat or lat > maxlat:
                    continue
                cx = int((lng - minlng) / cell_size)
                cy = int((lat - minlat) / cell_size)
                add_grid_weight(cx, cy, weights.get('seculight', 1))
    except Exception:
        pass

    try:
        cache_geo = load_geocode_cache()
        restroom_path = DATASET_DIR / '공중화장실정보.csv'
        if restroom_path.exists():
            with open(restroom_path, 'r', encoding='cp949', errors='ignore') as fh:
                reader = csv.reader(fh)
                headers = next(reader, None)
                for row in reader:
                    try:
                        addr = row[6 - 1].strip()
                    except Exception:
                        addr = ''
                    if not addr:
                        continue
                    geo = cache_geo.get(addr)
                    if not geo:
                        continue
                    lat = geo.get('lat'); lng = geo.get('lng')
                    if lng < minlng or lng > maxlng or lat < minlat or lat > maxlat:
                        continue
                    cx = int((lng - minlng) / cell_size)
                    cy = int((lat - minlat) / cell_size)
                    add_grid_weight(cx, cy, weights.get('restroom', 1))
    except Exception:
        pass

    if not grid:
        save_heatmap_cache(key, [])
        return [], False

    maxv = max(grid.values())
    cells = []
    for k, val in grid.items():
        cx, cy = map(int, k.split(','))
        minx = minlng + cx * cell_size
        miny = minlat + cy * cell_size
        maxx = minx + cell_size
        maxy = miny + cell_size
        density = val / maxv
        color = interpolate_color(density)
        opacity = 0.25 + 0.3 * density
        cells.append({'minlng': minx, 'minlat': miny, 'maxlng': maxx, 'maxlat': maxy, 'score': val, 'density': density, 'color': color, 'opacity': opacity})

    save_heatmap_cache(key, cells)
    return cells, False


def _hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def _rgb_to_hex(rgb):
    return '#%02x%02x%02x' % (max(0, min(255, int(rgb[0]))), max(0, min(255, int(rgb[1]))), max(0, min(255, int(rgb[2]))))


def _lerp(a, b, t):
    return a + (b - a) * t


def interpolate_color(density):
    """밀도(0..1)에 따라 red->yellow->green 그라데이션 색상 반환"""
    red = _hex_to_rgb('#D32F2F')
    yellow = _hex_to_rgb('#FFB300')
    green = _hex_to_rgb('#2E7D32')
    if density <= 0:
        return _rgb_to_hex(red)
    if density >= 1:
        return _rgb_to_hex(green)
    if density <= 0.5:
        t = density / 0.5
        r = tuple(_lerp(red[i], yellow[i], t) for i in range(3))
        return _rgb_to_hex(r)
    else:
        t = (density - 0.5) / 0.5
        r = tuple(_lerp(yellow[i], green[i], t) for i in range(3))
        return _rgb_to_hex(r)


def reverse_geocode(lat, lng, session=None, cache=None):
    if cache is None:
        cache = load_geocode_cache()
    key = f'rev:{lat:.4f},{lng:.4f}'
    if key in cache:
        return cache[key]

    params = {
        'lat': str(lat),
        'lon': str(lng),
        'format': 'json',
        'zoom': 10,
        'addressdetails': 1
    }
    url = 'https://nominatim.openstreetmap.org/reverse?' + urlencode(params)
    headers = {'User-Agent': 'SafePathAi/1.0 (+https://example.com)'}
    try:
        r = (session or requests).get(url, headers=headers, timeout=8)
        r.raise_for_status()
        data = r.json()
        address = data.get('address', {})
        tokens = []
        for key in ['city', 'town', 'village', 'state', 'county', 'region', 'state_district', 'suburb', 'postcode']:
            value = address.get(key)
            if value:
                tokens.append(value)
        cache[key] = tokens
        save_geocode_cache(cache)
        return tokens
    except Exception:
        return []


def get_bbox_tokens(bbox, session=None, cache=None):
    minlng, minlat, maxlng, maxlat = bbox
    center_lat = (minlat + maxlat) / 2
    center_lng = (minlng + maxlng) / 2
    for token, limits in REGION_BBOXES.items():
        minx, miny, maxx, maxy = limits
        if center_lng >= minx and center_lng <= maxx and center_lat >= miny and center_lat <= maxy:
            return [token]
    return reverse_geocode(center_lat, center_lng, session=session, cache=cache)


def address_matches_tokens(addr, tokens):
    if not addr or not tokens:
        return False
    addr_lower = addr.lower()
    for token in tokens:
        if token and token.lower() in addr_lower:
            return True
    return False


MAX_RESTROOM_GEOCODE_ATTEMPTS = 8

def get_restroom_points_in_bbox(bbox, limit, session):
    cache = load_geocode_cache()
    tokens = get_bbox_tokens(bbox, session=session, cache=cache)
    results = []
    geocode_attempts = 0
    csv_path = DATASET_DIR / '공중화장실정보.csv'
    if not csv_path.exists():
        return results

    with open(csv_path, 'r', encoding='cp949', errors='ignore') as fh:
        reader = csv.reader(fh)
        headers = next(reader, None)
        for row in reader:
            if not row:
                continue
            addr_idx = 6 - 1
            addr = row[addr_idx].strip() if addr_idx < len(row) else ''
            if not addr:
                continue
            if tokens and not address_matches_tokens(addr, tokens):
                continue
            geo = cache.get(addr)
            if not geo:
                if geocode_attempts >= MAX_RESTROOM_GEOCODE_ATTEMPTS:
                    continue
                geocode_attempts += 1
                geo = geocode_address(addr, session=session, cache=cache)
            if not geo:
                continue
            lat = geo.get('lat')
            lng = geo.get('lng')
            if in_bbox(lat, lng, bbox):
                props = {}
                if headers:
                    for i, h in enumerate(headers):
                        try:
                            props[h] = row[i]
                        except Exception:
                            props[h] = ''
                else:
                    props = {f'col_{i+1}': v for i, v in enumerate(row)}
                results.append({
                    'name': props.get('화장실명') or props.get('name') or '공중화장실',
                    'lat': lat,
                    'lng': lng,
                    'type': 'restroom',
                    'properties': props
                })
                if len(results) >= limit:
                    break
    return results


def parse_bbox(bbox_str):
    try:
        parts = bbox_str.split(',')
        if len(parts) >= 4:
            minlng, minlat, maxlng, maxlat = map(float, parts[:4])
            return (minlng, minlat, maxlng, maxlat)
    except:
        pass
    return None


def in_bbox(lat, lng, bbox):
    if lat is None or lng is None:
        return False
    minlng, minlat, maxlng, maxlat = bbox
    return (lng >= minlng and lng <= maxlng and lat >= minlat and lat <= maxlat)



@app.route('/api/points')
def api_points():
    """데이터셋명과 bbox로 해당 영역의 포인트만 반환합니다.
    파라미터: dataset={restroom|emergency_bell|safe_place|cctv|seculight}
               bbox=minlng,minlat,maxlng,maxlat
    """
    dataset = request.args.get('dataset')
    bbox_str = request.args.get('bbox')
    limit = int(request.args.get('limit') or 1000)

    if not dataset or not bbox_str:
        return jsonify({'error': 'dataset and bbox are required'}), 400

    bbox = parse_bbox(bbox_str)
    if not bbox:
        return jsonify({'error': 'invalid bbox'}), 400

    dataset = dataset.lower()
    results = []

    mapping = {
        'restroom': {'file': '공중화장실정보.csv', 'lat_col': None, 'lng_col': None, 'addr_col': 6},
        'emergency_bell': {'file': '안전비상벨위치정보.csv', 'lat_col': 9, 'lng_col': 10},
        'safe_place': {'file': '전국안심지킴이집표준데이터.csv', 'lat_col': 7, 'lng_col': 8},
        'cctv': {'file': 'CCTV정보.csv', 'lat_col': 13, 'lng_col': 14},
        'seculight': {'proxy_wfs': True}
    }

    if dataset not in mapping:
        return jsonify({'error': 'unknown dataset'}), 400

    info = mapping[dataset]
    session = requests.Session()

    if info.get('proxy_wfs'):
        return seculights()

    if dataset == 'restroom':
        features = get_restroom_points_in_bbox(bbox, limit, session=session)
        return jsonify({'features': features, 'count': len(features)})

    csv_path = DATASET_DIR / info['file']
    if not csv_path.exists():
        return jsonify({'error': 'dataset file not found', 'file': str(csv_path)}), 404

    encodings = ['utf-8', 'cp949', 'euc-kr', 'latin-1']

    found = 0
    for enc in encodings:
        try:
            with open(csv_path, 'r', encoding=enc, errors='ignore') as fh:
                reader = csv.reader(fh)
                headers = next(reader, None)
                for row in reader:
                    if not row:
                        continue
                    lat = None
                    lng = None
                    if info.get('lat_col') and info.get('lng_col'):
                        try:
                            lat_v = row[info['lat_col'] - 1].strip()
                            lng_v = row[info['lng_col'] - 1].strip()
                            if lat_v and lng_v:
                                lat = float(lat_v)
                                lng = float(lng_v)
                        except Exception:
                            lat = None
                            lng = None
                    else:
                        addr_idx = info.get('addr_col') - 1 if info.get('addr_col') else None
                        addr = ''
                        try:
                            if addr_idx is not None and addr_idx < len(row):
                                addr = row[addr_idx].strip()
                        except:
                            addr = ''
                        if addr:
                            geo = geocode_address(addr, session=session)
                            if geo:
                                lat = geo.get('lat')
                                lng = geo.get('lng')

                    if in_bbox(lat, lng, bbox):
                        props = {}
                        if headers:
                            for i, h in enumerate(headers):
                                try:
                                    props[h] = row[i]
                                except:
                                    props[h] = ''
                        else:
                            props = {f'col_{i+1}': v for i, v in enumerate(row)}

                        results.append({
                            'name': props.get('name') or props.get('점포명') or (headers[0] if headers else 'point'),
                            'lat': lat,
                            'lng': lng,
                            'type': dataset,
                            'properties': props
                        })
                        found += 1
                        if found >= limit:
                            break
                break
        except Exception:
            continue

    return jsonify({'features': results, 'count': len(results)})


@app.route('/api/heatmap')
def api_heatmap():
    """서버 측에서 안전 히트맵(격자) 계산 및 캐시 반환
    파라미터: bbox=minlng,minlat,maxlng,maxlat
               zoom=<int> (사용자 지도 줌 레벨)
    """
    bbox_str = request.args.get('bbox')
    zoom = int(float(request.args.get('zoom') or 12))

    if not bbox_str:
        return jsonify({'error': 'bbox required'}), 400
    bbox = parse_bbox(bbox_str)
    if not bbox:
        return jsonify({'error': 'invalid bbox'}), 400

    cells, cached = compute_heatmap_cells(bbox, zoom)
    return jsonify({'cells': cells, 'cached': cached, 'count': len(cells)})

    try:
        cache_geo = load_geocode_cache()
        restroom_path = DATASET_DIR / '공중화장실정보.csv'
        if restroom_path.exists():
            with open(restroom_path, 'r', encoding='cp949', errors='ignore') as fh:
                reader = csv.reader(fh)
                headers = next(reader, None)
                for row in reader:
                    try:
                        addr = row[6 - 1].strip()
                    except Exception:
                        addr = ''
                    if not addr: continue
                    geo = cache_geo.get(addr)
                    if not geo: continue
                    lat = geo.get('lat'); lng = geo.get('lng')
                    if lng < minlng or lng > maxlng or lat < minlat or lat > maxlat: continue
                    cx = int((lng - minlng) / cell_size)
                    cy = int((lat - minlat) / cell_size)
                    add_grid_weight(cx, cy, weights.get('restroom', 1))
    except Exception:
        pass

    if not grid:
        save_heatmap_cache(key, [])
        return jsonify({'cells': [], 'cached': False, 'count': 0})

    maxv = max(grid.values())
    cells = []
    for k, val in grid.items():
        cx, cy = map(int, k.split(','))
        minx = minlng + cx * cell_size
        miny = minlat + cy * cell_size
        maxx = minx + cell_size
        maxy = miny + cell_size
        density = val / maxv
        color = interpolate_color(density)
        opacity = 0.25 + 0.3 * density

        cells.append({'minlng': minx, 'minlat': miny, 'maxlng': maxx, 'maxlat': maxy, 'score': val, 'density': density, 'color': color, 'opacity': opacity})

    save_heatmap_cache(key, cells)
    return jsonify({'cells': cells, 'cached': False, 'count': len(cells)})


@app.route('/seculights')
def seculights():
    """보안등 WFS 프록시: 클라이언트에서 bbox 파라미터로 요청
    예: /seculights?bbox=minlng,minlat,maxlng,maxlat
    """
    bbox = request.args.get('bbox')
    if not bbox:
        return jsonify({'error': 'bbox is required'}), 400

    url = 'https://www.safemap.go.kr/geoserver_pos/safemap/wfs'
    params = {
        'service': 'WFS',
        'version': '1.1.0',
        'request': 'GetFeature',
        'typeName': 'safemap:A2SM_CMMNPOI_SECULIGHT',
        'outputFormat': 'application/json',
        'srsName': 'EPSG:4326',
        'bbox': bbox + ',EPSG:4326',
        'maxFeatures': '80'
    }

    try:
        r = requests.get(url, params=params, timeout=20)
        r.raise_for_status()
    except Exception as e:
        return jsonify({'error': str(e)}), 502

    data = r.json()

    features = []
    for feat in data.get('features', []):
        props = feat.get('properties', {})
        geom = feat.get('geometry')
        lat = None
        lng = None
        if geom and geom.get('type') == 'Point' and isinstance(geom.get('coordinates'), list):
            lng, lat = geom['coordinates'][0], geom['coordinates'][1]

        features.append({
            'name': props.get('OBJT_NM') or '보안등',
            'lat': lat,
            'lng': lng,
            'type': 'seculight',
            'address': props.get('ADDR') or '',
            'properties': props
        })

    return jsonify({'features': features, 'count': len(features)})


@app.route('/api/geocode')
def api_geocode():
    """간단 주소 -> 좌표 (캐시 사용)
    파라미터: address=<주소 문자열>
    """
    addr = request.args.get('address')
    if not addr:
        return jsonify({'error': 'address required'}), 400
    geo = geocode_address(addr)
    if not geo:
        return jsonify({'error': 'not found'}), 404
    return jsonify({'lat': geo['lat'], 'lng': geo['lng']})


@app.route('/api/safe_route')
def api_safe_route():
    """안전한 도보 경로를 찾아 반환합니다.
    파라미터: start=lat,lng 또는 address=... , end=lat,lng 또는 address=...
    선택적으로 zoom=<int> (히트맵 해상도 결정용)
    """

    # reCAPTCHA 검증
    token = request.args.get("recaptcha_token", "")
    if not verify_recaptcha(token):
        return jsonify({
            "error": "reCAPTCHA verification failed"
        }), 403

    start = request.args.get('start')
    end = request.args.get('end')
    zoom = int(request.args.get('zoom') or 14)

    def resolve_point(token):
        if not token:
            return None
        try:
            parts = token.split(',')
            if len(parts) == 2:
                lat = float(parts[0]); lng = float(parts[1])
                return (lat, lng)
        except Exception:
            pass
        geo = geocode_address(token)
        if geo:
            return (geo['lat'], geo['lng'])
        return None

    p1 = resolve_point(start)
    p2 = resolve_point(end)
    if not p1 or not p2:
        return jsonify({'error': 'start and end required (lat,lng or address)'}), 400

    cache_entry = find_cached_route_entry(p1, p2)
    if cache_entry:
        return jsonify(cache_entry['response'])

    minlat = min(p1[0], p2[0]) - 0.02
    maxlat = max(p1[0], p2[0]) + 0.02
    minlng = min(p1[1], p2[1]) - 0.02
    maxlng = max(p1[1], p2[1]) + 0.02
    bbox = (minlng, minlat, maxlng, maxlat)
    bbox_str = ','.join(map(str, bbox))

    cells, _ = compute_heatmap_cells(bbox, zoom)
    cell_map = {}
    cell_size = None
    if cells:
        c0 = cells[0]
        cell_size = c0.get('maxlng') - c0.get('minlng')
        for c in cells:
            cx = int(math.floor((c['minlng'] - bbox[0]) / (cell_size or 1)))
            cy = int(math.floor((c['minlat'] - bbox[1]) / (cell_size or 1)))
            key = f"{cx},{cy}"
            cell_map[key] = c.get('density', 0)

    def density_for_point(lat, lng):
        if not cell_size or not cell_map:
            return 0
        cx = int((lng - bbox[0]) / cell_size)
        cy = int((lat - bbox[1]) / cell_size)
        return cell_map.get(f"{cx},{cy}", 0)

    try:
        import osmnx as ox
        import networkx as nx
        use_osmnx = True
    except Exception:
        use_osmnx = False

    best = None
    best_score = None
    route_results = []

    alpha = 0.6

    if use_osmnx:
        try:
            mid_lat = (p1[0] + p2[0]) / 2.0
            mid_lng = (p1[1] + p2[1]) / 2.0
            direct_dist_km = haversine_distance(p1[0], p1[1], p2[0], p2[1]) / 1000.0
            graph_dist = int(min(8000, max(2000, direct_dist_km * 1000 * 1.4)))

            G = ox.graph_from_point((mid_lat, mid_lng), dist=graph_dist, network_type='walk')
            G = ox.add_edge_lengths(G)

            for u, v, k, data in G.edges(keys=True, data=True):
                nu = G.nodes[u]
                nv = G.nodes[v]
                try:
                    lat_mid = (nu.get('y', nu.get('lat')) + nv.get('y', nv.get('lat'))) / 2.0
                    lng_mid = (nu.get('x', nu.get('lon')) + nv.get('x', nv.get('lon'))) / 2.0
                except Exception:
                    lat_mid = (nu.get('lat', 0) + nv.get('lat', 0)) / 2.0
                    lng_mid = (nu.get('lon', 0) + nv.get('lon', 0)) / 2.0
                dens = density_for_point(lat_mid, lng_mid)
                length_m = data.get('length', 0.0)
                crime_score = (1.0 - dens) * 120.0
                light_score = dens * 80.0
                weight = max(1.0, length_m + crime_score - light_score)
                data['weight'] = weight

            try:
                src = ox.distance.nearest_nodes(G, p1[1], p1[0])
                dst = ox.distance.nearest_nodes(G, p2[1], p2[0])
            except Exception:
                src = ox.distance.nearest_nodes(G, X=p1[1], Y=p1[0])
                dst = ox.distance.nearest_nodes(G, X=p2[1], Y=p2[0])

            path_nodes = nx.shortest_path(G, src, dst, weight='weight')
            coords = []
            total_len = 0.0
            dens_vals = []
            for i in range(len(path_nodes)):
                n = path_nodes[i]
                node = G.nodes[n]
                lat = node.get('y', node.get('lat'))
                lng = node.get('x', node.get('lon'))
                coords.append([lat, lng])
                if i < len(path_nodes) - 1:
                    e_data = G.get_edge_data(path_nodes[i], path_nodes[i+1])
                    if e_data:
                        first = next(iter(e_data.values()))
                        total_len += first.get('length', 0.0)
                        nu = G.nodes[path_nodes[i]]
                        nv = G.nodes[path_nodes[i+1]]
                        lat_mid = (nu.get('y', nu.get('lat')) + nv.get('y', nv.get('lat'))) / 2.0
                        lng_mid = (nu.get('x', nu.get('lon')) + nv.get('x', nv.get('lon'))) / 2.0
                        dens_vals.append(density_for_point(lat_mid, lng_mid))

            avg_density = sum(dens_vals) / len(dens_vals) if dens_vals else 0
            score = total_len * (1.0 - alpha * avg_density)
            best = {'coords': coords, 'distance': total_len, 'avg_density': avg_density}
            best_score = score
            route_results.append({'coords': coords, 'distance': total_len, 'avg_density': avg_density, 'score': score})
        except Exception as e:
            use_osmnx = False

    if not use_osmnx:
        s_lng, s_lat = p1[1], p1[0]
        e_lng, e_lat = p2[1], p2[0]
        osrm_url = f'http://router.project-osrm.org/route/v1/foot/{s_lng},{s_lat};{e_lng},{e_lat}?overview=full&alternatives=true&geometries=geojson'
        try:
            rr = requests.get(osrm_url, timeout=15)
            rr.raise_for_status()
            routes = rr.json().get('routes', [])
        except Exception as e:
            return jsonify({'error': 'routing failed', 'detail': str(e)}), 502

        for route in routes:
            geom = route.get('geometry', {})
            coords = geom.get('coordinates', [])
            if not coords:
                continue
            vals = []
            step = max(1, int(len(coords)/200))
            for lng, lat in coords[::step]:
                vals.append(density_for_point(lat, lng))
            avg_density = sum(vals)/len(vals) if vals else 0
            dist = route.get('distance', 0)
            score = dist * (1.0 - alpha * avg_density)
            route_results.append({'coords': [[pt[1], pt[0]] for pt in coords], 'avg_density': avg_density, 'distance': dist, 'score': score})
            if best is None or score < best_score:
                best = route_results[-1]
                best_score = score

    if not best:
        return jsonify({'error': 'no route found'}), 404

    def category_for_density(d):
        if d >= 0.66:
            return 'green'
        if d >= 0.33:
            return 'orange'
        return 'red'

    segs = []
    coords = best['coords']
    for lat, lng in coords:
        d = density_for_point(lat, lng)
        segs.append({'lat': lat, 'lng': lng, 'density': d, 'category': category_for_density(d)})

    response = {'route': {'coords': coords, 'distance': best['distance'], 'avg_density': best['avg_density']}, 'segments': segs}
    try:
        cache_safe_route(p1, p2, response)
    except Exception:
        pass
    return jsonify(response)


if __name__ == '__main__':
    try:
        DATA_POINTS['emergency_bell'] = load_point_csv('안전비상벨위치정보.csv', 9, 10)
    except Exception:
        DATA_POINTS['emergency_bell'] = []
    try:
        DATA_POINTS['safe_place'] = load_point_csv('전국안심지킴이집표준데이터.csv', 7, 8)
    except Exception:
        DATA_POINTS['safe_place'] = []
    try:
        DATA_POINTS['cctv'] = load_point_csv('CCTV정보.csv', 13, 14)
    except Exception:
        DATA_POINTS['cctv'] = []

    print('데이터 포인트 메모리 로드 완료:', {k: len(v) for k, v in DATA_POINTS.items()})

    app.run(host='0.0.0.0', port=3007, debug=True, use_reloader=False)
