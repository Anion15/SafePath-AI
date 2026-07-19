// 활성화된 dataset 목록 (사용자가 선택 가능)
let activeDatasets = {
    emergency_bell: true,
    safe_place: true,
    restroom: false,  // 기본 비활성화 (지오코딩 느림)
    cctv: true,
    seculight: true
};

// 요청할 데이터셋 리스트
const ALL_DATASETS = ['emergency_bell', 'safe_place', 'restroom', 'cctv', 'seculight'];
const ACTIVE_DATASETS = () => ALL_DATASETS.filter(d => activeDatasets[d]);

// 전역 상태 변수
let map = null;
let userLocation = null;
let userMarker = null;
let markerGroup = null;
let fetchInProgress = false;
let lastFetchTime = 0;
const FETCH_DEBOUNCE_MS = 700;

// 데이터 캐시 (bbox 기반)
let dataCache = {}; // {"126.9,37.4,127.2,37.7": {emergency_bell: [...], ...}}
let currentCachedBbox = null;

// 진행률 추적
let downloadProgress = 0;
let totalDatasets = 0;

// 전역 바텀시트 제어 함수
let setRouteSheetState, openMobileRouteSheet, collapseMobileRouteSheet;

function initGlobalRouteSheet() {
    const routeSheetInner = document.getElementById('routeSheetInner');
    const routeSheetBody = document.getElementById('routeSheetBody');
    
    setRouteSheetState = function(state) {
        if (!routeSheetInner || !routeSheetBody) return;
        routeSheetInner.classList.remove('collapsed', 'mid', 'open');
        routeSheetInner.classList.add(state);
        if (state === 'collapsed') {
            routeSheetBody.classList.add('collapsed');
        } else {
            routeSheetBody.classList.remove('collapsed');
        }
        routeSheetInner.style.maxHeight = '';
    };
    
    openMobileRouteSheet = function() {
        setRouteSheetState('open');
    };
    
    collapseMobileRouteSheet = function() {
        setRouteSheetState('collapsed');
    };
}
/**
 * Bbox 캐시 키 생성 (소수점 4자리)
 */
function getBboxCacheKey(bbox) {
    return bbox.split(',').map(v => parseFloat(v).toFixed(3)).join(',');
}

/**
 * 진행률 업데이트
 */
function updateProgressBar() {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    if (!progressBar || !progressText) return;
    
    const percentage = totalDatasets > 0 ? Math.round((downloadProgress / totalDatasets) * 100) : 0;
    progressBar.style.width = percentage + '%';
    progressText.textContent = `${downloadProgress}/${totalDatasets} (${percentage}%)`;
}

/**
 * UI 잠금 상태 설정
 */
function setUILocked(locked) {
    const markerPane = document.querySelector('.leaflet-marker-pane');
    const buttons = document.querySelectorAll('.btn');
    const inputs = document.querySelectorAll('input[type="checkbox"]');
    
    if (locked) {
        if (markerPane) markerPane.style.pointerEvents = 'none';
        buttons.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
        inputs.forEach(i => i.disabled = true);
    } else {
        if (markerPane) markerPane.style.pointerEvents = 'auto';
        buttons.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
        inputs.forEach(i => i.disabled = false);
    }
}

// 상수
const MIN_ZOOM = 13; // 기본 시야 줌
const LOAD_ZOOM_THRESHOLD = 10; // 이 줌 레벨 이상에서만 서버에서 데이터를 가져옴

// 타입별 색상 매핑
const typeColors = {
    emergency_bell: '#FF5722',
    safe_place: '#4CAF50',
    restroom: '#2196F3',
    cctv: '#9C27B0',
    seculight: '#FFD600'
};

// 타입별 이름 매핑
const typeNames = {
    emergency_bell: '🚨 비상벨',
    safe_place: '🏪 안심지킴이집',
    restroom: '🚻 공중화장실',
    cctv: '📹 CCTV',
    seculight: '💡 보안등'
};

// 히트맵 셀 레이어
let heatmapLayer = null;
let cellSize = 0.008; // 대략 ~800m
// 경로 변수
let startMarker = null;
let endMarker = null;
let routeLayer = null;
let pickMode = null; // 'start' | 'end' | null


/**
 * 히트맵 렌더링
 */
