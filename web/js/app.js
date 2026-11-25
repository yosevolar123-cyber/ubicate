'use strict';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const IP_PROVIDERS = [
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
    parse(data) {
      return {
        lat: Number(data.latitude),
        lng: Number(data.longitude),
        city: data.city,
        region: data.region,
        country: data.country,
      };
    },
  },
  {
    url: 'https://freeipapi.com/api/json',
    parse(data) {
      return {
        lat: Number(data.latitude),
        lng: Number(data.longitude),
        city: data.cityName,
        region: data.regionName,
        country: data.countryName,
      };
    },
  },
];
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLY_DURATION = REDUCE_MOTION ? 0 : 1.3;

const state = {
  map: null,
  userMarker: null,
  accuracyCircle: null,
  searchMarker: null,
  watchId: null,
  lastPosition: null,
  lastGeocode: null,
  reverseController: null,
  locatedOnce: false,
  approximating: false,
};

let userIcon = null;
let approxIcon = null;
let searchIcon = null;
let searchController = null;
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);

const els = {
  status: $('#status'),
  statusText: $('#status-text'),
  map: $('#map'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  searchClear: $('#search-clear'),
  searchResults: $('#search-results'),
  locateBtn: $('#locate-btn'),
  sheet: $('#sheet'),
  place: $('#place'),
  coords: $('#coords'),
  lat: $('#lat'),
  lng: $('#lng'),
  accuracy: $('#accuracy'),
  btnCenter: $('#btn-center'),
  btnTrack: $('#btn-track'),
  btnShare: $('#btn-share'),
  btnCopy: $('#btn-copy'),
  toast: $('#toast'),
};

function init() {
  bindUI();
  observeSheet();
  registerServiceWorker();

  if (!initMap()) {
    return;
  }

  if (!window.isSecureContext) {
    toast('En el móvil la geolocalización precisa requiere HTTPS. Mostraremos una aproximación por IP.', 5600);
  }

  locate();
}

function initMap() {
  if (typeof L === 'undefined') {
    setStatus('error', 'Sin mapa');
    toast('No se pudo cargar el mapa. Revisa tu conexión a internet.', 6000);
    return false;
  }

  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 19,
  }).setView([22, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(state.map);

  L.control.zoom({ position: 'topright' }).addTo(state.map);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(state.map);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 110 }).addTo(state.map);

  state.map.on('click', hideResults);

  userIcon = L.divIcon({
    className: 'user-marker',
    html: '<span class="user-marker__pulse"></span><span class="user-marker__dot"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  approxIcon = L.divIcon({
    className: 'user-marker user-marker--approx',
    html: '<span class="user-marker__pulse"></span><span class="user-marker__dot"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  searchIcon = L.divIcon({
    className: 'search-marker',
    html: '<span></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  return true;
}

function bindUI() {
  els.locateBtn.addEventListener('click', () => locate({ userInitiated: true }));
  els.btnCenter.addEventListener('click', centerOnUser);
  els.btnTrack.addEventListener('click', toggleWatch);
  els.btnShare.addEventListener('click', shareLocation);
  els.btnCopy.addEventListener('click', copyCoordinates);

  els.searchForm.addEventListener('submit', handleSearch);
  els.searchInput.addEventListener('input', () => {
    els.searchClear.hidden = els.searchInput.value.length === 0;
  });
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideResults();
      els.searchInput.blur();
    }
  });
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    els.searchClear.hidden = true;
    hideResults();
    els.searchInput.focus();
  });

  els.searchInput.setAttribute('aria-controls', 'search-results');
  els.searchInput.setAttribute('aria-expanded', 'false');

  document.addEventListener('click', (event) => {
    if (!els.searchForm.contains(event.target)) {
      hideResults();
    }
  });
}

function setStatus(kind, text) {
  els.status.dataset.state = kind;
  els.statusText.textContent = text;
}

function toast(message, timeout = 3400) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove('is-visible');
  }, timeout);
}

function observeSheet() {
  const update = () => {
    const height = Math.ceil(els.sheet.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--sheet-h', `${height}px`);
  };

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(update);
    observer.observe(els.sheet);
  } else {
    window.addEventListener('resize', update);
  }

  update();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

function locate(options = {}) {
  const userInitiated = options.userInitiated === true;

  if (!('geolocation' in navigator)) {
    setStatus('error', 'No compatible');
    toast('Tu navegador no soporta geolocalización. Buscaremos una aproximación por IP.', 4400);
    approximateByIP();
    return;
  }

  setStatus('loading', 'Buscando…');
  els.locateBtn.classList.add('is-loading');

  const finish = () => els.locateBtn.classList.remove('is-loading');

  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        finish();
        handleFix(position, { userInitiated });
      },
      (error) => {
        finish();
        handleGeoError(error);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  } catch (error) {
    finish();
    handleGeoError(error);
  }
}

