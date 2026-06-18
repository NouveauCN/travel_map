import './styles.css';

type MetadataRecord = Record<string, string | number | boolean | null>;

type MediaItem = {
  id: string;
  title: string;
  place: string;
  media_type: 'image' | 'video';
  full_src: string;
  thumbnail_src: string;
  latitude: number | null;
  longitude: number | null;
  map_latitude: number | null;
  map_longitude: number | null;
  date_time_original: string | null;
  offset_time_original: string | null;
  width: number | null;
  height: number | null;
  brief_metadata: MetadataRecord;
  full_metadata: MetadataRecord;
};

type MediaManifest = {
  generated_at: string;
  source_directory: string;
  media: MediaItem[];
};

type LocationGroup = {
  id: string;
  title: string;
  place: string;
  latitude: number;
  longitude: number;
  map_latitude: number;
  map_longitude: number;
  media_items: MediaItem[];
};

type AppState = {
  manifest: MediaManifest | null;
  location_groups: LocationGroup[];
  selected_location_id: string | null;
  selected_media_index: number;
  is_full_metadata_visible: boolean;
  is_map_ready: boolean;
  map_error_message: string | null;
};

type AMapWindow = Window &
  typeof globalThis & {
    AMap?: any;
    _AMapSecurityConfig?: {
      securityJsCode: string;
    };
  };

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY ?? '';
const AMAP_SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE ?? '';
const AMAP_API_VERSION = '1.4.15';
const MANIFEST_URL = '/data/media_manifest.json';
const CLOSE_ZOOM = 5;
const NEARBY_DISTANCE_KM = 180;
const CAROUSEL_INTERVAL_MS = 4500;
const DEFAULT_CENTER: [number, number] = [104.1954, 35.8617];
const DEFAULT_ZOOM = 4;
const EARTH_RADIUS_KM = 6371;

const app_state: AppState = {
  manifest: null,
  location_groups: [],
  selected_location_id: null,
  selected_media_index: 0,
  is_full_metadata_visible: false,
  is_map_ready: false,
  map_error_message: null,
};

const app_root = require_element<HTMLDivElement>('#app');
let map_instance: any = null;
let marker_by_location_id = new Map<string, any>();
let location_polyline: any = null;
let carousel_timer_id: number | null = null;

app_root.innerHTML = `
  <main class="app_shell">
    <section class="map_region" aria-label="旅行照片地图">
      <div id="map_surface" class="map_surface"></div>
      <div id="map_visual_overlay" class="map_visual_overlay" aria-hidden="false">
        <svg id="route_overlay" class="route_overlay" aria-hidden="true"></svg>
        <div id="place_overlay" class="place_overlay"></div>
      </div>
      <div id="map_error" class="map_error" hidden></div>
      <div id="map_hint" class="map_hint" hidden></div>
      <div class="map_toolbar">
        <button id="fit_button" class="toolbar_button" type="button">适配全部</button>
        <span id="toolbar_status" class="toolbar_status">正在加载媒体</span>
      </div>
    </section>
    <aside class="side_panel" aria-label="照片信息">
      <header class="panel_header">
        <h1>旅行照片世界地图</h1>
        <p id="panel_summary">读取照片元数据并按位置浏览。</p>
      </header>
      <div id="panel_body" class="panel_body"></div>
    </aside>
  </main>
`;

const map_surface = require_element<HTMLDivElement>('#map_surface');
const route_overlay = require_element<SVGSVGElement>('#route_overlay');
const place_overlay = require_element<HTMLDivElement>('#place_overlay');
const map_error = require_element<HTMLDivElement>('#map_error');
const map_hint = require_element<HTMLDivElement>('#map_hint');
const panel_body = require_element<HTMLDivElement>('#panel_body');
const panel_summary = require_element<HTMLParagraphElement>('#panel_summary');
const toolbar_status = require_element<HTMLSpanElement>('#toolbar_status');
const fit_button = require_element<HTMLButtonElement>('#fit_button');

fit_button.addEventListener('click', () => {
  fit_all_locations();
});

void initialize_app();