function renderHeatmap(data) {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }
    
    if (data.length === 0) return;
    
    // 셀 기반 밀도 계산
    const grid = {};
    data.forEach(point => {
        const cellX = Math.floor(point.lng / cellSize);
        const cellY = Math.floor(point.lat / cellSize);
        const key = `${cellX},${cellY}`;
        grid[key] = (grid[key] || 0) + 1;
    });
    
    // 폴리곤 생성
    const featureGroup = L.featureGroup();
    const maxDensity = Math.max(...Object.values(grid));
    
    Object.entries(grid).forEach(([key, count]) => {
        const [cellX, cellY] = key.split(',').map(Number);
        const bounds = [
            [cellY * cellSize, cellX * cellSize],
            [(cellY + 1) * cellSize, (cellX + 1) * cellSize]
        ];
        
        // 밀도에 따른 색상
        let color, opacity;
        const density = count / maxDensity;
        if (density > 0.6) {
            color = '#4CAF50';
            opacity = 0.25;
        } else if (density > 0.3) {
            color = '#FFC107';
            opacity = 0.15;
        } else {
            color = '#F44336';
            opacity = 0.1;
        }
        
        const rect = L.rectangle(bounds, {
            color: color,
            weight: 0,
            fillOpacity: opacity,
            fillColor: color
        });
        
        featureGroup.addLayer(rect);
    });
    
    heatmapLayer = featureGroup;
    heatmapLayer.addTo(map);
}

/**
 * 맵 초기화
 */
function initMap() {
    // 지도 생성
    map = L.map('map').setView([37.5665, 126.9780], MIN_ZOOM);
    
    // OSM 타일 레이어 추가
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        minZoom: MIN_ZOOM
    }).addTo(map);
    
    // 마커 그룹 생성
    markerGroup = L.featureGroup();
    markerGroup.addTo(map);

    // 이벤트 리스너
    map.on('moveend', onMapMoveEnd);
    map.on('zoomend', () => { updateZoomLevel(); onMapMoveEnd(); });
    map.on('click', (e) => {
        if (pickMode) {
            const lat = e.latlng.lat, lng = e.latlng.lng;
            setMarker(pickMode, lat, lng);
            const inputId = pickMode === 'start' ? 'startInput' : 'endInput';
            document.getElementById(inputId).value = `${lat.toFixed(6)},${lng.toFixed(6)}`;
            pickMode = null;
            // 버튼 스타일 해제
            const b1 = document.getElementById('pickStartBtn');
            const b2 = document.getElementById('pickEndBtn');
            if (b1) b1.classList.remove('active');
            if (b2) b2.classList.remove('active');
        }
    });

    console.log('지도 초기화 완료');
    updateZoomLevel();
    updateVisibleMarkers();
    requestUserLocation();
}

/**
 * 줌 레벨 표시 업데이트
 */
function updateZoomLevel() {
    const zoom = map.getZoom();
    document.getElementById('zoomLevel').textContent = zoom;
    // 줌 레벨 변경 시는 onMapMoveEnd에서 데이터 갱신
}

/**
 * 모든 데이터 로드 (캐싱 포함)
 */
async function fetchDataset(dataset, bbox, limit=1000) {
    try {
        const params = new URLSearchParams({ dataset, bbox, limit });
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`/api/points?${params.toString()}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        downloadProgress++;
        updateProgressBar();
        return data.features || [];
    } catch (err) {
        console.warn('fetchDataset error', dataset, err);
        downloadProgress++;
        updateProgressBar();
        return [];
    }
}

/**
 * 화면에 표시될 마커 업데이트 (캐싱 + 진행률)
 */
async function updateVisibleMarkers() {
    if (!map) return;
    const zoom = map.getZoom();
    document.getElementById('zoomLevel').textContent = zoom;
    
    if (zoom < LOAD_ZOOM_THRESHOLD) {
        clearMarkers();
        if (heatmapLayer) map.removeLayer(heatmapLayer);
        document.getElementById('visibleData').textContent = '0';
        setUILocked(false);
        return;
    }

    const now = Date.now();
    if (fetchInProgress && now - lastFetchTime < FETCH_DEBOUNCE_MS) return;
    
    fetchInProgress = true;
    lastFetchTime = now;
    
    const bounds = map.getBounds();
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
    const cacheKey = getBboxCacheKey(bbox);
    
    // 캐시 확인
    if (dataCache[cacheKey] && currentCachedBbox === cacheKey) {
        console.log('캐시에서 데이터 로드:', cacheKey);
        const merged = [].concat(...Object.values(dataCache[cacheKey]));
        document.getElementById('visibleData').textContent = merged.length.toLocaleString();
        renderHeatmap(merged);
        renderClusters(merged);
        fetchInProgress = false;
        setUILocked(false);
        return;
    }
    
    // 서버 측 히트맵 요청
    console.log('히트맵 요청:', cacheKey);
    setUILocked(true);
    showTopLoading(true, '히트맵 계산 중...', 0);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);
        const params = new URLSearchParams({ bbox, zoom: map.getZoom() });
        const res = await fetch(`/api/heatmap?${params.toString()}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(res.statusText || res.status);
        const json = await res.json();
        // 서버는 이미 캐시 유무를 알려주므로 즉시 화면에 반영
        const cells = json.cells || [];
        document.getElementById('visibleData').textContent = cells.length.toLocaleString();
        renderServerCells(cells);
        showTopLoading(true, json.cached ? '캐시에서 로드됨' : '계산 완료', 100);
    } catch (err) {
        console.warn('heatmap fetch error', err);
    } finally {
        fetchInProgress = false;
        setUILocked(false);
        setTimeout(() => showTopLoading(false), 800);
    }
}