function handleFix(position, options = {}) {
  if (!position || !position.coords) {
    return;
  }

  const lat = Number(position.coords.latitude);
  const lng = Number(position.coords.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return;
  }

  const rawAccuracy = Number(position.coords.accuracy);
  const accuracy = Number.isFinite(rawAccuracy) ? rawAccuracy : null;
  const first = !state.locatedOnce;
  const wasApproximate = Boolean(state.lastPosition && state.lastPosition.approximate);

  state.lastPosition = { lat, lng, accuracy, approximate: false };
  upsertUserMarker(lat, lng, accuracy, false);
  updateReadout(lat, lng, accuracy, false);
  enableActions();
  maybeReverseGeocode(lat, lng, first || options.userInitiated === true);

  setStatus('ok', state.watchId !== null ? 'En vivo' : 'Ubicado');

  if (state.map && (first || options.userInitiated === true || wasApproximate)) {
    state.map.flyTo([lat, lng], zoomForAccuracy(accuracy), { duration: first ? FLY_DURATION + 0.3 : FLY_DURATION });
  }

  state.locatedOnce = true;
}

function handleGeoError(error) {
  if (state.watchId !== null) {
    stopWatch();
  }

  const message = geolocationErrorMessage(error);
  const denied = Boolean(error && error.code === 1);

  setStatus('error', denied ? 'Sin permiso' : 'Sin señal');

  if (state.lastPosition) {
    toast(`${message}. Mantenemos la última posición conocida.`, 4200);
    return;
  }

  toast(`${message}. Buscaremos una aproximación por IP.`, 4600);
  approximateByIP();
}

function geolocationErrorMessage(error) {
  const code = error && typeof error.code === 'number' ? error.code : 0;
  switch (code) {
    case 1:
      return 'Permiso de ubicación denegado';
    case 2:
      return 'Ubicación no disponible';
    case 3:
      return 'Se agotó el tiempo de espera';
    default:
      return 'No se pudo obtener tu ubicación';
  }
}

async function approximateByIP() {
  if (state.approximating || (state.lastPosition && !state.lastPosition.approximate)) {
    return;
  }

  state.approximating = true;
  setStatus('loading', 'Aproximando…');

  if (state.reverseController) {
    state.reverseController.abort();
    state.reverseController = null;
  }

  try {
    let location = null;

    for (const provider of IP_PROVIDERS) {
      try {
        const response = await fetch(provider.url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) {
          continue;
        }

        const info = provider.parse(await response.json());
        if (!Number.isFinite(info.lat) || !Number.isFinite(info.lng)) {
          continue;
        }

        location = info;
        break;
      } catch (error) {
        continue;
      }
    }

    if (!location) {
      throw new Error('Sin proveedores disponibles');
    }

    const { lat, lng } = location;

    state.lastPosition = { lat, lng, accuracy: null, approximate: true };
    upsertUserMarker(lat, lng, null, true);
    updateReadout(lat, lng, null, true);
    enableActions();

    const place = [location.city, location.region, location.country].filter(Boolean).join(', ');
    els.place.textContent = place ? `${place} (aprox.)` : 'Ubicación aproximada por IP';
    setStatus('warning', 'Aproximada');

    if (state.map) {
      state.map.flyTo([lat, lng], 11, { duration: FLY_DURATION });
    }

    state.locatedOnce = true;
    toast('Usamos una aproximación por IP. Concede el permiso de ubicación para mayor precisión.', 5000);
  } catch (error) {
    setStatus('error', 'Sin ubicación');
    els.place.textContent = 'No pudimos obtener tu ubicación';
    toast('Revisa el permiso de ubicación o tu conexión e inténtalo de nuevo.', 4400);
  } finally {
    state.approximating = false;
  }
}