async function initialize_app() {
  try {
    const manifest = await fetch_manifest();
    app_state.manifest = manifest;
    app_state.location_groups = build_location_groups(manifest.media);
    app_state.selected_location_id = app_state.location_groups[0]?.id ?? null;
    render_app();
    start_carousel();

  if (!AMAP_KEY) {
    show_map_error('未配置高德 Web JS Key。复制 `.env.example` 为 `.env`，填入 `VITE_AMAP_KEY` 后重新运行。');
    return;
  }

  if (!AMAP_SECURITY_CODE) {
    show_map_hint('高德 JS API 通常还需要安全密钥。若底图空白，请在 `.env` 中添加 `VITE_AMAP_SECURITY_CODE` 后重新构建。');
  }

  await load_amap_script(AMAP_KEY);
    initialize_map();
  } catch (error) {
    const error_message = error instanceof Error ? error.message : String(error);
    app_state.map_error_message = error_message;
    render_app();
    show_map_error(error_message);
  }
}

async function fetch_manifest(): Promise<MediaManifest> {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`无法读取媒体清单：${response.status} ${response.statusText}`);
  }
  return (await response.json()) as MediaManifest;
}

function build_location_groups(media_items: MediaItem[]): LocationGroup[] {
  const group_by_key = new Map<string, LocationGroup>();

  for (const media_item of media_items) {
    if (
      media_item.latitude === null ||
      media_item.longitude === null ||
      media_item.map_latitude === null ||
      media_item.map_longitude === null
    ) {
      continue;
    }

    const group_key = `${media_item.map_latitude.toFixed(5)},${media_item.map_longitude.toFixed(5)}`;
    const existing_group = group_by_key.get(group_key);
    if (existing_group) {
      existing_group.media_items.push(media_item);
      continue;
    }

    group_by_key.set(group_key, {
      id: group_key,
      title: media_item.title,
      place: media_item.place,
      latitude: media_item.latitude,
      longitude: media_item.longitude,
      map_latitude: media_item.map_latitude,
      map_longitude: media_item.map_longitude,
      media_items: [media_item],
    });
  }

  return [...group_by_key.values()].sort((left_group, right_group) => {
    const left_date = left_group.media_items[0]?.date_time_original ?? '';
    const right_date = right_group.media_items[0]?.date_time_original ?? '';
    return right_date.localeCompare(left_date);
  });
}

function render_app() {
  render_summary();
  render_panel();
  render_toolbar();
  update_marker_styles();
}

function render_summary() {
  const media_count = app_state.manifest?.media.length ?? 0;
  const location_count = app_state.location_groups.length;
  panel_summary.textContent = `${media_count} 个媒体文件，${location_count} 个可定位地点。滚轮缩放地图，靠近标记后查看轮播。`;
}

function render_toolbar() {
  if (app_state.map_error_message) {
    toolbar_status.textContent = '地图未就绪';
    return;
  }

  if (!AMAP_KEY) {
    toolbar_status.textContent = '等待高德 Key';
    return;
  }

  toolbar_status.textContent = app_state.is_map_ready ? '滚轮缩放可用' : '正在加载地图';
}

function render_panel() {
  const selected_group = get_selected_group();
  if (!selected_group) {
    panel_body.innerHTML = `
      <div class="empty_state">还没有可定位媒体。请先运行媒体构建脚本，或为无 GPS 的媒体补充坐标。</div>
    `;
    return;
  }

  const media_item = selected_group.media_items[app_state.selected_media_index] ?? selected_group.media_items[0];
  const metadata = app_state.is_full_metadata_visible ? media_item.full_metadata : media_item.brief_metadata;

  panel_body.innerHTML = `
    <div class="media_viewer">
      <div class="media_frame">
        ${render_media_element(media_item)}
      </div>
      <div class="carousel_controls">
        <button id="previous_button" class="icon_button" type="button" aria-label="上一张">‹</button>
        <span class="media_counter">${app_state.selected_media_index + 1} / ${selected_group.media_items.length}</span>
        <button id="next_button" class="icon_button" type="button" aria-label="下一张">›</button>
      </div>
      <section class="metadata_section">
        <h2 class="metadata_title">${escape_html(media_item.title)}</h2>
        <dl class="metadata_grid">
          ${Object.entries(metadata)
            .map(([metadata_key, metadata_value]) => {
              return `<dt>${escape_html(format_metadata_key(metadata_key))}</dt><dd>${escape_html(format_metadata_value(metadata_value))}</dd>`;
            })
            .join('')}
        </dl>
        <div class="toggle_row">
          <span class="toggle_label">完整元数据</span>
          <label class="switch" aria-label="切换完整元数据">
            <input id="metadata_toggle" type="checkbox" ${app_state.is_full_metadata_visible ? 'checked' : ''} />
            <span class="switch_track"></span>
          </label>
        </div>
      </section>
      <section class="location_list" aria-label="地点列表">
        ${app_state.location_groups.map(render_location_card).join('')}
      </section>
    </div>
  `;

  document.querySelector<HTMLButtonElement>('#previous_button')?.addEventListener('click', () => {
    select_media_index(app_state.selected_media_index - 1);
  });

  document.querySelector<HTMLButtonElement>('#next_button')?.addEventListener('click', () => {
    select_media_index(app_state.selected_media_index + 1);
  });

  document.querySelector<HTMLInputElement>('#metadata_toggle')?.addEventListener('change', (event) => {
    app_state.is_full_metadata_visible = (event.currentTarget as HTMLInputElement).checked;
    render_panel();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-location-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const location_id = button.dataset.locationId;
      if (location_id) {
        select_location(location_id, true);
      }
    });
  });
}

