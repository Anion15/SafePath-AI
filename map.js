mapboxgl.accessToken = '';

// 전역 변수
let map = null;
let userLocation = null;
let userMarker = null;
let allData = [];
let loadedMarkers = new Map();
let clusterMarkers = new Map();
let currentBounds = null;

// 상수
const MIN_ZOOM = 13;
const MAX_CLUSTER_RADIUS = 500; // 미터
const LOAD_THRESHOLD = 50; // 줌 레벨 13 이상에서만 로드

// 타입별 색상 매핑
const typeColors = {
    emergency_bell: '#FF5722',
    safe_place: '#4CAF50',
    restroom: '#2196F3',
    cctv: '#9C27B0'
};

// 타입별 이름 매핑
const typeNames = {
    emergency_bell: '🚨 비상벨',
    safe_place: '🏪 안심지킴이집',
    restroom: '🚻 공중화장실',
    cctv: '📹 CCTV'
};

/**
 * 맵 초기화
 */
function initMap() {
    map = new mapboxgl.Map({
        container: 'map',
        style: 'https://tiles.openstreetmap.de/styles/osm-bright/style.json',
        center: [127.0, 37.5], // 서울 중심
        zoom: MIN_ZOOM,
        minZoom: MIN_ZOOM,
        maxZoom: 18
    });
    
    // 줌 레벨 표시 업데이트
    map.on('zoom', updateZoomLevel);
    map.on('move', updateMapBounds);
    map.on('moveend', onMapMoveEnd);
    
    // 지도 로드 완료
    map.on('load', () => {
        console.log('지도 로드 완료');
        loadAllData();
        requestUserLocation();
    });
    
    // 에러 처리
    map.on('error', (e) => {
        console.error('지도 에러:', e);
    });
}

/**
 * 줌 레벨 표시 업데이트
 */
function updateZoomLevel() {
    const zoom = Math.round(map.getZoom() * 10) / 10;
    document.getElementById('zoomLevel').textContent = zoom;
}

/**
 * 맵 범위 업데이트
 */
function updateMapBounds() {
    const bounds = map.getBounds();
    currentBounds = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
    };
    updateVisibleMarkers();
}

/**
 * 모든 데이터 로드
 */
async function loadAllData() {
    try {
        showLoading(true);
        const response = await fetch('data.json');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        allData = await response.json();
        console.log(`✅ ${allData.length}개의 데이터 로드 완료`);
        
        document.getElementById('totalData').textContent = allData.length.toLocaleString();
        document.getElementById('status').textContent = '✅ 로드 완료';
        
        updateVisibleMarkers();
    } catch (error) {
        console.error('데이터 로드 오류:', error);
        document.getElementById('status').textContent = '❌ 로드 실패';
    } finally {
        showLoading(false);
    }
}

/**
 * 화면에 표시될 마커 업데이트
 */
function updateVisibleMarkers() {
    if (!currentBounds || allData.length === 0 || map.getZoom() < LOAD_THRESHOLD) {
        clearMarkers();
        return;
    }
    
    // 현재 화면에 보이는 데이터 필터링
    const visibleData = allData.filter(point => {
        return point.lat <= currentBounds.north &&
               point.lat >= currentBounds.south &&
               point.lng <= currentBounds.east &&
               point.lng >= currentBounds.west;
    });
    
    console.log(`화면에 표시: ${visibleData.length}개`);
    document.getElementById('visibleData').textContent = visibleData.length.toLocaleString();
    
    // 클러스터링
    renderClusters(visibleData);
}

/**
 * 클러스터링 및 렌더링
 */
function renderClusters(data) {
    clearMarkers();
    
    if (data.length === 0) return;
    
    // 줌 레벨에 따른 클러스터 크기 조정
    const zoom = map.getZoom();
    let clusterRadius = Math.max(30, 100 - zoom * 3); // 줌이 높을수록 더 작은 클러스터
    
    // 데이터를 클러스터로 그룹화
    const clusters = clusterData(data, clusterRadius);
    
    // 클러스터별 마커 생성
    clusters.forEach((cluster, index) => {
        renderCluster(cluster, index);
    });
}

/**
 * 데이터 클러스터링 (간단한 그리드 기반)
 */