/**
 * 상단 우측 간단 로딩 표시
 */
function showTopLoading(show, text, percent) {
    const el = document.getElementById('loadingTop');
    if (!el) return;
    if (show) {
        el.classList.remove('hidden');
        if (text) document.getElementById('loadingTopText').textContent = text;
        if (typeof percent === 'number') document.getElementById('loadingTopProgress').textContent = `${percent}%`;
    } else {
        el.classList.add('hidden');
    }
}


/**
 * 서버에서 계산된 셀(격자) 렌더링
 */
function renderServerCells(cells) {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }
    if (!cells || cells.length === 0) return;
    const group = L.featureGroup();
    cells.forEach(c => {
        try {
            const bounds = [[c.minlat, c.minlng], [c.maxlat, c.maxlng]];
            const rect = L.rectangle(bounds, {
                color: c.color || '#FF0000',
                weight: 0,
                fillOpacity: c.opacity || 0.5,
                fillColor: c.color || '#FF0000'
            });
            group.addLayer(rect);
        } catch (e) {
            // ignore
        }
    });
    heatmapLayer = group;
    heatmapLayer.addTo(map);
}

/**
 * 클러스터 렌더링 (배치)
 */
function renderClusters(data) {
    clearMarkers();
    
    if (data.length === 0) return;
    
    // 줌 레벨에 따른 클러스터 크기 조정
    const zoom = map.getZoom();
    const clusterRadius = Math.max(15, 80 - zoom * 3);
    
    // 데이터를 클러스터로 그룹화
    const clusters = clusterData(data, clusterRadius);
    
    // 배치 렌더링 시 렌더링 카운터 유지
    let renderCount = 0;
    const batchSize = 30; // 배치 크기 축소
    
    const renderBatch = () => {
        for (let i = 0; i < batchSize && renderCount < clusters.length; i++, renderCount++) {
            try {
                renderCluster(clusters[renderCount], renderCount);
            } catch (e) {
                console.error('cluster render error', e);
            }
        }
        if (renderCount < clusters.length) {
            requestAnimationFrame(renderBatch);
        }
    };
    
    // 첫 배치는 동기로 실행해서 UI 즉시 표시
    for (let i = 0; i < Math.min(batchSize, clusters.length); i++, renderCount++) {
        try {
            renderCluster(clusters[renderCount], renderCount);
        } catch (e) {
            console.error('cluster render error', e);
        }
    }
    
    if (renderCount < clusters.length) {
        requestAnimationFrame(renderBatch);
    }
}

/**
 * 그리드 기반 클러스터링 (효율적)
 */
function clusterData(data, radiusPixels) {
    if (data.length === 0) return [];
    
    const clusters = [];
    const cellSize = radiusPixels / Math.pow(2, map.getZoom()) * 80; // 셀 크기 (미터 단위)
    const grid = {};
    
    // 그리드에 포인트 배치
    data.forEach((point) => {
        const cellX = Math.floor(point.lng / cellSize);
        const cellY = Math.floor(point.lat / cellSize);
        const key = `${cellX},${cellY}`;
        
        if (!grid[key]) {
            grid[key] = [];
        }
        grid[key].push(point);
    });
    
    // 각 셀의 포인트들을 클러스터로 변환
    Object.values(grid).forEach((cluster) => {
        clusters.push(cluster);
    });
    
    return clusters;
}

/**
 * 두 좌표 사이의 거리 계산 (간단한 근사)
 */
function getDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 지구 반지름 (km)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // km
}

function normalizeAngle(angle) {
    let normalized = (angle + 540) % 360 - 180;
    return normalized;
}