function upsertUserMarker(lat, lng, accuracy, approximate) {
  if (!state.map || typeof L === 'undefined') {
    return;
  }

  const icon = approximate ? approxIcon : userIcon;
  const latlng = [lat, lng];

  if (!state.userMarker) {
    state.userMarker = L.marker(latlng, {
      icon,
      keyboard: false,
      zIndexOffset: 1000,
      title: 'Tu ubicación',
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latlng).setIcon(icon);
  }

  const radius = approximate ? 12000 : Math.max(Number.isFinite(accuracy) ? accuracy : 25, 12);
  const style = {
    color: approximate ? '#fbbf24' : '#2dd4bf',
    fillColor: approximate ? '#fbbf24' : '#2dd4bf',
    dashArray: approximate ? '6 8' : null,
  };

  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latlng, {
      radius,
      weight: 1,
      opacity: 0.75,
      fillOpacity: 0.1,
      interactive: false,
      ...style,
    }).addTo(state.map);
  } else {
    state.accuracyCircle.setLatLng(latlng).setRadius(radius).setStyle(style);
  }
}

function updateReadout(lat, lng, accuracy, approximate) {
  const latText = lat.toFixed(6);
  const lngText = lng.toFixed(6);

  els.lat.textContent = latText;
  els.lng.textContent = lngText;
  els.coords.textContent = `${latText}, ${lngText}`;
  els.accuracy.textContent = approximate ? '≈ ciudad' : formatAccuracy(accuracy);
}

function formatAccuracy(meters) {
  if (!Number.isFinite(meters)) {
    return '—';
  }
  if (meters < 1000) {
    return `±${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return `±${km.toFixed(km < 10 ? 1 : 0)} km`;
}

function zoomForAccuracy(accuracy) {
  if (!Number.isFinite(accuracy)) {
    return 15;
  }
  if (accuracy <= 15) {
    return 17;
  }
  if (accuracy <= 45) {
    return 16;
  }
  if (accuracy <= 120) {
    return 15;
  }
  if (accuracy <= 600) {
    return 14;
  }
  if (accuracy <= 2500) {
    return 12;
  }
  return 10;
}

function enableActions() {
  els.btnCenter.disabled = false;
  els.btnShare.disabled = false;
  els.btnCopy.disabled = false;
}

function centerOnUser() {
  if (!state.lastPosition) {
    locate({ userInitiated: true });
    return;
  }

  if (!state.map) {
    return;
  }

  const { lat, lng, accuracy, approximate } = state.lastPosition;
  const zoom = approximate ? 11 : zoomForAccuracy(accuracy);
  state.map.flyTo([lat, lng], zoom, { duration: FLY_DURATION });
}

function toggleWatch() {
  if (state.watchId !== null) {
    stopWatch();
    toast('Seguimiento en vivo desactivado.');
    return;
  }

  if (!('geolocation' in navigator)) {
    toast('Tu navegador no soporta geolocalización.');
    return;
  }

  setStatus('loading', 'En vivo');

  state.watchId = navigator.geolocation.watchPosition(
    (position) => handleFix(position),
    (error) => handleGeoError(error),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 }
  );

  els.btnTrack.classList.add('is-active');
  els.btnTrack.setAttribute('aria-pressed', 'true');
  toast('Seguimiento en vivo activado. Tu posición se actualizará automáticamente.');
}

function stopWatch() {
  if (state.watchId === null) {
    return;
  }

  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  els.btnTrack.classList.remove('is-active');
  els.btnTrack.setAttribute('aria-pressed', 'false');
}

function maybeReverseGeocode(lat, lng, force) {
  const now = Date.now();
  const previous = state.lastGeocode;

  if (
    !force &&
    previous &&
    now - previous.time < 4000 &&
    Math.abs(previous.lat - lat) < 0.0015 &&
    Math.abs(previous.lng - lng) < 0.0015
  ) {
    return;
  }

  state.lastGeocode = { lat, lng, time: now };

  if (force) {
    els.place.textContent = 'Buscando dirección…';
  }

  reverseGeocode(lat, lng);
}

async function reverseGeocode(lat, lng) {
  if (state.reverseController) {
    state.reverseController.abort();
  }

  const controller = new AbortController();
  state.reverseController = controller;

  try {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: lat.toFixed(6),
      lon: lng.toFixed(6),
      zoom: '14',
      addressdetails: '1',
      'accept-language': 'es',
    });

    const response = await fetch(`${NOMINATIM}/reverse?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    els.place.textContent = formatAddress(data) || 'Ubicación sin dirección';
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return;
    }
    els.place.textContent = 'Ubicación encontrada';
  } finally {
    if (state.reverseController === controller) {
      state.reverseController = null;
    }
  }
}