function clusterData(data, radius) {
    if (data.length === 0) return [];
    
    // 화면 픽셀 기준으로 클러스터링
    const pixelRadius = Math.max(30, 60 - map.getZoom() * 2);
    const clusters = [];
    const processed = new Set();
    
    data.forEach((point, index) => {
        if (processed.has(index)) return;
        
        const cluster = [point];
        processed.add(index);
        
        // 근처 포인트 찾기
        data.forEach((otherPoint, otherIndex) => {
            if (index === otherIndex || processed.has(otherIndex)) return;
            
            const distance = getDistance(point.lat, point.lng, otherPoint.lat, otherPoint.lng);
            
            // 거리 기반 클러스터링 (대략 50-100미터)
            if (distance < 0.0005) {
                cluster.push(otherPoint);
                processed.add(otherIndex);
            }
        });
        
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

/**
 * 클러스터 렌더링
 */
function renderCluster(cluster, index) {
    // 클러스터의 중심 좌표 계산
    const centerLat = cluster.reduce((sum, p) => sum + p.lat, 0) / cluster.length;
    const centerLng = cluster.reduce((sum, p) => sum + p.lng, 0) / cluster.length;
    
    // 안전 수준 계산 (타입별 가중치)
    const safetyScore = calculateSafetyScore(cluster);
    const color = getSafetyColor(safetyScore);
    
    // 마커 엘리먼트 생성
    const markerElement = document.createElement('div');
    markerElement.style.width = '40px';
    markerElement.style.height = '40px';
    markerElement.style.backgroundColor = color;
    markerElement.style.borderRadius = '50%';
    markerElement.style.display = 'flex';
    markerElement.style.alignItems = 'center';
    markerElement.style.justifyContent = 'center';
    markerElement.style.color = 'white';
    markerElement.style.fontSize = '18px';
    markerElement.style.fontWeight = 'bold';
    markerElement.style.cursor = 'pointer';
    markerElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
    markerElement.style.border = '3px solid white';
    markerElement.style.transition = 'transform 0.2s ease';
    
    // 마커 텍스트 (클러스터 크기)
    if (cluster.length === 1) {
        markerElement.innerHTML = getTypeEmoji(cluster[0].type);
    } else {
        markerElement.innerHTML = cluster.length;
        markerElement.style.fontSize = '14px';
    }
    
    // 마커 호버 효과
    markerElement.style.lineHeight = '1';
    
    // 마커 생성
    const marker = new mapboxgl.Marker(markerElement)
        .setLngLat([centerLng, centerLat])
        .setPopup(createPopup(cluster))
        .addTo(map);
    
    // 마커 클릭 이벤트
    markerElement.addEventListener('click', () => {
        marker.togglePopup();
    });
    
    // 마커 호버 효과
    markerElement.addEventListener('mouseenter', () => {
        markerElement.style.transform = 'scale(1.1)';
    });
    
    markerElement.addEventListener('mouseleave', () => {
        markerElement.style.transform = 'scale(1)';
    });
    
    clusterMarkers.set(index, marker);
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
    // 점수가 높을수록 안전함
    if (score >= 2.5) {
        return '#4CAF50'; // 초록색 (안전)
    } else if (score >= 1.5) {
        return '#FFC107'; // 노란색 (주의)
    } else {
        return '#F44336'; // 빨간색 (위험)
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
 * 팝업 생성
 */
function createPopup(cluster) {
    let html = '<div>';
    
    // 클러스터 크기 표시
    if (cluster.length > 1) {
        html += `<div style="margin-bottom: 10px; font-weight: 700; color: #333;">총 ${cluster.length}개 시설</div>`;
        
        // 타입별 통계
        const typeCount = {};
        cluster.forEach(point => {
            typeCount[point.type] = (typeCount[point.type] || 0) + 1;
        });
        
        Object.entries(typeCount).forEach(([type, count]) => {
            html += `<div style="margin: 5px 0; color: #666;"><small>${typeNames[type]}: ${count}개</small></div>`;
        });
    } else if (cluster.length === 1) {
        const point = cluster[0];
        html += `<div class="popup-title">${point.name}</div>`;
        html += `<div class="popup-type">${typeNames[point.type]}</div>`;
        if (point.address) {
            html += `<div class="popup-address">📍 ${point.address}</div>`;
        }
    }
    
    html += '</div>';
    
    return new mapboxgl.Popup({
        offset: 25,
        closeButton: true,
        closeOnClick: true
    }).setHTML(html);
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
                map.flyTo({
                    center: [userLocation.lng, userLocation.lat],
                    zoom: MIN_ZOOM + 2,
                    duration: 1500
                });
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
        
        // 연속적으로 위치 추적 (선택사항)
        navigator.geolocation.watchPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                updateUserLocationMarker();
            },
            null,
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 10000 }
        );
    } else {
        console.warn('지오로케이션이 지원되지 않습니다');
        document.getElementById('status').textContent = '📍 위치 미지원';
    }
}

/**
 * 사용자 위치 표시
 */
function displayUserLocation() {
    if (!userLocation) return;
    
    // 기존 마커 제거
    if (userMarker) {
        userMarker.remove();
    }
    
    // 새 마커 생성
    const markerElement = document.createElement('div');
    markerElement.style.width = '32px';
    markerElement.style.height = '32px';
    markerElement.style.backgroundColor = '#2196F3';
    markerElement.style.borderRadius = '50%';
    markerElement.style.border = '4px solid white';
    markerElement.style.boxShadow = '0 0 20px rgba(33, 150, 243, 0.5)';
    markerElement.style.display = 'flex';
    markerElement.style.alignItems = 'center';
    markerElement.style.justifyContent = 'center';
    markerElement.style.fontSize = '16px';
    markerElement.innerHTML = '   ';
    
    userMarker = new mapboxgl.Marker(markerElement)
        .setLngLat([userLocation.lng, userLocation.lat])
        .addTo(map);
}

/**
 * 사용자 위치 마커 업데이트
 */
function updateUserLocationMarker() {
    if (userMarker) {
        userMarker.setLngLat([userLocation.lng, userLocation.lat]);
    } else {
        displayUserLocation();
    }
}

/**
 * 마커 초기화
 */
function clearMarkers() {
    clusterMarkers.forEach(marker => marker.remove());
    clusterMarkers.clear();
}

/**
 * 맵 이동 완료 이벤트
 */
function onMapMoveEnd() {
    updateVisibleMarkers();
}

/**
 * 내 위치로 이동
 */
document.getElementById('locateBtn').addEventListener('click', () => {
    if (userLocation) {
        map.flyTo({
            center: [userLocation.lng, userLocation.lat],
            zoom: MIN_ZOOM + 2,
            duration: 1000
        });
    } else {
        alert('위치 정보를 획득할 수 없습니다.');
    }
});

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
 * 초기화
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('SafePath 지도 애플리케이션 시작');
    initMap();
});

// 주기적으로 데이터 갱신 (선택사항)
setInterval(() => {
    if (map && map.isStyleLoaded()) {
        updateVisibleMarkers();
    }
}, 5000);