function getBearing(lat1, lng1, lat2, lng2) {
    const y = Math.sin((lng2 - lng1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lng2 - lng1) * Math.PI / 180);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

function formatDistance(meters) {
    if (meters >= 1000) {
        return `${(meters / 1000).toFixed(1)}km`;
    }
    return `${Math.round(meters)}m`;
}

function buildRouteSteps(segments) {
    if (!segments || segments.length < 2) return [];

    const steps = [];
    let prev = segments[0];
    let currentBearing = getBearing(prev.lat, prev.lng, segments[1].lat, segments[1].lng);
    let currentAction = '출발';
    let currentCategory = prev.category;
    let currentDistance = 0;

    for (let i = 1; i < segments.length; i++) {
        const cur = segments[i];
        const segmentDistance = getDistance(prev.lat, prev.lng, cur.lat, cur.lng) * 1000;
        const bearing = getBearing(prev.lat, prev.lng, cur.lat, cur.lng);
        const angleDiff = normalizeAngle(bearing - currentBearing);
        const turnAction = Math.abs(angleDiff) < 35 ? '직진' : angleDiff > 0 ? '우회전' : '좌회전';
        const categoryChanged = cur.category !== currentCategory;

        if (Math.abs(angleDiff) > 45 || categoryChanged) {
            steps.push({
                action: currentAction,
                distance: currentDistance,
                category: currentCategory,
                icon: currentAction === '출발' ? '▶' : currentAction === '직진' ? '⬆' : currentAction === '우회전' ? '➡' : currentAction === '좌회전' ? '⬅' : '•'
            });
            currentAction = turnAction;
            currentDistance = segmentDistance;
            currentCategory = cur.category;
            currentBearing = bearing;
        } else {
            currentDistance += segmentDistance;
        }
        prev = cur;
    }

    steps.push({
        action: '도착',
        distance: currentDistance,
        category: currentCategory,
        icon: '🏁'
    });

    return steps.filter(step => step.distance > 2 || step.action === '도착');
}

function getCategoryLabel(category) {
    if (category === 'green') return '안전한 구간';
    if (category === 'orange') return '주의가 필요한 구간';
    return '조심해야 할 구간';
}

function showRouteSummary(route, segments) {
    const summary = document.getElementById('routeSummary');
    const distanceEl = document.getElementById('routeDistance');
    const safetyEl = document.getElementById('routeSafety');
    const timeEl = document.getElementById('routeTime');
    const hintEl = document.getElementById('routeHint');
    const stepsEl = document.getElementById('routeSteps');

    if (!summary || !distanceEl || !safetyEl || !timeEl || !hintEl || !stepsEl) return;

    const durationMinutes = Math.max(1, Math.round(route.distance / 83));
    distanceEl.textContent = formatDistance(route.distance);
    safetyEl.textContent = `평균 안전도 ${Number(route.avg_density).toFixed(2)}`;
    timeEl.textContent = `예상 소요 ${durationMinutes}분 · ${segments.length}개 구간`;

    const steps = buildRouteSteps(segments);
    hintEl.textContent = steps.length > 0 ? `${steps[0].action} ${formatDistance(steps[0].distance)} 후 이동하세요.` : '경로 안내를 준비 중입니다.';

    stepsEl.innerHTML = steps.map((step, index) => {
        return `
            <li class="route-step">
                <div class="route-step-icon">${step.icon}</div>
                <div class="route-step-body">
                    <div class="route-step-title">${index + 1}. ${step.action} ${formatDistance(step.distance)}</div>
                    <div class="route-step-desc">${getCategoryLabel(step.category)}</div>
                    ${step.action !== '도착' ? `<div class="route-step-note">이 구간은 ${formatDistance(step.distance)} 이동합니다.</div>` : '<div class="route-step-note">목적지에 도착했습니다.</div>'}
                </div>
            </li>`;
    }).join('');

    summary.classList.remove('hidden');
}

function hideRouteSummary() {
    const summary = document.getElementById('routeSummary');
    if (summary) {
        summary.classList.add('hidden');
    }
}

/**
 * 클러스터 렌더링
 */
function renderCluster(cluster, index) {
    // 클러스터의 중심 좌표 계산
    const centerLat = cluster.reduce((sum, p) => sum + p.lat, 0) / cluster.length;
    const centerLng = cluster.reduce((sum, p) => sum + p.lng, 0) / cluster.length;
    
    // 안전 수준 계산
    const safetyScore = calculateSafetyScore(cluster);
    const color = getSafetyColor(safetyScore);
    const safetyClass = getSafetyClass(safetyScore);
    
    // 마커 엘리먼트 생성
    const markerElement = L.DomUtil.create('div', `custom-marker ${safetyClass}`);
    markerElement.style.backgroundColor = color;
    markerElement.style.borderColor = color;
    
    // 마커 텍스트
    if (cluster.length === 1) {
        markerElement.innerHTML = getTypeEmoji(cluster[0].type);
    } else {
        markerElement.innerHTML = cluster.length;
        markerElement.style.fontSize = '14px';
    }
    
    const customIcon = L.divIcon({
        html: markerElement.outerHTML,
        iconSize: [40, 40],
        className: 'custom-marker-icon'
    });
    
    // 마커 생성
    const marker = L.marker([centerLat, centerLng], { icon: customIcon })
        .addTo(markerGroup);
    
    // 팝업 추가
    marker.bindPopup(createPopupContent(cluster), {
        maxWidth: 250,
        minWidth: 200
    });
    
    // 클릭 이벤트
    marker.on('click', function() {
        marker.openPopup();
    });
}

/**
 * 안전 수준 계산
 */
function calculateSafetyScore(cluster) {
    // 타입별 가중치
    const weights = {
        emergency_bell: 3,
        safe_place: 2,
        restroom: 1,
        cctv: 2
    };
    
    let totalScore = 0;
    cluster.forEach(point => {
        totalScore += weights[point.type] || 1;
    });
    
    return totalScore / cluster.length;
}

/**
 * 안전 수준에 따른 색상 반환
 */
function getSafetyColor(score) {
    if (score >= 2.5) {
        return '#4CAF50'; // 초록색 (안전)
    } else if (score >= 1.5) {
        return '#FFC107'; // 노란색 (주의)
    } else {
        return '#F44336'; // 빨간색 (위험)
    }
}

/**
 * 안전 수준 클래스 반환
 */
function getSafetyClass(score) {
    if (score >= 2.5) {
        return 'marker-safe';
    } else if (score >= 1.5) {
        return 'marker-warning';
    } else {
        return 'marker-danger';
    }
}

/**
 * 타입 이모지 반환
 */
function getTypeEmoji(type) {
    const emojis = {
        emergency_bell: '🚨',
        safe_place: '🏪',
        restroom: '🚻',
        cctv: '📹'
    };
    return emojis[type] || '📍';
}

/**
 * 팝업 콘텐츠 생성
 */
function createPopupContent(cluster) {
    let html = '<div style="font-family: Segoe UI, sans-serif;">';

    if (cluster.length > 1) {
        html += `<div style="margin-bottom: 10px; font-weight: 700; color: #333;">총 ${cluster.length}개 시설</div>`;
        // 타입별 통계
        const typeCount = {};
        cluster.forEach(point => {
            typeCount[point.type] = (typeCount[point.type] || 0) + 1;
        });
        Object.entries(typeCount).forEach(([type, count]) => {
            html += `<div style="margin: 5px 0; color: #666; font-size: 12px;"><strong>${typeNames[type] || type}</strong>: ${count}개</div>`;
        });
    } else if (cluster.length === 1) {
        const point = cluster[0];
        html += `<div style="font-weight: 700; color: #333; margin-bottom: 8px; font-size: 14px;">${point.name || '시설'}</div>`;
        html += `<div style="display: inline-block; background: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: #666; margin-bottom: 8px;">${typeNames[point.type] || point.type}</div>`;
        
        if (point.address) {
            html += `<div style="color: #666; font-size: 12px; margin-top: 8px;">📍 ${point.address}</div>`;
        }
        
        // 필터된 속성만 표시
        if (point.properties && Object.keys(point.properties).length > 0) {
            html += '<hr style="margin:8px 0; border:none; border-top:1px solid #eee;"/>';
            const filtered = filterPropertyKeys(point.properties);
            Object.entries(filtered).slice(0, 15).forEach(([key, value]) => {
                if (value && String(value).trim()) {
                    html += `<div style="font-size:11px;color:#555;margin:4px 0; word-break: break-word;"><strong>${key}:</strong> ${String(value).substring(0, 100)}</div>`;
                }
            });
        }
    }

    html += '</div>';
    return html;
}

/**
 * 속성 키 필터링 (한글 속성명만 추출)
 */
function filterPropertyKeys(props) {
    const result = {};
    const koreanRegex = /[\uac00-\ud7af]/g; // 한글 문자 범위
    
    Object.entries(props).forEach(([key, value]) => {
        // 키에 한글이 포함되거나 알려진 영문 키인 경우만 포함
        if (koreanRegex.test(key) || ['name', 'address', 'ADDR', 'adres'].includes(key)) {
            result[key] = value;
        }
    });
    
    return result;
}

async function getRecaptchaToken() {
    return new Promise((resolve, reject) => {
        grecaptcha.ready(() => {
            grecaptcha.execute(
                "",
                { action: "submit" }
            ).then(resolve).catch(reject);
        });
    });
}

/**
 * 사용자 위치 요청
 */
function requestUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                console.log('✅ 사용자 위치 획득:', userLocation);
                displayUserLocation();
                
                // 현재 위치로 지도 이동
                map.setView([userLocation.lat, userLocation.lng], MIN_ZOOM + 2);
            },
            (error) => {
                console.warn('위치 정보 오류:', error.message);
                document.getElementById('status').textContent = '📍 위치 미수집';
            },
            {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 0
            }
        );
        
        // 연속적으로 위치 추적
        navigator.geolocation.watchPosition(
            (position) => {
                if (userLocation) {
                    userLocation.lat = position.coords.latitude;
                    userLocation.lng = position.coords.longitude;
                    updateUserLocationMarker();
                }
            },
            null,
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 10000 }
        );
    } else {
        console.warn('지오로케이션이 지원되지 않습니다');
        document.getElementById('status').textContent = '📍 위치 미지원';
    }
}