function render_media_element(media_item: MediaItem): string {
  if (media_item.media_type === 'video') {
    return `<video controls preload="metadata" poster="${escape_attribute(media_item.thumbnail_src)}" src="${escape_attribute(media_item.full_src)}"></video>`;
  }

  return `<img loading="lazy" decoding="async" src="${escape_attribute(media_item.full_src)}" alt="${escape_attribute(media_item.title)}" />`;
}

function render_location_card(location_group: LocationGroup): string {
  const first_media_item = location_group.media_items[0];
  const is_active = location_group.id === app_state.selected_location_id;
  return `
    <button class="location_card" type="button" data-location-id="${escape_attribute(location_group.id)}" aria-pressed="${is_active}">
      <img loading="lazy" decoding="async" src="${escape_attribute(first_media_item.thumbnail_src)}" alt="" />
      <span>
        <strong>${escape_html(location_group.title)}</strong>
        <span>${escape_html(location_group.place)} · ${location_group.media_items.length} 个媒体</span>
      </span>
    </button>
  `;
}

function initialize_map() {
  const amap_window = window as AMapWindow;
  if (!amap_window.AMap) {
    show_map_error('高德地图脚本加载失败。');
    return;
  }

  const base_tile_layer = new amap_window.AMap.TileLayer({
    zIndex: 1,
    zooms: [2, 18],
  });

  map_instance = new amap_window.AMap.Map(map_surface, {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zooms: [2, 18],
    layers: [base_tile_layer],
    features: ['bg', 'road', 'building', 'point'],
    mapStyle: 'amap://styles/normal',
    scrollWheel: true,
    resizeEnable: true,
  });

  app_state.is_map_ready = true;
  render_toolbar();
  create_markers();
  create_location_polyline();
  render_visual_overlay();

  map_instance.on('complete', () => {
    fit_all_locations();
    window.setTimeout(update_visual_overlay, 120);
  });

  map_instance.on('zoomend', () => {
    update_visual_overlay();
    select_nearby_location_if_close();
  });
  map_instance.on('moveend', () => {
    update_visual_overlay();
    select_nearby_location_if_close();
  });
  map_instance.on('resize', update_visual_overlay);
}

function create_markers() {
  const amap_window = window as AMapWindow;
  marker_by_location_id = new Map<string, any>();

  for (const location_group of app_state.location_groups) {
    const marker_element = document.createElement('div');
    marker_element.className = 'amap_marker';
    marker_element.innerHTML = `<span>${location_group.media_items.length}</span><strong>${escape_html(location_group.place)}</strong>`;

    const marker = new amap_window.AMap.Marker({
      position: [location_group.map_longitude, location_group.map_latitude],
      content: marker_element,
      offset: new amap_window.AMap.Pixel(-38, -17),
      title: location_group.title,
    });

    marker.on('click', () => {
      select_location(location_group.id, false);
    });

    marker.setMap(map_instance);
    marker_by_location_id.set(location_group.id, marker);
  }

  update_marker_styles();
}

function create_location_polyline() {
  if (!map_instance || app_state.location_groups.length < 2) {
    return;
  }

  const amap_window = window as AMapWindow;
  const sorted_groups = [...app_state.location_groups].sort((left_group, right_group) => {
    const left_date = left_group.media_items[0]?.date_time_original ?? '';
    const right_date = right_group.media_items[0]?.date_time_original ?? '';
    return left_date.localeCompare(right_date);
  });
  const path = sorted_groups.map((location_group) => [location_group.map_longitude, location_group.map_latitude]);

  location_polyline = new amap_window.AMap.Polyline({
    path,
    strokeColor: '#2f746f',
    strokeOpacity: 0.85,
    strokeWeight: 4,
    strokeStyle: 'solid',
    lineJoin: 'round',
    zIndex: 20,
  });
  map_instance.add(location_polyline);
}