function formatAddress(data) {
  if (!data || typeof data !== 'object') {
    return '';
  }

  const address = data.address || {};
  const locality = address.city || address.town || address.village || address.municipality || address.county;
  const region = address.state && address.state !== locality ? address.state : '';
  const country = address.country || '';

  const parts = [locality, region, country].filter(Boolean);
  return parts.length ? parts.join(', ') : data.display_name || '';
}

async function handleSearch(event) {
  event.preventDefault();

  const query = els.searchInput.value.trim();
  if (query.length < 2) {
    toast('Escribe al menos 2 caracteres para buscar un lugar.');
    els.searchInput.focus();
    return;
  }

  showSearchHint('Buscando lugares…');

  if (searchController) {
    searchController.abort();
  }
  const controller = new AbortController();
  searchController = controller;

  try {
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      limit: '6',
      addressdetails: '0',
      'accept-language': 'es',
    });

    const response = await fetch(`${NOMINATIM}/search?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const results = await response.json();
    renderResults(Array.isArray(results) ? results : []);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return;
    }
    showSearchHint('No se pudo buscar. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    if (searchController === controller) {
      searchController = null;
    }
  }
}

function showSearchHint(message) {
  els.searchResults.replaceChildren();
  const item = document.createElement('li');
  item.className = 'search__hint';
  item.textContent = message;
  els.searchResults.append(item);
  showResults();
}

function renderResults(results) {
  els.searchResults.replaceChildren();

  if (results.length === 0) {
    showSearchHint('Sin resultados. Prueba con otro nombre.');
    return;
  }

  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search__result';
    button.setAttribute('role', 'option');

    const title = document.createElement('span');
    title.className = 'search__result-title';
    title.textContent = result.name || (result.display_name || '').split(',')[0] || 'Lugar';

    const subtitle = document.createElement('span');
    subtitle.className = 'search__result-subtitle';
    subtitle.textContent = result.display_name || '';

    button.append(title, subtitle);
    button.addEventListener('click', () => selectPlace(result));
    item.append(button);
    els.searchResults.append(item);
  }

  showResults();
}

function showResults() {
  els.searchResults.hidden = false;
  els.searchInput.setAttribute('aria-expanded', 'true');
}

function hideResults() {
  els.searchResults.hidden = true;
  els.searchInput.setAttribute('aria-expanded', 'false');
}

function selectPlace(result) {
  const lat = Number(result.lat);
  const lng = Number(result.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return;
  }

  hideResults();
  els.searchInput.value = result.name || result.display_name || '';
  els.searchClear.hidden = false;
  els.searchInput.blur();

  if (!state.map || typeof L === 'undefined') {
    return;
  }

  if (state.searchMarker) {
    state.searchMarker.remove();
  }

  state.searchMarker = L.marker([lat, lng], { icon: searchIcon, keyboard: false })
    .addTo(state.map)
    .bindPopup(escapeHtml(result.display_name || result.name || 'Lugar'));

  state.searchMarker.openPopup();

  const bbox = (result.boundingbox || []).map(Number);
  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    state.map.flyToBounds(
      [
        [bbox[0], bbox[2]],
        [bbox[1], bbox[3]],
      ],
      { padding: [32, 32], maxZoom: 14, duration: FLY_DURATION }
    );
  } else {
    state.map.flyTo([lat, lng], 12, { duration: FLY_DURATION });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function shareLocation() {
  const position = state.lastPosition;
  if (!position) {
    toast('Primero ubícate en el mapa.');
    return;
  }

  const lat = position.lat.toFixed(6);
  const lng = position.lng.toFixed(6);
  const url = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  const text = `Estoy aquí: ${lat}, ${lng}`;

  if (navigator.share) {
    navigator
      .share({ title: 'Mi ubicación · ubícate', text, url })
      .catch((error) => {
        if (error && error.name !== 'AbortError') {
          copyText(`${text}\n${url}`);
        }
      });
    return;
  }

  copyText(`${text}\n${url}`);
}

function copyCoordinates() {
  if (!state.lastPosition) {
    toast('Primero ubícate en el mapa.');
    return;
  }

  const lat = state.lastPosition.lat.toFixed(6);
  const lng = state.lastPosition.lng.toFixed(6);
  copyText(`${lat}, ${lng}`);
}

async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      toast('Copiado al portapapeles.');
      return;
    }
    throw new Error('clipboard no disponible');
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (copyError) {
      copied = false;
    }

    area.remove();
    toast(copied ? 'Copiado al portapapeles.' : 'No se pudo copiar. Selecciona las coordenadas manualmente.');
  }
}

init();