/** 주소 -> 좌표 (서버 호출) */
async function geocodeAddress(addr) {
    try {
        const params = new URLSearchParams({ address: addr });
        const res = await fetch(`/api/geocode?${params.toString()}`);
        if (!res.ok) throw new Error('geocode failed');
        return await res.json();
    } catch (e) {
        console.warn('geocode error', e);
        return null;
    }
}

/** 경로 관련 유틸 */
function clearRoute() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    hideRouteSummary();
}

function clearStartEnd() {
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
}

function setMarker(type, lat, lng) {
    const icon = L.divIcon({ className: 'custom-marker-icon', html: `<div style="width:18px;height:18px;border-radius:50%;background:#2196F3;border:3px solid white;"></div>` });
    if (type === 'start') {
        if (startMarker) map.removeLayer(startMarker);
        startMarker = L.marker([lat, lng], { icon: icon }).addTo(map).bindPopup('출발지').openPopup();
    } else {
        if (endMarker) map.removeLayer(endMarker);
        endMarker = L.marker([lat, lng], { icon: icon }).addTo(map).bindPopup('도착지').openPopup();
    }
}

async function computeSafeRoute() {
    const si = document.getElementById('startInput').value.trim();
    const ei = document.getElementById('endInput').value.trim();
    if (!si || !ei) { alert('출발지와 도착지를 입력하세요'); return; }

    setUILocked(true);
    showTopLoading(true, '경로 계산 중...', 0);
    clearRoute();

    try {
        const token = await getRecaptchaToken();

        const params = new URLSearchParams({
            start: si,
            end: ei,
            zoom: map.getZoom(),
            recaptcha_token: token
        });

        const res = await fetch(`/api/safe_route?${params.toString()}`);

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'route fetch failed');
        }

        const data = await res.json();

        if (!data.route || !data.segments) {
            throw new Error('Invalid response format');
        }
        const route = data.route;
        const segments = data.segments;
        renderRouteSegments(segments);
        const info = `거리: ${Math.round(route.distance)} m, 평균 안전도: ${Number(route.avg_density).toFixed(2)}`;
        document.getElementById('routeInfo').textContent = info;
        showRouteSummary(route, segments);
        if (window.matchMedia('(max-width: 768px)').matches) {
            collapseMobileRouteSheet();
        }
        showTopLoading(true, '경로 표시완료', 100);
    } catch (e) {
        console.warn('computeSafeRoute error', e);
        alert('경로를 계산하지 못했습니다: ' + e.message);
    } finally {
        setUILocked(false);
        setTimeout(() => showTopLoading(false), 800);
    }
}