function fit_all_locations() {
  if (!map_instance || app_state.location_groups.length === 0) {
    return;
  }

  const overlays = [...marker_by_location_id.values()];
  if (location_polyline) {
    overlays.push(location_polyline);
  }
  map_instance.setFitView(overlays, false, get_map_padding(), 8);
  window.setTimeout(update_visual_overlay, 120);
}

function get_map_padding(): [number, number, number, number] {
  if (window.matchMedia('(max-width: 900px)').matches) {
    return [90, 48, 90, 48];
  }
  return [90, 420, 90, 90];
}

function select_nearby_location_if_close() {
  if (!map_instance || Number(map_instance.getZoom()) < CLOSE_ZOOM) {
    return;
  }

  const center = map_instance.getCenter();
  const center_latitude = Number(center.lat);
  const center_longitude = Number(center.lng);
  let nearest_group: LocationGroup | null = null;
  let nearest_distance = Number.POSITIVE_INFINITY;

  for (const location_group of app_state.location_groups) {
    const distance = get_distance_km(
      center_latitude,
      center_longitude,
      location_group.map_latitude,
      location_group.map_longitude,
    );
    if (distance < nearest_distance) {
      nearest_distance = distance;
      nearest_group = location_group;
    }
  }

  if (nearest_group && nearest_distance <= NEARBY_DISTANCE_KM) {
    select_location(nearest_group.id, false);
  }
}

function select_location(location_id: string, should_pan_map: boolean) {
  if (app_state.selected_location_id === location_id) {
    return;
  }

  app_state.selected_location_id = location_id;
  app_state.selected_media_index = 0;
  render_app();
  start_carousel();

  if (should_pan_map && map_instance) {
    const selected_group = get_selected_group();
    if (selected_group) {
      map_instance.setZoomAndCenter(Math.max(Number(map_instance.getZoom()), CLOSE_ZOOM), [
        selected_group.map_longitude,
        selected_group.map_latitude,
      ]);
      window.setTimeout(update_visual_overlay, 120);
    }
  }
}

function select_media_index(media_index: number) {
  const selected_group = get_selected_group();
  if (!selected_group) {
    return;
  }

  const item_count = selected_group.media_items.length;
  app_state.selected_media_index = (media_index + item_count) % item_count;
  render_panel();
  start_carousel();
}

function start_carousel() {
  if (carousel_timer_id !== null) {
    window.clearInterval(carousel_timer_id);
    carousel_timer_id = null;
  }

  const selected_group = get_selected_group();
  if (!selected_group || selected_group.media_items.length < 2) {
    return;
  }

  carousel_timer_id = window.setInterval(() => {
    select_media_index(app_state.selected_media_index + 1);
  }, CAROUSEL_INTERVAL_MS);
}

function get_selected_group(): LocationGroup | null {
  return app_state.location_groups.find((location_group) => location_group.id === app_state.selected_location_id) ?? null;
}

function update_marker_styles() {
  for (const [location_id, marker] of marker_by_location_id.entries()) {
    const marker_element = marker.getContent() as HTMLElement;
    marker_element.classList.toggle('is_active', location_id === app_state.selected_location_id);
  }

  place_overlay.querySelectorAll<HTMLElement>('[data-overlay-location-id]').forEach((element) => {
    element.classList.toggle('is_active', element.dataset.overlayLocationId === app_state.selected_location_id);
  });
}

function render_visual_overlay() {
  place_overlay.innerHTML = app_state.location_groups
    .map((location_group) => {
      return `
        <button
          class="visual_marker"
          type="button"
          data-overlay-location-id="${escape_attribute(location_group.id)}"
          aria-label="${escape_attribute(location_group.title)}"
        >
          <span>${location_group.media_items.length}</span>
          <strong>${escape_html(location_group.place)}</strong>
        </button>
      `;
    })
    .join('');

  place_overlay.querySelectorAll<HTMLButtonElement>('[data-overlay-location-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const location_id = button.dataset.overlayLocationId;
      if (location_id) {
        select_location(location_id, true);
      }
    });
  });

  update_visual_overlay();
  update_marker_styles();
}