function renderRouteSegments(segments, fallbackCoords) {
    if ((!segments || segments.length === 0) && (!fallbackCoords || fallbackCoords.length === 0)) return;
    clearRoute();

    const layer = L.featureGroup();

    if (!segments || segments.length === 0) {
        const fallback = (fallbackCoords || []).map(coord => [coord[0], coord[1]]);
        if (fallback.length > 0) {
            L.polyline(fallback, { color: '#2563eb', weight: 5, opacity: 0.9 }).addTo(layer);
        }
    } else {
        // 그룹화: 연속된 동일 카테고리로 묶어 폴리라인 생성
        const groups = [];
        let cur = { cat: segments[0].category, pts: [[segments[0].lat, segments[0].lng]] };
        for (let i = 1; i < segments.length; i++) {
            const s = segments[i];
            if (s.category === cur.cat) {
                cur.pts.push([s.lat, s.lng]);
            } else {
                groups.push(cur);
                cur = { cat: s.category, pts: [[s.lat, s.lng]] };
            }
        }
        groups.push(cur);

        groups.forEach(g => {
            let color = '#F44336';
            if (g.cat === 'green') color = '#2E7D32';
            if (g.cat === 'orange') color = '#FFB300';
            L.polyline(g.pts, { color: color, weight: 6, opacity: 0.9 }).addTo(layer);
        });
    }

    if (startMarker) {
        layer.addLayer(startMarker);
    }
    if (endMarker) {
        layer.addLayer(endMarker);
    }

    routeLayer = layer;
    routeLayer.addTo(map);
    try { map.fitBounds(routeLayer.getBounds(), { padding: [40,40] }); } catch(e) {}
}

/**
 * 사용자 위치 표시
 */
function displayUserLocation() {
    if (!userLocation || !map) return;
    
    // 기존 마커 제거
    if (userMarker) {
        map.removeLayer(userMarker);
    }
    
    // 커스텀 아이콘 생성
    const userIcon = L.divIcon({
        html: '<div style="width: 32px; height: 32px; background: #2196F3; border: 4px solid white; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px rgba(33, 150, 243, 0.5); font-size: 16px; line-height: 1;">   </div>',
        iconSize: [32, 32],
        className: 'user-location-marker'
    });
    
    userMarker = L.marker([userLocation.lat, userLocation.lng], { icon: userIcon })
        .addTo(map);
    
    userMarker.bindPopup('내 위치', { autoClose: false });
}

/**
 * 사용자 위치 마커 업데이트
 */
function updateUserLocationMarker() {
    if (userMarker && userLocation) {
        userMarker.setLatLng([userLocation.lat, userLocation.lng]);
    } else if (userLocation) {
        displayUserLocation();
    }
}

/**
 * 마커 초기화
 */
function clearMarkers() {
    markerGroup.clearLayers();
}

/**
 * 로딩 표시
 */
function showLoading(show) {
    const loading = document.getElementById('loading');
    if (show) {
        loading.classList.add('active');
    } else {
        loading.classList.remove('active');
    }
}

/**
 * 맵 이동 완료 이벤트
 */
function onMapMoveEnd() {
    // debounce
    setTimeout(() => {
        updateVisibleMarkers();
    }, 250);
}