function update_visual_overlay() {
  const overlay_rect = place_overlay.getBoundingClientRect();
  route_overlay.setAttribute('viewBox', `0 0 ${overlay_rect.width} ${overlay_rect.height}`);
  route_overlay.setAttribute('width', String(overlay_rect.width));
  route_overlay.setAttribute('height', String(overlay_rect.height));

  const sorted_groups = [...app_state.location_groups].sort((left_group, right_group) => {
    const left_date = left_group.media_items[0]?.date_time_original ?? '';
    const right_date = right_group.media_items[0]?.date_time_original ?? '';
    return left_date.localeCompare(right_date);
  });

  const points = sorted_groups.map(get_location_screen_point);
  const route_path = points
    .map((point, index) => {
      return `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(' ');

  route_overlay.innerHTML = route_path
    ? `<path d="${route_path}" fill="none" stroke="#2f746f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"></path>`
    : '';

  place_overlay.querySelectorAll<HTMLElement>('[data-overlay-location-id]').forEach((element) => {
    const location_group = app_state.location_groups.find((group) => group.id === element.dataset.overlayLocationId);
    if (!location_group) {
      return;
    }
    const point = get_location_screen_point(location_group);
    element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
  });
}

function get_location_screen_point(location_group: LocationGroup): { x: number; y: number } {
  if (map_instance?.lngLatToContainer) {
    const pixel = map_instance.lngLatToContainer([location_group.map_longitude, location_group.map_latitude]);
    const x = Number(pixel?.x);
    const y = Number(pixel?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  const overlay_rect = place_overlay.getBoundingClientRect();
  const x = ((location_group.longitude + 180) / 360) * overlay_rect.width;
  const y = ((90 - location_group.latitude) / 180) * overlay_rect.height;
  return { x, y };
}

function show_map_error(message: string) {
  app_state.map_error_message = message;
  map_error.hidden = false;
  map_error.innerHTML = `
    <div class="map_error_panel">
      <h1>地图暂未加载</h1>
      <p>${escape_html(message)}</p>
      <code>VITE_AMAP_KEY=你的高德 Web JS Key</code>
    </div>
  `;
  render_toolbar();
}

function show_map_hint(message: string) {
  map_hint.hidden = false;
  map_hint.textContent = message;
}

function load_amap_script(amap_key: string): Promise<void> {
  const amap_window = window as AMapWindow;
  if (amap_window.AMap) {
    return Promise.resolve();
  }

  if (AMAP_SECURITY_CODE) {
    amap_window._AMapSecurityConfig = {
      securityJsCode: AMAP_SECURITY_CODE,
    };
  }

  return new Promise((resolve, reject) => {
    const script_element = document.createElement('script');
    const script_url = new URL('https://webapi.amap.com/maps');
    script_url.searchParams.set('v', AMAP_API_VERSION);
    script_url.searchParams.set('key', amap_key);

    script_element.src = script_url.toString();
    script_element.async = true;
    script_element.onload = () => resolve();
    script_element.onerror = () => reject(new Error('无法加载高德地图 JS API。'));
    document.head.appendChild(script_element);
  });
}

function require_element<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function get_distance_km(
  from_latitude: number,
  from_longitude: number,
  to_latitude: number,
  to_longitude: number,
) {
  const latitude_delta = to_radians(to_latitude - from_latitude);
  const longitude_delta = to_radians(to_longitude - from_longitude);
  const from_latitude_radians = to_radians(from_latitude);
  const to_latitude_radians = to_radians(to_latitude);
  const half_chord =
    Math.sin(latitude_delta / 2) ** 2 +
    Math.cos(from_latitude_radians) * Math.cos(to_latitude_radians) * Math.sin(longitude_delta / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(half_chord), Math.sqrt(1 - half_chord));
}

function to_radians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function format_metadata_key(metadata_key: string) {
  const key_labels: Record<string, string> = {
    file: '文件',
    place: '地点',
    captured_at: '拍摄时间',
    coordinates: '坐标',
    map_coordinates: '地图坐标',
    dimensions: '尺寸',
    media_type: '类型',
    source_file: '源文件',
    offset_time_original: '时区',
  };
  return key_labels[metadata_key] ?? metadata_key;
}

function format_metadata_value(metadata_value: string | number | boolean | null) {
  if (metadata_value === null) {
    return '无';
  }
  return String(metadata_value);
}

function escape_html(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escape_map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return escape_map[character];
  });
}

function escape_attribute(value: string) {
  return escape_html(value);
}