/**
 * 초기화
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('SafePath 지도 애플리케이션 시작');
    
    // 전역 바텀시트 함수 초기화
    initGlobalRouteSheet();
    
    // 내 위치 버튼
    document.getElementById('locateBtn').addEventListener('click', () => {
        if (userLocation && map) {
            map.setView([userLocation.lat, userLocation.lng], MIN_ZOOM + 2);
        } else {
            alert('위치 정보를 획득할 수 없습니다.');
        }
    });

    // 경로 UI 버튼 이벤트 연결
    const startMy = document.getElementById('startMyLoc');
    const endMy = document.getElementById('endMyLoc');
    const pickStart = document.getElementById('pickStartBtn');
    const pickEnd = document.getElementById('pickEndBtn');
    const findBtn = document.getElementById('findRouteBtn');

    if (startMy) startMy.addEventListener('click', () => {
        if (userLocation) {
            document.getElementById('startInput').value = `${userLocation.lat},${userLocation.lng}`;
            setMarker('start', userLocation.lat, userLocation.lng);
        } else alert('내 위치를 사용할 수 없습니다.');
    });
    if (endMy) endMy.addEventListener('click', () => {
        if (userLocation) {
            document.getElementById('endInput').value = `${userLocation.lat},${userLocation.lng}`;
            setMarker('end', userLocation.lat, userLocation.lng);
        } else alert('내 위치를 사용할 수 없습니다.');
    });

    if (pickStart) pickStart.addEventListener('click', () => {
        pickMode = 'start';
        pickStart.classList.add('active');
        if (pickEnd) pickEnd.classList.remove('active');
        alert('지도를 클릭하여 출발지를 선택하세요.');
    });
    if (pickEnd) pickEnd.addEventListener('click', () => {
        pickMode = 'end';
        pickEnd.classList.add('active');
        if (pickStart) pickStart.classList.remove('active');
        alert('지도를 클릭하여 도착지를 선택하세요.');
    });

    if (findBtn) findBtn.addEventListener('click', () => {
        computeSafeRoute();
    });

    const clearBtn = document.getElementById('clearRouteBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearRoute();
            clearStartEnd();
            const info = document.getElementById('routeInfo');
            if (info) info.textContent = '경로가 초기화되었습니다.';
        });
    }

    const routeSheetInner = document.getElementById('routeSheetInner');
    const routeSheetBody = document.getElementById('routeSheetBody');
    const routeHandle = document.getElementById('routeHandle');
    const routeHeader = routeSheetInner ? routeSheetInner.querySelector('.route-header') : null;

    function initMobileRouteSheet() {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (!isMobile || !routeSheetInner || !routeSheetBody || !routeHandle) return;
        
        setRouteSheetState('mid');

        let dragging = false;
        let startY = 0;
        let startHeight = 0;

        const getHeightLimits = () => {
            const max = Math.max(320, window.innerHeight * 0.78);
            const mid = Math.max(280, window.innerHeight * 0.42);
            const min = 96;
            return { min, mid, max };
        };

        const updateHeight = (clientY) => {
            if (!dragging) return;
            const limits = getHeightLimits();
            const delta = startY - clientY;
            const nextHeight = Math.max(limits.min, Math.min(limits.max, startHeight + delta));
            routeSheetInner.style.maxHeight = `${nextHeight}px`;
        };

        const finishDrag = (clientY) => {
            if (!dragging) return;
            dragging = false;
            routeHandle.style.cursor = 'grab';
            routeSheetInner.classList.remove('dragging');
            const limits = getHeightLimits();
            const delta = startY - clientY;
            const finalHeight = Math.max(limits.min, Math.min(limits.max, startHeight + delta));

            if (finalHeight <= limits.min + 40) {
                collapseMobileRouteSheet();
            } else if (finalHeight <= limits.mid + 40) {
                setRouteSheetState('mid');
            } else {
                openMobileRouteSheet();
            }
        };

        const startDrag = (clientY) => {
            dragging = true;
            startY = clientY;
            startHeight = routeSheetInner.getBoundingClientRect().height;
            routeHandle.style.cursor = 'grabbing';
            routeSheetInner.classList.add('dragging');
        };

        const bindDragEvents = (element) => {
            if (!element) return;
            element.addEventListener('touchstart', (ev) => {
                if (!ev.touches[0] || ev.target.closest('button')) return;
                startDrag(ev.touches[0].clientY);
            });
            element.addEventListener('touchmove', (ev) => {
                if (!ev.touches[0] || !dragging) return;
                updateHeight(ev.touches[0].clientY);
            });
            element.addEventListener('touchend', (ev) => {
                if (!dragging) return;
                const clientY = ev.changedTouches[0] ? ev.changedTouches[0].clientY : startY;
                finishDrag(clientY);
            });
        };

        bindDragEvents(routeHandle);
        bindDragEvents(routeHeader);
        
        // collapsed 상태에서 body도 드래그 가능
        const originalFinishDrag = finishDrag;
        const wrappedFinishDrag = (clientY) => {
            originalFinishDrag(clientY);
            if (routeSheetInner.classList.contains('collapsed')) {
                bindDragEvents(routeSheetBody);
            }
        };
        
        routeSheetBody.addEventListener('touchstart', (ev) => {
            if (!ev.touches[0] || ev.target.closest('button')) return;
            if (!routeSheetInner.classList.contains('collapsed')) return;
            startDrag(ev.touches[0].clientY);
        });
        routeSheetBody.addEventListener('touchmove', (ev) => {
            if (!ev.touches[0] || !dragging) return;
            if (!routeSheetInner.classList.contains('collapsed')) return;
            updateHeight(ev.touches[0].clientY);
        });
        routeSheetBody.addEventListener('touchend', (ev) => {
            if (!dragging) return;
            if (!routeSheetInner.classList.contains('collapsed')) return;
            const clientY = ev.changedTouches[0]?.clientY || startY;
            wrappedFinishDrag(clientY);
        });
    }

    const closeRoutePanel = document.getElementById('closeRoutePanel');
    if (closeRoutePanel) {
        closeRoutePanel.addEventListener('click', () => {
            clearRoute();
            hideRouteSummary();
            const info = document.getElementById('routeInfo');
            if (info) info.textContent = '경로 탐색을 취소했습니다.';
            if (window.matchMedia('(max-width: 768px)').matches) {
                collapseMobileRouteSheet();
            }
        });
    }

    initMobileRouteSheet();

    // 입력창에서 Enter로 경로 검색
    const sIn = document.getElementById('startInput');
    const eIn = document.getElementById('endInput');
    [sIn, eIn].forEach(inp => {
        if (!inp) return;
        inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') computeSafeRoute();
        });
    });
    
    // Dataset 토글 버튼
    document.getElementById('toggleDataset').addEventListener('click', () => {
        const controls = document.getElementById('datasetControls');
        controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
    });
    
    // Dataset 체크박스 이벤트
    const datasets = ['emergency_bell', 'safe_place', 'restroom', 'cctv', 'seculight'];
    datasets.forEach(ds => {
        const checkbox = document.getElementById(`toggle-${ds}`);
        checkbox.addEventListener('change', () => {
            activeDatasets[ds] = checkbox.checked;
            updateVisibleMarkers();
        });
    });
    
    initMap();
});

// 주기적으로 데이터 갱신
setInterval(() => {
    if (map) {
        updateVisibleMarkers();
    }
}, 10000);
